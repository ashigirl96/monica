use serde::Serialize;

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct LinkPreview {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
    pub favicon: Option<String>,
    pub site_name: Option<String>,
}

impl From<monica_application::LinkPreview> for LinkPreview {
    fn from(value: monica_application::LinkPreview) -> Self {
        Self {
            url: value.url,
            title: value.title,
            description: value.description,
            image: value.image,
            favicon: value.favicon,
            site_name: value.site_name,
        }
    }
}
