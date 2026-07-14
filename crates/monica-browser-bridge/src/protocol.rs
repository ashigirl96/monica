use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct Segment {
    pub seg: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SegTranslation {
    pub seg: u64,
    pub translation: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    #[serde(rename = "translation")]
    Translation(SegTranslation),
    #[serde(rename = "done")]
    Done {},
    #[serde(rename = "error")]
    Error { message: String },
}
