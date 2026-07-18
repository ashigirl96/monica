//! `<base>/settings.json` を single source of truth とするアプリ設定。
//!
//! base（MONICA_HOME 相当）は呼び手が明示的に渡す。env からの暗黙解決を
//! ここに持たせると、desktop と bridge が別 home の settings.json を読む
//! 混線（dev/prod）を型では防げなくなる。

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const SETTINGS_FILE: &str = "settings.json";

pub const DEFAULT_TRANSLATE_PORT: u16 = 43110;
/// manifest.json の `key`（公開鍵）から決定的に導かれる固定 extension ID。
pub const DEFAULT_EXTENSION_ORIGIN: &str = "chrome-extension://lencjjlgejlnlgmpcginknhfliagigia";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Settings {
    pub translate: TranslateSettings,
    pub notes: NotesSettings,
}

/// notes ドメイン専用の設定。アプリ全体の日付概念には影響させない。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct NotesSettings {
    /// note の日付境界（0–23）。5 なら翌朝 5 時までは前日の daily に帰属する
    /// （放送業界の 28 時表記と同じ発想）。変更は過去の note の date に遡及しない。
    pub day_boundary_hour: u8,
}

impl NotesSettings {
    pub fn validate(&self) -> Result<()> {
        if self.day_boundary_hour > 23 {
            anyhow::bail!("day_boundary_hour must be 0-23");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TranslateSettings {
    pub enabled: bool,
    pub port: u16,
    pub allowed_origins: Vec<String>,
    pub model: TranslateModel,
    pub effort: TranslateEffort,
}

impl Default for TranslateSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            port: DEFAULT_TRANSLATE_PORT,
            allowed_origins: vec![DEFAULT_EXTENSION_ORIGIN.to_string()],
            model: TranslateModel::default(),
            effort: TranslateEffort::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TranslateModel {
    #[default]
    Haiku,
    Sonnet,
    Opus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TranslateEffort {
    #[default]
    Low,
    Medium,
    High,
}

impl Settings {
    /// ファイル欠落は defaults、壊れた JSON はエラー（黙って defaults に落とすと
    /// ユーザーの編集ミスが「設定が消えた」に見える）。
    pub fn load_from(base: &Path) -> Result<Self> {
        let path = settings_path(base);
        let contents = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(e).with_context(|| format!("failed to read {}", path.display())),
        };
        serde_json::from_str(&contents)
            .with_context(|| format!("invalid settings JSON: {}", path.display()))
    }

    /// tmp+rename の atomic write。書きかけの JSON を bridge が読む窓を作らない。
    pub fn save_to(&self, base: &Path) -> Result<()> {
        std::fs::create_dir_all(base)
            .with_context(|| format!("failed to create {}", base.display()))?;
        let path = settings_path(base);
        let tmp = path.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(self).context("failed to serialize settings")?;
        std::fs::write(&tmp, json)
            .with_context(|| format!("failed to write {}", tmp.display()))?;
        std::fs::rename(&tmp, &path)
            .with_context(|| format!("failed to rename {} -> {}", tmp.display(), path.display()))
    }
}

impl TranslateSettings {
    pub fn validate(&self) -> Result<()> {
        if self.port == 0 {
            anyhow::bail!("port must be non-zero");
        }
        for origin in &self.allowed_origins {
            let valid = origin.starts_with("chrome-extension://")
                || origin.starts_with("http://")
                || origin.starts_with("https://");
            let has_host = origin
                .split_once("://")
                .is_some_and(|(_, host)| !host.trim_matches('/').is_empty());
            if !valid || !has_host {
                anyhow::bail!(
                    "invalid origin {origin:?}: expected chrome-extension://<id> or http(s)://<host>"
                );
            }
        }
        Ok(())
    }
}

fn settings_path(base: &Path) -> PathBuf {
    base.join(SETTINGS_FILE)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "monica-settings-test-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn defaults_are_zero_config() {
        let s = Settings::default();
        assert!(s.translate.enabled);
        assert_eq!(s.translate.port, DEFAULT_TRANSLATE_PORT);
        assert_eq!(
            s.translate.allowed_origins,
            vec![DEFAULT_EXTENSION_ORIGIN.to_string()]
        );
        assert_eq!(s.translate.model, TranslateModel::Haiku);
        assert_eq!(s.translate.effort, TranslateEffort::Low);
        assert!(s.translate.validate().is_ok());
    }

    #[test]
    fn missing_file_loads_defaults() {
        let base = temp_base("missing");
        let s = Settings::load_from(&base).unwrap();
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn save_load_roundtrip() {
        let base = temp_base("roundtrip");
        let mut s = Settings::default();
        s.translate.enabled = false;
        s.translate.port = 50000;
        s.translate.model = TranslateModel::Sonnet;
        s.translate.effort = TranslateEffort::High;
        s.translate.allowed_origins = vec!["https://example.com".to_string()];
        s.save_to(&base).unwrap();
        assert_eq!(Settings::load_from(&base).unwrap(), s);
    }

    #[test]
    fn partial_json_fills_defaults() {
        let base = temp_base("partial");
        std::fs::write(
            base.join(SETTINGS_FILE),
            r#"{ "translate": { "enabled": false } }"#,
        )
        .unwrap();
        let s = Settings::load_from(&base).unwrap();
        assert!(!s.translate.enabled);
        assert_eq!(s.translate.port, DEFAULT_TRANSLATE_PORT);
        assert_eq!(
            s.translate.allowed_origins,
            vec![DEFAULT_EXTENSION_ORIGIN.to_string()]
        );
    }

    #[test]
    fn unknown_keys_are_tolerated() {
        let base = temp_base("unknown");
        std::fs::write(
            base.join(SETTINGS_FILE),
            r#"{ "translate": { "enabled": true, "future_field": 1 }, "other": {} }"#,
        )
        .unwrap();
        assert!(Settings::load_from(&base).is_ok());
    }

    #[test]
    fn corrupt_json_is_an_error_not_defaults() {
        let base = temp_base("corrupt");
        std::fs::write(base.join(SETTINGS_FILE), "{ not json").unwrap();
        assert!(Settings::load_from(&base).is_err());
    }

    #[test]
    fn serde_representation_is_snake_case() {
        let json = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(json["translate"]["model"], "haiku");
        assert_eq!(json["translate"]["effort"], "low");
    }

    #[test]
    fn notes_defaults_and_partial_json() {
        assert_eq!(Settings::default().notes.day_boundary_hour, 0);
        // notes セクションのない既存ファイルは default で補完される
        let base = temp_base("notes-partial");
        std::fs::write(
            base.join(SETTINGS_FILE),
            r#"{ "translate": { "enabled": false } }"#,
        )
        .unwrap();
        let s = Settings::load_from(&base).unwrap();
        assert_eq!(s.notes.day_boundary_hour, 0);
    }

    #[test]
    fn notes_roundtrip_coexists_with_translate() {
        let base = temp_base("notes-roundtrip");
        let mut s = Settings::default();
        s.translate.enabled = false;
        s.notes.day_boundary_hour = 5;
        s.save_to(&base).unwrap();
        assert_eq!(Settings::load_from(&base).unwrap(), s);
    }

    #[test]
    fn notes_validate_bounds() {
        assert!(NotesSettings { day_boundary_hour: 0 }.validate().is_ok());
        assert!(NotesSettings { day_boundary_hour: 23 }.validate().is_ok());
        assert!(NotesSettings { day_boundary_hour: 24 }.validate().is_err());
    }

    #[test]
    fn validate_rejects_bad_input() {
        let s = TranslateSettings {
            port: 0,
            ..Default::default()
        };
        assert!(s.validate().is_err());

        let s = TranslateSettings {
            allowed_origins: vec!["ftp://example.com".to_string()],
            ..Default::default()
        };
        assert!(s.validate().is_err());

        let s = TranslateSettings {
            allowed_origins: vec!["chrome-extension://".to_string()],
            ..Default::default()
        };
        assert!(s.validate().is_err());

        let s = TranslateSettings {
            allowed_origins: vec![],
            ..Default::default()
        };
        assert!(s.validate().is_ok());
    }
}
