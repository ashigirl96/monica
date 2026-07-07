use std::fmt;

use monica_domain::DomainError;

/// Structured failures crossing the application boundary. Drivers translate these into their own
/// surface (Tauri `ApiError` code, CLI exit) instead of collapsing every error into a string, so a
/// caller can tell a missing record from a validation failure from an infrastructure fault.
///
/// Port traits keep returning `anyhow::Result` for genuine infrastructure faults; those propagate
/// here as [`ApplicationError::Storage`] via the `From<anyhow::Error>` below. Business outcomes
/// (not found / conflict / invalid input) are raised explicitly inside use cases.
#[derive(Debug)]
pub enum ApplicationError {
    NotFound(String),
    Conflict(String),
    Validation(String),
    AuthenticationRequired(String),
    Storage(String),
    External(String),
}

pub type ApplicationResult<T> = Result<T, ApplicationError>;

impl ApplicationError {
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::Conflict(message.into())
    }
    pub fn validation(message: impl Into<String>) -> Self {
        Self::Validation(message.into())
    }
    pub fn authentication_required(message: impl Into<String>) -> Self {
        Self::AuthenticationRequired(message.into())
    }
    pub fn external(message: impl Into<String>) -> Self {
        Self::External(message.into())
    }
}

impl fmt::Display for ApplicationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApplicationError::NotFound(m)
            | ApplicationError::Conflict(m)
            | ApplicationError::Validation(m)
            | ApplicationError::AuthenticationRequired(m)
            | ApplicationError::Storage(m)
            | ApplicationError::External(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for ApplicationError {}

impl From<DomainError> for ApplicationError {
    fn from(error: DomainError) -> Self {
        ApplicationError::Validation(error.to_string())
    }
}

/// Port/infrastructure faults arrive as `anyhow::Error` (the port traits' error type) and are
/// classified as storage faults. Use cases must NOT route business errors through here — those are
/// constructed as explicit variants so the boundary can distinguish them.
impl From<anyhow::Error> for ApplicationError {
    fn from(error: anyhow::Error) -> Self {
        match error.downcast::<ApplicationError>() {
            Ok(app_error) => app_error,
            Err(error) => ApplicationError::Storage(format!("{error:#}")),
        }
    }
}
