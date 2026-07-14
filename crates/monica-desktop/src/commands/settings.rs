use monica_api::{ApiError, TranslateSettings, TranslateSettingsSnapshot};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::bridge::BridgeHandle;
use crate::event_sink;

/// native メニューの Settings… から設定モーダルを開かせる。
#[derive(Clone, Serialize, specta::Type, Event)]
#[tauri_specta(event_name = "settings:open")]
pub struct OpenSettingsRequested {}

#[tauri::command]
#[specta::specta]
pub async fn translate_settings_get(app: AppHandle) -> Result<TranslateSettingsSnapshot, ApiError> {
    event_sink::off_main(move || {
        let base = monica_paths::base_dir().map_err(|e| ApiError::storage(format!("{e:#}")))?;
        let settings = monica_settings::Settings::load_from(&base)
            .map_err(|e| ApiError::storage(format!("{e:#}")))?;
        Ok(TranslateSettingsSnapshot {
            settings: settings.translate.into(),
            bridge_running: app.state::<BridgeHandle>().is_running(),
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn translate_settings_save(
    app: AppHandle,
    settings: TranslateSettings,
) -> Result<TranslateSettingsSnapshot, ApiError> {
    event_sink::off_main(move || {
        let translate: monica_settings::TranslateSettings = settings.into();
        translate
            .validate()
            .map_err(|e| ApiError::validation(format!("{e:#}")))?;

        let base = monica_paths::base_dir().map_err(|e| ApiError::storage(format!("{e:#}")))?;
        // translate 以外のセクションを消さないよう read-modify-write
        let mut current = monica_settings::Settings::load_from(&base)
            .map_err(|e| ApiError::storage(format!("{e:#}")))?;
        current.translate = translate;
        current
            .save_to(&base)
            .map_err(|e| ApiError::storage(format!("{e:#}")))?;

        let handle = app.state::<BridgeHandle>();
        handle
            .apply(current.translate.enabled)
            .map_err(|e| ApiError::external(format!("{e:#}")))?;

        Ok(TranslateSettingsSnapshot {
            settings: current.translate.into(),
            bridge_running: handle.is_running(),
        })
    })
    .await
}
