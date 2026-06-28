use std::sync::atomic::{AtomicU64, Ordering};

use monica_api::ApiError;
use tauri::utils::config::WindowConfig;
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

static WINDOW_SEQ: AtomicU64 = AtomicU64::new(1);

fn window_label(seq: u64) -> String {
    format!("monica-window-{seq}")
}

fn secondary_window_config(template: &WindowConfig, label: String) -> WindowConfig {
    WindowConfig {
        label,
        url: WebviewUrl::App("index.html".into()),
        // Keep secondaries closable even if the main window is later made non-closable.
        closable: true,
        ..template.clone()
    }
}

/// Must be driven from an async task rather than a synchronous menu/event handler to avoid
/// the documented window-creation deadlock on Windows.
pub(crate) async fn open_new_window(app: AppHandle) -> Result<String, ApiError> {
    let template = app
        .config()
        .app
        .windows
        .first()
        .ok_or_else(|| ApiError::external("main window config missing"))?
        .clone();
    let label = window_label(WINDOW_SEQ.fetch_add(1, Ordering::Relaxed));
    let config = secondary_window_config(&template, label.clone());
    WebviewWindowBuilder::from_config(&app, &config)
        .map_err(|e| ApiError::external(e.to_string()))?
        .build()
        .map_err(|e| ApiError::external(e.to_string()))?;
    Ok(label)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::utils::config::{LogicalPosition, WindowEffectsConfig};
    use tauri::utils::{TitleBarStyle, WindowEffect};

    fn main_like_template() -> WindowConfig {
        WindowConfig {
            label: "main".into(),
            transparent: true,
            hidden_title: true,
            drag_drop_enabled: false,
            title_bar_style: TitleBarStyle::Overlay,
            traffic_light_position: Some(LogicalPosition { x: 16.0, y: 22.0 }),
            window_effects: Some(WindowEffectsConfig {
                effects: vec![WindowEffect::Sidebar],
                state: None,
                radius: None,
                color: None,
            }),
            ..WindowConfig::default()
        }
    }

    #[test]
    fn window_label_is_sequential() {
        assert_eq!(window_label(1), "monica-window-1");
        assert_eq!(window_label(42), "monica-window-42");
    }

    #[test]
    fn secondary_window_inherits_chrome_from_main() {
        let template = main_like_template();
        let label = "monica-window-7".to_string();

        let secondary = secondary_window_config(&template, label.clone());

        // Only label / url / closable may differ; every other field — all the macOS chrome —
        // must be inherited from the template verbatim.
        assert_eq!(
            secondary,
            WindowConfig {
                label,
                url: WebviewUrl::App("index.html".into()),
                closable: true,
                ..template.clone()
            }
        );
    }
}
