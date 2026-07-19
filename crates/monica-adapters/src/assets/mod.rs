//! Filesystem-backed store for pasted image assets. Pure FS/network I/O that opens no store, so —
//! like [`crate::ogp`] — it stays a free-function module rather than a port trait. Bytes are written
//! verbatim (no re-encode, so animated GIFs survive) under `<MONICA_HOME>/assets/<uuid>.<ext>`, and
//! the filename doubles as the public id.

use std::time::Duration;

pub mod gc;

/// URL path assets are served under. The web route and the GC reachability scan both key off this
/// prefix, so it lives here as the single source of truth.
pub const ASSET_URL_PREFIX: &str = "/api/assets/";

/// Hard ceiling on a single asset, enforced on both the upload and import paths.
pub const MAX_ASSET_BYTES: usize = 20 * 1024 * 1024;

/// The raster formats we accept. SVG is intentionally excluded (XSS via embedded script), and since
/// detection is by magic bytes a text SVG never matches anyway.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormat {
    Png,
    Jpeg,
    Gif,
    Webp,
}

impl ImageFormat {
    /// Filename extension used in the asset id.
    pub fn ext(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Gif => "gif",
            Self::Webp => "webp",
        }
    }

    pub fn content_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
        }
    }

    fn from_ext(ext: &str) -> Option<Self> {
        match ext {
            "png" => Some(Self::Png),
            "jpg" => Some(Self::Jpeg),
            "gif" => Some(Self::Gif),
            "webp" => Some(Self::Webp),
            _ => None,
        }
    }
}

/// InvalidUrl / Fetch mirror [`crate::ogp::LinkPreviewError`] (400 / 502). UnsupportedFormat is a
/// rejected body (415), TooLarge is the 20MB cap (413), Io is a local filesystem failure (500).
#[derive(Debug)]
pub enum AssetError {
    InvalidUrl(anyhow::Error),
    Fetch(anyhow::Error),
    UnsupportedFormat,
    TooLarge,
    Io(anyhow::Error),
}

impl std::fmt::Display for AssetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidUrl(e) => write!(f, "invalid url: {e}"),
            Self::Fetch(e) => write!(f, "fetch failed: {e}"),
            Self::UnsupportedFormat => write!(f, "unsupported image format"),
            Self::TooLarge => write!(f, "image exceeds size limit"),
            Self::Io(e) => write!(f, "io error: {e}"),
        }
    }
}

impl std::error::Error for AssetError {}

/// A stored asset: its id (`<uuid>.<ext>`) and the URL it is served at.
#[derive(Debug, Clone)]
pub struct SavedAsset {
    pub id: String,
    pub url: String,
}

/// Detect a supported raster format from the leading bytes. Content-Type headers are never trusted;
/// this is the sole authority on what an asset actually is, and the extension is derived from it.
pub fn sniff_image_format(bytes: &[u8]) -> Option<ImageFormat> {
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some(ImageFormat::Png);
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(ImageFormat::Jpeg);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(ImageFormat::Gif);
    }
    // WEBP: "RIFF" <4-byte size> "WEBP"
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some(ImageFormat::Webp);
    }
    None
}

/// Validate an asset id (`<uuid-v4>.<ext>`) and return its format. This is the traversal guard for
/// the GET route: only ids matching this exact shape ever reach the filesystem, so `..`, path
/// separators, and absolute paths are all rejected before any `join`.
pub fn parse_asset_id(id: &str) -> Option<ImageFormat> {
    let (stem, ext) = id.rsplit_once('.')?;
    let format = ImageFormat::from_ext(ext)?;
    is_uuid_v4(stem).then_some(format)
}

