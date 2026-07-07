use serde::Serialize;

/// Machine-readable category for an error crossing the Tauri boundary. The frontend branches on
/// `code` (e.g. show a "not found" vs. "already in progress" surface) instead of string-matching.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ApiErrorCode {
    NotFound,
    Conflict,
    Validation,
    AuthenticationRequired,
    Storage,
    External,
}

/// The error half of every Tauri command result. Replaces the previous `Result<T, String>` so the
/// frontend receives a structured `{ code, message }` instead of an opaque string.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ApiError {
    pub code: ApiErrorCode,
    pub message: String,
}

impl ApiError {
    pub fn new(code: ApiErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    /// For driver-local commands that don't cross the application boundary (clipboard, editor,
    /// git probes): a non-business failure the frontend surfaces but can't act on by code.
    pub fn external(message: impl Into<String>) -> Self {
        Self::new(ApiErrorCode::External, message)
    }
    pub fn storage(message: impl Into<String>) -> Self {
        Self::new(ApiErrorCode::Storage, message)
    }
    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(ApiErrorCode::Validation, message)
    }
}

impl From<monica_application::ApplicationError> for ApiError {
    fn from(error: monica_application::ApplicationError) -> Self {
        use monica_application::ApplicationError as E;
        let (code, message) = match error {
            E::NotFound(m) => (ApiErrorCode::NotFound, m),
            E::Conflict(m) => (ApiErrorCode::Conflict, m),
            E::Validation(m) => (ApiErrorCode::Validation, m),
            E::AuthenticationRequired(m) => (ApiErrorCode::AuthenticationRequired, m),
            E::Storage(m) => (ApiErrorCode::Storage, m),
            E::External(m) => (ApiErrorCode::External, m),
        };
        Self { code, message }
    }
}
