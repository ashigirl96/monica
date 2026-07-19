use serde::{Deserialize, Serialize};

/// A stored image asset, returned by the upload / import routes.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct Asset {
    pub id: String,
    pub url: String,
}

/// Request body for importing an external image URL into the local asset store.
#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub struct ImportAsset {
    pub url: String,
}
