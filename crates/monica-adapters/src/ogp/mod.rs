//! Fetches a web page and scrapes OGP tags / HTML head into a [`LinkPreview`].

use std::collections::HashMap;
use std::sync::{LazyLock, OnceLock};
use std::time::Duration;

use anyhow::anyhow;
use monica_application::LinkPreview;
use reqwest::Url;
use scraper::{Html, Selector};

// OGP は head にあるので、ここで読み止めても取りこぼさない
const MAX_HTML_BYTES: usize = 1024 * 1024;

/// InvalidUrl は呼び手の入力不正（HTTP 400 相当）、Fetch は相手サーバー起因（502 相当）。
#[derive(Debug)]
pub enum LinkPreviewError {
    InvalidUrl(anyhow::Error),
    Fetch(anyhow::Error),
}

impl std::fmt::Display for LinkPreviewError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidUrl(e) => write!(f, "invalid url: {e}"),
            Self::Fetch(e) => write!(f, "fetch failed: {e}"),
        }
    }
}

impl std::error::Error for LinkPreviewError {}

pub async fn fetch_link_preview(url: &str) -> Result<LinkPreview, LinkPreviewError> {
    let parsed = Url::parse(url).map_err(|e| LinkPreviewError::InvalidUrl(e.into()))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(LinkPreviewError::InvalidUrl(anyhow!(
            "unsupported scheme: {}",
            parsed.scheme()
        )));
    }
    let mut response = client()
        .get(parsed)
        .send()
        .await
        .map_err(|e| LinkPreviewError::Fetch(e.into()))?;
    // リダイレクトを追った後の URL を相対パス解決の基準にする
    let final_url = response.url().clone();
    let is_html = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_none_or(|ct| ct.contains("html"));
    let html = if is_html {
        read_capped(&mut response).await.map_err(|e| LinkPreviewError::Fetch(e.into()))?
    } else {
        String::new()
    };
    Ok(parse_link_preview(&html, &final_url))
}

// 全 body を bytes() で溜めず、上限に達したら response ごと drop して転送も打ち切る
async fn read_capped(response: &mut reqwest::Response) -> reqwest::Result<String> {
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        buf.extend_from_slice(&chunk);
        if buf.len() >= MAX_HTML_BYTES {
            buf.truncate(MAX_HTML_BYTES);
            break;
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

static META_SELECTOR: LazyLock<Selector> =
    LazyLock::new(|| Selector::parse("meta[content]").expect("valid selector"));
static TITLE_SELECTOR: LazyLock<Selector> =
    LazyLock::new(|| Selector::parse("title").expect("valid selector"));
static ICON_SELECTOR: LazyLock<Selector> =
    LazyLock::new(|| Selector::parse("link[rel][href]").expect("valid selector"));

const META_KEYS: [&str; 5] =
    ["og:title", "og:description", "og:image", "og:site_name", "description"];

fn parse_link_preview(html: &str, base: &Url) -> LinkPreview {
    let doc = Html::parse_document(html);
    let mut meta: HashMap<&str, String> = HashMap::new();
    for el in doc.select(&META_SELECTOR) {
        let value = el.value();
        let Some(content) = value.attr("content").map(str::trim).filter(|s| !s.is_empty()) else {
            continue;
        };
        // OGP は property=、description 等は name= に入るため両属性を見る
        for key in [value.attr("property"), value.attr("name")].into_iter().flatten() {
            if let Some(known) = META_KEYS.iter().find(|k| **k == key) {
                meta.entry(known).or_insert_with(|| content.to_string());
            }
        }
    }
    let title = meta.remove("og:title").or_else(|| title_text(&doc));
    let description = meta.remove("og:description").or_else(|| meta.remove("description"));
    let image = meta.remove("og:image").and_then(|href| absolutize(base, &href));
    let site_name = meta.remove("og:site_name");
    let favicon = icon_href(&doc)
        .and_then(|href| absolutize(base, &href))
        .or_else(|| fallback_favicon(base));
    LinkPreview {
        url: base.as_str().to_string(),
        title,
        description,
        image,
        favicon,
        site_name,
    }
}

fn title_text(doc: &Html) -> Option<String> {
    let text = doc.select(&TITLE_SELECTOR).next()?.text().collect::<String>();
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn icon_href(doc: &Html) -> Option<String> {
    doc.select(&ICON_SELECTOR).find_map(|el| {
        let rel = el.value().attr("rel")?;
        if !rel.split_whitespace().any(|t| t.eq_ignore_ascii_case("icon")) {
            return None;
        }
        el.value().attr("href").map(str::to_string)
    })
}

fn absolutize(base: &Url, href: &str) -> Option<String> {
    base.join(href).ok().map(|u| u.to_string())
}

fn fallback_favicon(base: &Url) -> Option<String> {
    base.join("/favicon.ico").ok().map(|u| u.to_string())
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| crate::http::http_client(Duration::from_secs(10)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Url {
        Url::parse("https://example.com/watch?v=abc").expect("valid url")
    }

    #[test]
    fn extracts_og_tags_and_resolves_relative_urls() {
        let html = r#"<html><head>
            <title>Fallback Title</title>
            <meta property="og:title" content="Bonobo - Dark Will Fall">
            <meta property="og:description" content="From the LAZARUS soundtrack.">
            <meta property="og:image" content="/thumbs/abc.jpg">
            <meta property="og:site_name" content="YouTube">
            <link rel="shortcut icon" href="favicon.png">
        </head><body></body></html>"#;
        let preview = parse_link_preview(html, &base());
        assert_eq!(preview.title.as_deref(), Some("Bonobo - Dark Will Fall"));
        assert_eq!(preview.description.as_deref(), Some("From the LAZARUS soundtrack."));
        assert_eq!(preview.image.as_deref(), Some("https://example.com/thumbs/abc.jpg"));
        assert_eq!(preview.site_name.as_deref(), Some("YouTube"));
        assert_eq!(preview.favicon.as_deref(), Some("https://example.com/favicon.png"));
    }

    #[test]
    fn falls_back_to_title_tag_meta_description_and_root_favicon() {
        let html = r#"<html><head>
            <title>  Plain Page  </title>
            <meta name="description" content="A page without OGP.">
        </head><body></body></html>"#;
        let preview = parse_link_preview(html, &base());
        assert_eq!(preview.title.as_deref(), Some("Plain Page"));
        assert_eq!(preview.description.as_deref(), Some("A page without OGP."));
        assert_eq!(preview.image, None);
        assert_eq!(preview.site_name, None);
        assert_eq!(preview.favicon.as_deref(), Some("https://example.com/favicon.ico"));
    }

    #[test]
    fn first_meta_occurrence_wins() {
        let html = r#"<html><head>
            <meta property="og:title" content="First">
            <meta property="og:title" content="Second">
        </head></html>"#;
        let preview = parse_link_preview(html, &base());
        assert_eq!(preview.title.as_deref(), Some("First"));
    }

    #[test]
    fn empty_html_yields_no_metadata() {
        let preview = parse_link_preview("", &base());
        assert_eq!(preview.title, None);
        assert_eq!(preview.description, None);
        assert_eq!(preview.url, "https://example.com/watch?v=abc");
    }

    #[tokio::test]
    async fn rejects_non_http_schemes() {
        for url in ["file:///etc/passwd", "not a url"] {
            match fetch_link_preview(url).await {
                Err(LinkPreviewError::InvalidUrl(_)) => {}
                other => panic!("expected InvalidUrl for {url}, got {other:?}"),
            }
        }
    }
}
