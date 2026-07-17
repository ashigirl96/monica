use std::fmt;
use std::ops::Deref;

use serde::{Deserialize, Serialize};

/// Defines a string-backed identity newtype with a private inner field. Construction is limited to
/// [`from_store`] (unchecked, for DB reads) and type-specific [`parse`] (validated). The wrapper
/// exists solely to keep a [`TaskId`] and a [`TaskRunId`] from being passed in each other's place.
macro_rules! id_newtype {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn from_store(value: String) -> Self {
                Self(value)
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_string(self) -> String {
                self.0
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }

        impl Deref for $name {
            type Target = str;

            fn deref(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl PartialEq<str> for $name {
            fn eq(&self, other: &str) -> bool {
                self.0 == other
            }
        }

        impl PartialEq<&str> for $name {
            fn eq(&self, other: &&str) -> bool {
                self.0 == *other
            }
        }
    };
}

/// `<prefix><n>` 形式の id 検証。u64::from_str は "+42" や "007" も受理するが、id は保存時の
/// 文字列そのままで path join に使われるため、正規形（n の十進表記と一致）だけを通す。
fn is_canonical_numeric_id(s: &str, prefix: &str) -> bool {
    let Some(num_part) = s.strip_prefix(prefix) else {
        return false;
    };
    match num_part.parse::<u64>() {
        Ok(n) => n > 0 && num_part == n.to_string(),
        Err(_) => false,
    }
}

id_newtype! {
    /// Identity of a [`Task`](crate::Task) aggregate (e.g. `"MON-1"`).
    TaskId
}

impl TaskId {
    pub fn parse(value: impl Into<String>) -> Result<Self, crate::DomainError> {
        let s = value.into();
        if let Some(num_part) = s.strip_prefix("MON-") {
            if let Ok(n) = num_part.parse::<u64>() {
                if n > 0 {
                    return Ok(Self(s));
                }
            }
        }
        Err(crate::DomainError::InvalidTaskId(s))
    }
}

id_newtype! {
    /// Identity of a [`TaskRun`](crate::TaskRun) (e.g. `"run-1"`).
    TaskRunId
}

id_newtype! {
    /// Identity of an [`Explanation`](crate::Explanation) (e.g. `"expl-1"`).
    ExplanationId
}

impl ExplanationId {
    pub fn parse(value: impl Into<String>) -> Result<Self, crate::DomainError> {
        let s = value.into();
        if is_canonical_numeric_id(&s, "expl-") {
            Ok(Self(s))
        } else {
            Err(crate::DomainError::InvalidExplanationId(s))
        }
    }
}

impl TaskRunId {
    pub fn parse(value: impl Into<String>) -> Result<Self, crate::DomainError> {
        let s = value.into();
        if crate::is_safe_task_run_id(&s) {
            Ok(Self(s))
        } else {
            Err(crate::DomainError::InvalidTaskRunId(s))
        }
    }
}

id_newtype! {
    /// Identity of a [`Note`](crate::Note) (e.g. `"note-1"`).
    NoteId
}

impl NoteId {
    pub fn parse(value: impl Into<String>) -> Result<Self, crate::DomainError> {
        let s = value.into();
        if is_canonical_numeric_id(&s, "note-") {
            Ok(Self(s))
        } else {
            Err(crate::DomainError::InvalidNoteId(s))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_store_round_trips() {
        let id = TaskId::from_store("MON-1".to_string());
        assert_eq!(id.as_str(), "MON-1");
        assert_eq!(id.into_string(), "MON-1");
    }

    #[test]
    fn parse_valid_task_id() {
        assert!(TaskId::parse("MON-1").is_ok());
        assert!(TaskId::parse("MON-42").is_ok());
    }

    #[test]
    fn parse_invalid_task_id() {
        assert!(TaskId::parse("not-a-task-id").is_err());
        assert!(TaskId::parse("MON-").is_err());
        assert!(TaskId::parse("MON-abc").is_err());
        assert!(TaskId::parse("MON-0").is_err());
    }

    #[test]
    fn deref_and_as_str_expose_the_inner_str() {
        let id = TaskId::from_store("MON-1".to_string());
        assert_eq!(id.as_str(), "MON-1");
        assert_eq!(&*id, "MON-1");
        assert_eq!(id.len(), 5);
    }

    #[test]
    fn display_matches_inner() {
        assert_eq!(TaskRunId::from_store("run-1".to_string()).to_string(), "run-1");
    }

    #[test]
    fn partial_eq_with_str_literal() {
        let id = TaskId::from_store("MON-1".to_string());
        assert_eq!(id, "MON-1");
        assert_ne!(id, "MON-2");
    }

    #[test]
    fn into_string_round_trips_through_from() {
        let id = TaskRunId::from_store("run-7".to_string());
        let raw: String = id.clone().into();
        assert_eq!(raw, "run-7");
        assert_eq!(id.into_string(), "run-7");
    }

    #[test]
    fn parse_valid_task_run_id() {
        assert!(TaskRunId::parse("run-1").is_ok());
        assert!(TaskRunId::parse("run-42").is_ok());
    }

    #[test]
    fn parse_invalid_task_run_id() {
        assert!(TaskRunId::parse("../evil").is_err());
        assert!(TaskRunId::parse("").is_err());
    }

    #[test]
    fn parse_valid_explanation_id() {
        assert!(ExplanationId::parse("expl-1").is_ok());
        assert!(ExplanationId::parse("expl-42").is_ok());
    }

    #[test]
    fn parse_invalid_explanation_id() {
        assert!(ExplanationId::parse("not-an-id").is_err());
        assert!(ExplanationId::parse("expl-").is_err());
        assert!(ExplanationId::parse("expl-abc").is_err());
        assert!(ExplanationId::parse("expl-0").is_err());
    }

    #[test]
    fn parse_rejects_non_canonical_explanation_id() {
        assert!(ExplanationId::parse("expl-+42").is_err());
        assert!(ExplanationId::parse("expl-007").is_err());
        assert!(ExplanationId::parse("expl-01").is_err());
    }

    #[test]
    fn parse_valid_note_id() {
        assert!(NoteId::parse("note-1").is_ok());
        assert!(NoteId::parse("note-42").is_ok());
    }

    #[test]
    fn parse_invalid_note_id() {
        assert!(NoteId::parse("not-an-id").is_err());
        assert!(NoteId::parse("note-").is_err());
        assert!(NoteId::parse("note-abc").is_err());
        assert!(NoteId::parse("note-0").is_err());
        assert!(NoteId::parse("daily-counts").is_err());
    }

    #[test]
    fn parse_rejects_non_canonical_note_id() {
        assert!(NoteId::parse("note-+42").is_err());
        assert!(NoteId::parse("note-007").is_err());
        assert!(NoteId::parse("note-01").is_err());
    }
}
