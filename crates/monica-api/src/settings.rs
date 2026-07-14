use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct TranslateSettings {
    pub enabled: bool,
    pub port: u16,
    pub allowed_origins: Vec<String>,
    pub model: TranslateModel,
    pub effort: TranslateEffort,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TranslateModel {
    Haiku,
    Sonnet,
    Opus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TranslateEffort {
    Low,
    Medium,
    High,
}

/// 設定 UI が表示する snapshot: 設定値 + bridge プロセスの現況。
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct TranslateSettingsSnapshot {
    pub settings: TranslateSettings,
    pub bridge_running: bool,
}

impl From<monica_settings::TranslateSettings> for TranslateSettings {
    fn from(value: monica_settings::TranslateSettings) -> Self {
        Self {
            enabled: value.enabled,
            port: value.port,
            allowed_origins: value.allowed_origins,
            model: value.model.into(),
            effort: value.effort.into(),
        }
    }
}

impl From<TranslateSettings> for monica_settings::TranslateSettings {
    fn from(value: TranslateSettings) -> Self {
        Self {
            enabled: value.enabled,
            port: value.port,
            allowed_origins: value.allowed_origins,
            model: value.model.into(),
            effort: value.effort.into(),
        }
    }
}

impl From<monica_settings::TranslateModel> for TranslateModel {
    fn from(value: monica_settings::TranslateModel) -> Self {
        match value {
            monica_settings::TranslateModel::Haiku => Self::Haiku,
            monica_settings::TranslateModel::Sonnet => Self::Sonnet,
            monica_settings::TranslateModel::Opus => Self::Opus,
        }
    }
}

impl From<TranslateModel> for monica_settings::TranslateModel {
    fn from(value: TranslateModel) -> Self {
        match value {
            TranslateModel::Haiku => Self::Haiku,
            TranslateModel::Sonnet => Self::Sonnet,
            TranslateModel::Opus => Self::Opus,
        }
    }
}

impl From<monica_settings::TranslateEffort> for TranslateEffort {
    fn from(value: monica_settings::TranslateEffort) -> Self {
        match value {
            monica_settings::TranslateEffort::Low => Self::Low,
            monica_settings::TranslateEffort::Medium => Self::Medium,
            monica_settings::TranslateEffort::High => Self::High,
        }
    }
}

impl From<TranslateEffort> for monica_settings::TranslateEffort {
    fn from(value: TranslateEffort) -> Self {
        match value {
            TranslateEffort::Low => Self::Low,
            TranslateEffort::Medium => Self::Medium,
            TranslateEffort::High => Self::High,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_mirror_roundtrips() {
        let original = monica_settings::TranslateSettings::default();
        let api: TranslateSettings = original.clone().into();
        let back: monica_settings::TranslateSettings = api.into();
        assert_eq!(back, original);
    }

    #[test]
    fn enum_mirrors_match_settings_serde() {
        for (settings, api) in [
            (monica_settings::TranslateModel::Haiku, TranslateModel::Haiku),
            (monica_settings::TranslateModel::Sonnet, TranslateModel::Sonnet),
            (monica_settings::TranslateModel::Opus, TranslateModel::Opus),
        ] {
            assert_eq!(TranslateModel::from(settings), api);
            assert_eq!(
                serde_json::to_string(&settings).unwrap(),
                serde_json::to_string(&api).unwrap(),
            );
        }
        for (settings, api) in [
            (monica_settings::TranslateEffort::Low, TranslateEffort::Low),
            (monica_settings::TranslateEffort::Medium, TranslateEffort::Medium),
            (monica_settings::TranslateEffort::High, TranslateEffort::High),
        ] {
            assert_eq!(TranslateEffort::from(settings), api);
            assert_eq!(
                serde_json::to_string(&settings).unwrap(),
                serde_json::to_string(&api).unwrap(),
            );
        }
    }
}
