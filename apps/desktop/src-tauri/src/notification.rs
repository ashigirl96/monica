use std::path::Path;
use std::sync::{Mutex, MutexGuard, OnceLock};

use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_foundation::{
    NSBundle, NSDictionary, NSError, NSObject, NSObjectProtocol, NSString, NSUUID,
};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::announcement::Notification;

const TERMINAL_SESSION_ID: &str = "terminalSessionId";

/// クリックされた通知の Terminal Session のうち、webview がまだ取り出していないもの。
/// 通知で起こした tania では、webview が listen を張る前にクリックが届く。
#[derive(Default)]
pub struct Clicks(Mutex<Option<String>>);

impl Clicks {
    fn guard(&self) -> MutexGuard<'_, Option<String>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[tauri::command]
pub fn take_notification_click(clicks: State<'_, Clicks>) -> Option<String> {
    clicks.guard().take()
}

/// .app の外の process で `currentNotificationCenter` を呼ぶと catch できない例外で abort するので、dev は plugin で出す（ADR-0022）。
fn in_app_bundle() -> bool {
    static IN_APP_BUNDLE: OnceLock<bool> = OnceLock::new();
    *IN_APP_BUNDLE.get_or_init(|| is_app_bundle(&NSBundle::mainBundle().bundlePath().to_string()))
}

fn is_app_bundle(path: &str) -> bool {
    Path::new(path).extension().is_some_and(|ext| ext == "app")
}

/// 通知で起こされたときのクリックを取りこぼさないよう、起動完了より前（`setup`）に呼ぶ。
pub fn start(app: &AppHandle) {
    if !in_app_bundle() {
        return;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    center.setDelegate(Some(ProtocolObject::from_ref(Delegate::get_or_init(app))));
    let answered = RcBlock::new(|granted: Bool, error: *mut NSError| {
        // SAFETY: completion handler の error は nil か有効な NSError。
        if let Some(error) = unsafe { error.as_ref() } {
            eprintln!(
                "[shell] could not ask to post notifications: {}",
                error.localizedDescription()
            );
        } else if !granted.as_bool() {
            eprintln!("[shell] notifications are not allowed in System Settings");
        }
    });
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert,
        &answered,
    );
}

pub fn post(app: &AppHandle, notification: Notification) {
    if in_app_bundle() {
        post_to_center(notification);
    } else {
        post_through_plugin(app, notification);
    }
}

fn post_to_center(
    Notification {
        title,
        body,
        terminal_session_id,
    }: Notification,
) {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(&title));
    content.setBody(&NSString::from_str(&body));
    let key = NSString::from_str(TERMINAL_SESSION_ID);
    let value = NSString::from_str(&terminal_session_id);
    let user_info = NSDictionary::<NSString, AnyObject>::from_slices(&[&*key], &[value.as_ref()]);
    // SAFETY: userInfo は property list の値だけを持てばよく、NSString どうしの辞書はそれを満たす。
    unsafe { content.setUserInfo(&Retained::cast_unchecked::<NSDictionary>(user_info)) };
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSUUID::UUID().UUIDString(),
        &content,
        None,
    );
    let added = RcBlock::new(|error: *mut NSError| {
        // SAFETY: completion handler の error は nil か有効な NSError。
        if let Some(error) = unsafe { error.as_ref() } {
            eprintln!(
                "[shell] failed to post a notification: {}",
                error.localizedDescription()
            );
        }
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .addNotificationRequest_withCompletionHandler(&request, Some(&added));
}

fn post_through_plugin(app: &AppHandle, Notification { title, body, .. }: Notification) {
    let shown = app.notification().builder().title(title).body(body).show();
    if let Err(error) = shown {
        eprintln!("[shell] failed to post a notification: {error}");
    }
}

fn clicked(app: &AppHandle, terminal_session_id: String) {
    *app.state::<Clicks>().guard() = Some(terminal_session_id);
    if let Err(error) = app.emit("notification-clicked", ()) {
        eprintln!("[shell] failed to tell the webview about a notification click: {error}");
    }
    crate::bring_main_window_forward(app);
}

define_class!(
    #[unsafe(super(NSObject))]
    #[ivars = AppHandle]
    #[name = "TaniaNotificationDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        // 前面の間は sidebar の未読が代わりになるので、バナーにせず通知センターにだけ入れる。
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            handler: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            handler.call((UNNotificationPresentationOptions::List,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            handler: &DynBlock<dyn Fn()>,
        ) {
            let user_info = response.notification().request().content().userInfo();
            let terminal_session_id = user_info
                .objectForKey(&NSString::from_str(TERMINAL_SESSION_ID))
                .and_then(|value| value.downcast::<NSString>().ok());
            if let Some(terminal_session_id) = terminal_session_id {
                clicked(self.ivars(), terminal_session_id.to_string());
            }
            handler.call(());
        }
    }
);

impl Delegate {
    /// center は delegate を weak で持つので、process が終わるまで static に持ち続ける。
    fn get_or_init(app: &AppHandle) -> &'static Self {
        static DELEGATE: OnceLock<Retained<Delegate>> = OnceLock::new();
        DELEGATE.get_or_init(|| {
            let this = Self::alloc().set_ivars(app.clone());
            // SAFETY: NSObject の init を呼ぶだけ。
            unsafe { msg_send![super(this), init] }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_process_inside_an_app_bundle_posts_to_the_notification_center() {
        assert!(is_app_bundle("/Applications/Tania.app"));
        assert!(!is_app_bundle("/Users/me/src/tania/target/debug"));
        assert!(!is_app_bundle("/Users/me/src/tania.apps"));
    }
}
