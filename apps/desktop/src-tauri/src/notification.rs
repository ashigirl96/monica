use std::path::Path;
use std::ptr::NonNull;
use std::sync::{mpsc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_foundation::{
    NSArray, NSBundle, NSDictionary, NSError, NSObject, NSObjectProtocol, NSString,
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
// completion handler が返らなくても、Backend の行を扱い続ける。
const FIRST_WITHDRAWAL_TIMEOUT: Duration = Duration::from_secs(2);

/// 通知で起こした monica では webview が listen を張る前にクリックが届くので、webview が取り出すまで持つ。
#[derive(Default)]
pub struct PendingClick(Mutex<Option<String>>);

impl PendingClick {
    fn guard(&self) -> MutexGuard<'_, Option<String>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[tauri::command]
pub fn take_notification_click(pending: State<'_, PendingClick>) -> Option<String> {
    pending.guard().take()
}

/// .app の外の process で `currentNotificationCenter` を呼ぶと catch できない例外で abort するので、dev は plugin で出す（ADR-0022）。
fn in_app_bundle() -> bool {
    static IN_APP_BUNDLE: OnceLock<bool> = OnceLock::new();
    *IN_APP_BUNDLE.get_or_init(|| is_app_bundle(&NSBundle::mainBundle().bundlePath().to_string()))
}

fn is_app_bundle(path: &str) -> bool {
    Path::new(path).extension().is_some_and(|ext| ext == "app")
}

/// 通知で起こされたときのクリックを取りこぼさないよう、起動完了より前に呼ぶ。
pub fn start(app: &AppHandle) {
    if !in_app_bundle() {
        return;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    center.setDelegate(Some(ProtocolObject::from_ref(Delegate::get_or_init(app))));
    let answered = RcBlock::new(|granted: Bool, error: *mut NSError| {
        if !granted.as_bool() && error.is_null() {
            eprintln!("[shell] notifications are not allowed in System Settings");
        }
        log_error("could not ask to post notifications", error);
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
    // 同じ Terminal Session の届いた通知を置き換え、未読でなくなったら id で取り下げられるようにする。
    let request =
        UNNotificationRequest::requestWithIdentifier_content_trigger(&value, &content, None);
    let added =
        RcBlock::new(|error: *mut NSError| log_error("failed to post a notification", error));
    UNUserNotificationCenter::currentNotificationCenter()
        .addNotificationRequest_withCompletionHandler(&request, Some(&added));
}

/// Backend ごとに作る。その Backend からの最初の集合でだけ、前の起動の通知を届いた通知から探すため（ADR-0025）。
#[derive(Default)]
pub struct UnreadNotifications {
    previous: Option<Vec<String>>,
}

#[derive(Debug, PartialEq)]
pub enum Withdrawal {
    Identifiers(Vec<String>),
    // 前の起動で出した通知と、identifier が Terminal Session の id でない古い通知は、届いた通知から探す。
    DeliveredNotIn(Vec<String>),
}

impl UnreadNotifications {
    pub fn next(&mut self, unread: &[String]) -> Withdrawal {
        match self.previous.replace(unread.to_vec()) {
            Some(previous) => Withdrawal::Identifiers(no_longer_unread(&previous, unread)),
            None => Withdrawal::DeliveredNotIn(unread.to_vec()),
        }
    }
}

impl Withdrawal {
    /// 届いた通知を読むときは取り下げを出し終えるまで返らないので、lock を握ったまま呼ばない。
    pub fn carry_out(self) {
        if !in_app_bundle() {
            return;
        }
        match self {
            Withdrawal::Identifiers(identifiers) => withdraw(&identifiers),
            Withdrawal::DeliveredNotIn(unread) => withdraw_delivered_not_in(unread),
        }
    }
}

fn no_longer_unread(previous: &[String], unread: &[String]) -> Vec<String> {
    previous
        .iter()
        .filter(|id| !unread.contains(id))
        .cloned()
        .collect()
}

struct Delivered {
    identifier: String,
    terminal_session_id: Option<String>,
}

fn delivered_not_unread(delivered: &[Delivered], unread: &[String]) -> Vec<String> {
    delivered
        .iter()
        .filter(|notification| {
            !notification
                .terminal_session_id
                .as_ref()
                .is_some_and(|id| unread.contains(id))
        })
        .map(|notification| notification.identifier.clone())
        .collect()
}

fn withdraw_delivered_not_in(unread: Vec<String>) {
    let (withdrawn, until_withdrawn) = mpsc::channel();
    // block は background thread で呼ばれうるので、呼び手の集合を借りずに自分の複製を持つ。
    let on_delivered = RcBlock::new(move |notifications: NonNull<NSArray<UNNotification>>| {
        // SAFETY: completion handler の配列は nil でない有効な NSArray。
        let notifications = unsafe { notifications.as_ref() };
        let delivered: Vec<Delivered> = notifications
            .to_vec()
            .iter()
            .map(|notification| Delivered {
                identifier: notification.request().identifier().to_string(),
                terminal_session_id: terminal_session_of(notification),
            })
            .collect();
        withdraw(&delivered_not_unread(&delivered, &unread));
        let _ = withdrawn.send(());
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .getDeliveredNotificationsWithCompletionHandler(&on_delivered);
    // 読む間に同じ Terminal Session の新しい通知を出すと、古い集合で選んだ取り下げがそれを消すので、
    // 取り下げを center に出すまで、呼び手（Backend の行を順に扱う thread）を次の行へ進ませない。
    let _ = until_withdrawn.recv_timeout(FIRST_WITHDRAWAL_TIMEOUT);
}

fn withdraw(identifiers: &[String]) {
    if identifiers.is_empty() {
        return;
    }
    let identifiers: Vec<Retained<NSString>> = identifiers
        .iter()
        .map(|id| NSString::from_str(id))
        .collect();
    UNUserNotificationCenter::currentNotificationCenter()
        .removeDeliveredNotificationsWithIdentifiers(&NSArray::from_retained_slice(&identifiers));
}

fn terminal_session_of(notification: &UNNotification) -> Option<String> {
    notification
        .request()
        .content()
        .userInfo()
        .objectForKey(&NSString::from_str(TERMINAL_SESSION_ID))
        .and_then(|value| value.downcast::<NSString>().ok())
        .map(|id| id.to_string())
}

fn log_error(what: &str, error: *mut NSError) {
    // SAFETY: completion handler の error は nil か有効な NSError。
    if let Some(error) = unsafe { error.as_ref() } {
        eprintln!("[shell] {what}: {}", error.localizedDescription());
    }
}

fn post_through_plugin(app: &AppHandle, Notification { title, body, .. }: Notification) {
    let shown = app.notification().builder().title(title).body(body).show();
    if let Err(error) = shown {
        eprintln!("[shell] failed to post a notification: {error}");
    }
}

fn clicked(app: &AppHandle, terminal_session_id: String) {
    *app.state::<PendingClick>().guard() = Some(terminal_session_id);
    if let Err(error) = app.emit("notification-clicked", ()) {
        eprintln!("[shell] failed to tell the webview about a notification click: {error}");
    }
    crate::bring_main_window_forward(app);
}

define_class!(
    #[unsafe(super(NSObject))]
    #[ivars = AppHandle]
    #[name = "MonicaNotificationDelegate"]
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
            if let Some(terminal_session_id) = terminal_session_of(&response.notification()) {
                clicked(self.ivars(), terminal_session_id);
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
        assert!(is_app_bundle("/Applications/Monica.app"));
        assert!(!is_app_bundle("/Users/me/src/monica/target/debug"));
        assert!(!is_app_bundle("/Users/me/src/monica.apps"));
    }

    fn ids(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn only_the_first_set_from_a_backend_reads_the_delivered_notifications() {
        let mut notifications = UnreadNotifications::default();

        assert_eq!(
            notifications.next(&ids(&["ts-a", "ts-b"])),
            Withdrawal::DeliveredNotIn(ids(&["ts-a", "ts-b"])),
        );
        assert_eq!(
            notifications.next(&ids(&["ts-b"])),
            Withdrawal::Identifiers(ids(&["ts-a"])),
        );
    }

    #[test]
    fn withdraws_only_the_terminal_sessions_that_left_the_unread_set() {
        assert_eq!(
            no_longer_unread(&ids(&["ts-a", "ts-b", "ts-c"]), &ids(&["ts-b", "ts-d"])),
            ids(&["ts-a", "ts-c"]),
        );
        assert_eq!(
            no_longer_unread(&ids(&["ts-a"]), &ids(&["ts-a"])),
            Vec::<String>::new()
        );
    }

    #[test]
    fn the_first_set_withdraws_delivered_notifications_whose_terminal_session_is_not_unread() {
        let delivered = [
            Delivered {
                identifier: "ts-a".into(),
                terminal_session_id: Some("ts-a".into()),
            },
            Delivered {
                identifier: "uuid-of-an-older-monica".into(),
                terminal_session_id: Some("ts-b".into()),
            },
            Delivered {
                identifier: "ts-c".into(),
                terminal_session_id: Some("ts-c".into()),
            },
            Delivered {
                identifier: "without-a-terminal-session".into(),
                terminal_session_id: None,
            },
        ];

        assert_eq!(
            delivered_not_unread(&delivered, &ids(&["ts-a", "ts-b"])),
            ids(&["ts-c", "without-a-terminal-session"]),
        );
    }
}
