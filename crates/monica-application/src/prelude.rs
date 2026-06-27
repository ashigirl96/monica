//! Import surface for use-case code.
//!
//! The pure aggregates and rules live in the `monica-domain` crate; this module re-exports them
//! so use cases import everything they need from `crate::prelude` regardless of which side a given
//! type lives on.

pub use monica_domain::*;