/// Lowercase 8-4-4-4-12 hex, matching `uuid`'s hyphenated Display. We generate ids ourselves, so a
/// strict shape check is enough — no need to validate version/variant nibbles.
fn is_uuid_v4(s: &str) -> bool {
    let groups = [8, 4, 4, 4, 12];
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != groups.len() {
        return false;
    }
    parts.iter().zip(groups).all(|(part, len)| {
        part.len() == len && part.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

/// Persist raw image bytes. Rejects anything that isn't a supported raster format (magic bytes) or
/// exceeds [`MAX_ASSET_BYTES`]. Bytes are written verbatim — no decode/re-encode.
pub fn save_asset(bytes: &[u8]) -> Result<SavedAsset, AssetError> {
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(AssetError::TooLarge);
    }
    let format = sniff_image_format(bytes).ok_or(AssetError::UnsupportedFormat)?;
    let id = format!("{}.{}", uuid::Uuid::new_v4(), format.ext());
    let dir = monica_paths::assets_dir().map_err(AssetError::Io)?;
    std::fs::create_dir_all(&dir).map_err(|e| AssetError::Io(e.into()))?;
    let path = dir.join(&id);
    std::fs::write(&path, bytes).map_err(|e| AssetError::Io(e.into()))?;
    Ok(SavedAsset { url: asset_url(&id), id })
}

/// Read an asset's bytes and content-type. Returns `None` when the id is malformed (traversal
/// attempt) or the file is missing — both map to 404 at the route.
pub fn read_asset(id: &str) -> Result<Option<(Vec<u8>, &'static str)>, AssetError> {
    let Some(format) = parse_asset_id(id) else {
        return Ok(None);
    };
    let path = monica_paths::asset_path(id).map_err(AssetError::Io)?;
    match std::fs::read(&path) {
        Ok(bytes) => Ok(Some((bytes, format.content_type()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AssetError::Io(e.into())),
    }
}

/// Fetch an external image URL and store it locally. Reuses the OGP HTTP client; caps the download
/// at [`MAX_ASSET_BYTES`] the same way [`crate::ogp`] caps HTML.
pub async fn import_asset(url: &str) -> Result<SavedAsset, AssetError> {
    let parsed = reqwest::Url::parse(url).map_err(|e| AssetError::InvalidUrl(e.into()))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(AssetError::InvalidUrl(anyhow::anyhow!(
            "unsupported scheme: {}",
            parsed.scheme()
        )));
    }
    let mut response = client()
        .get(parsed)
        .send()
        .await
        .map_err(|e| AssetError::Fetch(e.into()))?;
    let bytes = read_capped(&mut response).await?;
    save_asset(&bytes)
}

/// The public URL an asset id is served at.
pub fn asset_url(id: &str) -> String {
    format!("{ASSET_URL_PREFIX}{id}")
}

// Accumulate the body chunk by chunk, bailing out with TooLarge the moment we cross the cap so an
// oversized (or lying-Content-Length) response never fills memory.
async fn read_capped(response: &mut reqwest::Response) -> Result<Vec<u8>, AssetError> {
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| AssetError::Fetch(e.into()))? {
        buf.extend_from_slice(&chunk);
        if buf.len() > MAX_ASSET_BYTES {
            return Err(AssetError::TooLarge);
        }
    }
    Ok(buf)
}

fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| crate::http::http_client(Duration::from_secs(10)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x01];
    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
    const GIF89A: &[u8] = b"GIF89a\x01\x00";
    const GIF87A: &[u8] = b"GIF87a\x01\x00";

    fn webp() -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
        v.extend_from_slice(b"WEBPVP8 ");
        v
    }

    #[test]
    fn sniff_accepts_supported_rasters() {
        assert_eq!(sniff_image_format(PNG), Some(ImageFormat::Png));
        assert_eq!(sniff_image_format(JPEG), Some(ImageFormat::Jpeg));
        assert_eq!(sniff_image_format(GIF87A), Some(ImageFormat::Gif));
        assert_eq!(sniff_image_format(GIF89A), Some(ImageFormat::Gif));
        assert_eq!(sniff_image_format(&webp()), Some(ImageFormat::Webp));
    }

    #[test]
    fn sniff_rejects_svg_and_junk() {
        assert_eq!(sniff_image_format(b"<svg xmlns=\"http://www.w3.org/2000/svg\">"), None);
        assert_eq!(sniff_image_format(b"<?xml version=\"1.0\"?><svg/>"), None);
        assert_eq!(sniff_image_format(b"not an image at all"), None);
        assert_eq!(sniff_image_format(b""), None);
        assert_eq!(sniff_image_format(b"RIFF____NOTW"), None);
    }

    #[test]
    fn parse_asset_id_accepts_generated_ids() {
        let id = format!("{}.png", uuid::Uuid::new_v4());
        assert_eq!(parse_asset_id(&id), Some(ImageFormat::Png));
        let id = format!("{}.webp", uuid::Uuid::new_v4());
        assert_eq!(parse_asset_id(&id), Some(ImageFormat::Webp));
    }

    #[test]
    fn parse_asset_id_rejects_traversal_and_bad_shapes() {
        assert_eq!(parse_asset_id("../secret.png"), None);
        assert_eq!(parse_asset_id("../../etc/passwd.png"), None);
        assert_eq!(parse_asset_id("foo/bar.png"), None);
        // valid uuid but disallowed extension
        assert_eq!(parse_asset_id(&format!("{}.svg", uuid::Uuid::new_v4())), None);
        assert_eq!(parse_asset_id(&format!("{}.exe", uuid::Uuid::new_v4())), None);
        // missing extension
        assert_eq!(parse_asset_id(&uuid::Uuid::new_v4().to_string()), None);
        // uppercase hex is not what we generate
        assert_eq!(parse_asset_id("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA.png"), None);
        // not a uuid stem
        assert_eq!(parse_asset_id("hello.png"), None);
    }

    #[test]
    fn save_then_read_roundtrips_bytes_verbatim() {
        let gif = {
            // GIF with a trailing byte to prove we don't truncate/re-encode.
            let mut v = GIF89A.to_vec();
            v.extend_from_slice(&[0x2C, 0x00, 0x3B]);
            v
        };
        let saved = save_asset(&gif).expect("save");
        assert!(saved.id.ends_with(".gif"));
        assert_eq!(saved.url, format!("/api/assets/{}", saved.id));
        let (bytes, ct) = read_asset(&saved.id).expect("read").expect("present");
        assert_eq!(bytes, gif);
        assert_eq!(ct, "image/gif");
    }

    #[test]
    fn save_rejects_unsupported_and_oversized() {
        match save_asset(b"<svg/>") {
            Err(AssetError::UnsupportedFormat) => {}
            other => panic!("expected UnsupportedFormat, got {other:?}"),
        }
        let mut huge = PNG.to_vec();
        huge.resize(MAX_ASSET_BYTES + 1, 0);
        match save_asset(&huge) {
            Err(AssetError::TooLarge) => {}
            other => panic!("expected TooLarge, got {other:?}"),
        }
    }

    #[test]
    fn read_missing_or_malformed_id_is_none() {
        assert!(read_asset("../etc/passwd.png").expect("no error").is_none());
        let absent = format!("{}.png", uuid::Uuid::new_v4());
        assert!(read_asset(&absent).expect("no error").is_none());
    }

    #[tokio::test]
    async fn import_rejects_non_http_schemes() {
        for url in ["file:///etc/passwd", "data:image/png;base64,AAAA", "not a url"] {
            match import_asset(url).await {
                Err(AssetError::InvalidUrl(_)) => {}
                other => panic!("expected InvalidUrl for {url}, got {other:?}"),
            }
        }
    }
}
