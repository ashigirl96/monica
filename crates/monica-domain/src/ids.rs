use std::fmt;
use std::ops::Deref;

use serde::{Deserialize, Serialize};

/// Defines a string-backed identity newtype. The two task identities share an identical surface, so
/// the impls are generated once here rather than copied — the wrapper exists solely to keep a
/// [`TaskId`] and a [`TaskRunId`] from being passed in each other's place.
macro_rules! id_newtype {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_string(self) -> String {
                self.0
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_string())
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

id_newtype! {
    /// Identity of a [`Task`](crate::Task) aggregate (e.g. `"MON-1"`).
    TaskId
}

id_newtype! {
    /// Identity of a [`TaskRun`](crate::TaskRun) (e.g. `"run-1"`).
    TaskRunId
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_string_and_str_are_equivalent() {
        assert_eq!(TaskId::from("MON-1"), TaskId::from("MON-1".to_string()));
    }

    #[test]
    fn deref_and_as_str_expose_the_inner_str() {
        let id = TaskId::from("MON-1");
        assert_eq!(id.as_str(), "MON-1");
        assert_eq!(&*id, "MON-1");
        assert_eq!(id.len(), 5);
    }

    #[test]
    fn display_matches_inner() {
        assert_eq!(TaskRunId::from("run-1").to_string(), "run-1");
    }

    #[test]
    fn partial_eq_with_str_literal() {
        let id = TaskId::from("MON-1");
        assert_eq!(id, "MON-1");
        assert_ne!(id, "MON-2");
    }

    #[test]
    fn into_string_round_trips_through_from() {
        let id = TaskRunId::from("run-7");
        let raw: String = id.clone().into();
        assert_eq!(raw, "run-7");
        assert_eq!(id.into_string(), "run-7");
    }
}
