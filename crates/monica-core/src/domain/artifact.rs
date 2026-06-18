use std::str::FromStr;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum ArtifactSpace {
    Personal,
}

impl ArtifactSpace {
    pub fn as_str(self) -> &'static str {
        match self {
            ArtifactSpace::Personal => "personal",
        }
    }
}

impl FromStr for ArtifactSpace {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "personal" => ArtifactSpace::Personal,
            other => return Err(anyhow!("unknown artifact space: {other}")),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum ArtifactType {
    Journal,
    Essay,
    Record,
    IntentSeed,
}

impl ArtifactType {
    pub const INITIAL_TEXT_TYPES: [ArtifactType; 2] =
        [ArtifactType::Record, ArtifactType::IntentSeed];

    pub fn as_str(self) -> &'static str {
        match self {
            ArtifactType::Journal => "journal",
            ArtifactType::Essay => "essay",
            ArtifactType::Record => "record",
            ArtifactType::IntentSeed => "intent_seed",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ArtifactType::Journal => "Journal",
            ArtifactType::Essay => "Essay",
            ArtifactType::Record => "Record",
            ArtifactType::IntentSeed => "Intent Seed",
        }
    }
}

impl FromStr for ArtifactType {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "journal" => ArtifactType::Journal,
            "essay" => ArtifactType::Essay,
            "record" => ArtifactType::Record,
            "intent_seed" => ArtifactType::IntentSeed,
            other => return Err(anyhow!("unknown artifact type: {other}")),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum IntentSeedStatus {
    Seed,
    Shaping,
    Active,
    Built,
    Parked,
}

impl IntentSeedStatus {
    pub const ALL: [IntentSeedStatus; 5] = [
        IntentSeedStatus::Seed,
        IntentSeedStatus::Shaping,
        IntentSeedStatus::Active,
        IntentSeedStatus::Built,
        IntentSeedStatus::Parked,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            IntentSeedStatus::Seed => "seed",
            IntentSeedStatus::Shaping => "shaping",
            IntentSeedStatus::Active => "active",
            IntentSeedStatus::Built => "built",
            IntentSeedStatus::Parked => "parked",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            IntentSeedStatus::Seed => "Seed",
            IntentSeedStatus::Shaping => "Shaping",
            IntentSeedStatus::Active => "Active",
            IntentSeedStatus::Built => "Built",
            IntentSeedStatus::Parked => "Parked",
        }
    }
}

impl FromStr for IntentSeedStatus {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "seed" => IntentSeedStatus::Seed,
            "shaping" => IntentSeedStatus::Shaping,
            "active" => IntentSeedStatus::Active,
            "built" => IntentSeedStatus::Built,
            "parked" => IntentSeedStatus::Parked,
            other => return Err(anyhow!("unknown intent seed status: {other}")),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum ArtifactLinkKind {
    DerivedFrom,
    Related,
}

impl ArtifactLinkKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ArtifactLinkKind::DerivedFrom => "derived_from",
            ArtifactLinkKind::Related => "related",
        }
    }
}

impl FromStr for ArtifactLinkKind {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "derived_from" => ArtifactLinkKind::DerivedFrom,
            "related" => ArtifactLinkKind::Related,
            other => return Err(anyhow!("unknown artifact link kind: {other}")),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ArtifactTypeOption {
    pub value: ArtifactType,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct IntentSeedStatusOption {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Artifact {
    pub id: String,
    pub space: ArtifactSpace,
    pub artifact_type: ArtifactType,
    pub title: Option<String>,
    pub body: String,
    pub status: Option<String>,
    pub source_artifact_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ArtifactSummary {
    pub id: String,
    pub artifact_type: ArtifactType,
    pub title: Option<String>,
    pub preview: String,
    pub status: Option<String>,
    pub source_artifact_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ArtifactLink {
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub id: i64,
    pub from_artifact_id: String,
    pub to_artifact_id: String,
    pub kind: ArtifactLinkKind,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ArtifactListFilter {
    pub artifact_type: Option<ArtifactType>,
    pub query: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct CreateArtifactInput {
    pub artifact_type: ArtifactType,
    pub title: Option<String>,
    pub body: String,
    pub status: Option<String>,
    pub source_artifact_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct UpdateArtifactInput {
    pub id: String,
    pub artifact_type: ArtifactType,
    pub title: Option<String>,
    pub body: String,
    pub status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct PersonalSpaceExport {
    pub exported_at_unix_ms: u64,
    pub artifacts: Vec<Artifact>,
    pub links: Vec<ArtifactLink>,
}

impl CreateArtifactInput {
    pub fn normalized(mut self) -> Result<Self> {
        self.title = normalize_title(self.title);
        self.status = normalize_status(self.artifact_type, self.status.as_deref())?;
        self.source_artifact_id = normalize_optional_id(self.source_artifact_id);
        Ok(self)
    }
}

impl UpdateArtifactInput {
    pub fn normalized(mut self) -> Result<Self> {
        self.title = normalize_title(self.title);
        self.status = normalize_status(self.artifact_type, self.status.as_deref())?;
        Ok(self)
    }
}

pub fn text_artifact_type_options() -> Vec<ArtifactTypeOption> {
    ArtifactType::INITIAL_TEXT_TYPES
        .into_iter()
        .map(|value| ArtifactTypeOption {
            value,
            label: value.label().to_string(),
        })
        .collect()
}

pub fn intent_seed_status_options() -> Vec<IntentSeedStatusOption> {
    IntentSeedStatus::ALL
        .into_iter()
        .map(|value| IntentSeedStatusOption {
            value: value.as_str().to_string(),
            label: value.label().to_string(),
        })
        .collect()
}

pub fn normalize_status(
    artifact_type: ArtifactType,
    status: Option<&str>,
) -> Result<Option<String>> {
    match artifact_type {
        ArtifactType::IntentSeed => {
            let raw = status.filter(|s| !s.trim().is_empty()).unwrap_or("seed");
            Ok(Some(raw.parse::<IntentSeedStatus>()?.as_str().to_string()))
        }
        _ => {
            if status.is_some_and(|s| !s.trim().is_empty()) {
                return Err(anyhow!(
                    "{} artifacts do not support a lifecycle status",
                    artifact_type.label()
                ));
            }
            Ok(None)
        }
    }
}

fn normalize_title(title: Option<String>) -> Option<String> {
    title
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn normalize_optional_id(id: Option<String>) -> Option<String> {
    id.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}
