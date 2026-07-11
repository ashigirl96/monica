use std::fmt::Write as _;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

use anyhow::Result;
use monica_application::{ApplicationEvent, EventSink};
use monica_domain::{Explanation, is_safe_explanation_id};
use oxhttp::model::Response;

use crate::response;

pub(crate) trait ExplanationSource {
    fn list_explanations(&self) -> Result<Vec<Explanation>>;
    fn get_explanation(&self, id: &str) -> Result<Option<Explanation>>;
}

pub(crate) struct RuntimeExplanationSource;

impl ExplanationSource for RuntimeExplanationSource {
    fn list_explanations(&self) -> Result<Vec<Explanation>> {
        let mut monica = monica_runtime::open_monica(Box::new(SilentEventSink))?;
        Ok(monica.explanations().list_explanations()?)
    }

    fn get_explanation(&self, id: &str) -> Result<Option<Explanation>> {
        let mut monica = monica_runtime::open_monica(Box::new(SilentEventSink))?;
        Ok(monica.explanations().get_explanation(id)?)
    }
}

struct SilentEventSink;

impl EventSink for SilentEventSink {
    fn emit(&self, _event: ApplicationEvent) {}
}

pub(super) fn list(
    source: &dyn ExplanationSource,
    root: &dyn Fn() -> Result<PathBuf>,
) -> Response {
    let root = match root() {
        Ok(root) => root,
        Err(error) => {
            log::error!(target: "monica_web", "failed to resolve explanations directory: {error:#}");
            return response::internal_error();
        }
    };
    let explanations = match source.list_explanations() {
        Ok(explanations) => explanations,
        Err(error) => {
            log::error!(target: "monica_web", "failed to list explanations: {error:#}");
            return response::internal_error();
        }
    };
    match render_list(&root, &explanations) {
        Ok(html) => response::html(html),
        Err(ArtifactError::Io(error)) => {
            log::error!(target: "monica_web", "failed to inspect explanation artifacts: {error}");
            response::internal_error()
        }
        Err(ArtifactError::NotFound | ArtifactError::Unsafe) => {
            unreachable!("render_list handles unavailable artifacts per row")
        }
    }
}

pub(super) fn detail(
    source: &dyn ExplanationSource,
    root: &dyn Fn() -> Result<PathBuf>,
    id: &str,
) -> Response {
    let explanation = match source.get_explanation(id) {
        Ok(Some(explanation)) => explanation,
        Ok(None) => return response::not_found(),
        Err(error) => {
            log::error!(target: "monica_web", "failed to get explanation {id}: {error:#}");
            return response::internal_error();
        }
    };

    let root = match root() {
        Ok(root) => root,
        Err(error) => {
            log::error!(target: "monica_web", "failed to resolve explanations directory: {error:#}");
            return response::internal_error();
        }
    };

    match open_index(&root, &explanation) {
        Ok(file) => response::html_file(file),
        Err(ArtifactError::NotFound | ArtifactError::Unsafe) => {
            log::warn!(target: "monica_web", "explanation artifact is unavailable: {id}");
            response::not_found()
        }
        Err(ArtifactError::Io(error)) => {
            log::error!(target: "monica_web", "failed to open explanation artifact {id}: {error}");
            response::internal_error()
        }
    }
}

fn render_list(root: &Path, explanations: &[Explanation]) -> Result<String, ArtifactError> {
    let mut items = String::new();
    for explanation in explanations {
        if !is_safe_explanation_id(&explanation.id) {
            log::warn!(
                target: "monica_web",
                "omitting explanation with unsafe id from web list"
            );
            continue;
        }
        match open_index(root, explanation) {
            Ok(file) => drop(file),
            Err(ArtifactError::NotFound) => continue,
            Err(ArtifactError::Unsafe) => {
                log::warn!(
                    target: "monica_web",
                    "omitting explanation with unsafe artifact path from web list: {}",
                    explanation.id
                );
                continue;
            }
            Err(error @ ArtifactError::Io(_)) => return Err(error),
        }
        let title = escape_html(&explanation.title);
        let mode = escape_html(explanation.mode.as_str());
        let created_at = escape_html(&explanation.created_at);
        write!(
            items,
            "<li><a href=\"/explanations/{id}\">{title}</a><span>{mode}</span><time datetime=\"{created_at}\">{created_at}</time></li>",
            id = explanation.id,
        )
        .expect("writing to String cannot fail");
    }

    if items.is_empty() {
        items.push_str("<li class=\"empty\">No explanations yet.</li>");
    }

    Ok(format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Explanations · Monica</title><style>{STYLE}</style></head><body><main><header><p>Monica</p><h1>Explanations</h1></header><ol>{items}</ol></main></body></html>"
    ))
}

const STYLE: &str = r#"
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
body { margin: 0; color: CanvasText; background: Canvas; }
main { width: min(760px, calc(100% - 32px)); margin: 64px auto; }
header p { margin: 0; color: GrayText; font-size: 13px; }
h1 { margin: 4px 0 28px; font-size: clamp(28px, 5vw, 42px); letter-spacing: -.03em; }
ol { list-style: none; margin: 0; padding: 0; border-top: 1px solid color-mix(in srgb, CanvasText 14%, transparent); }
li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 18px; align-items: baseline; padding: 16px 0; border-bottom: 1px solid color-mix(in srgb, CanvasText 14%, transparent); }
a { min-width: 0; overflow-wrap: anywhere; color: inherit; font-weight: 600; text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 3px; }
span, time { color: GrayText; font-size: 13px; }
.empty { display: block; color: GrayText; }
@media (max-width: 560px) { main { margin-top: 32px; } li { grid-template-columns: 1fr auto; } time { grid-column: 1 / -1; } }
"#;

fn escape_html(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

fn open_index(root: &Path, explanation: &Explanation) -> Result<File, ArtifactError> {
    let artifact_path = Path::new(&explanation.artifact_path);
    if !artifact_path.is_absolute() || !is_safe_explanation_id(&explanation.id) {
        return Err(ArtifactError::Unsafe);
    }

    let canonical_root = canonicalize(root)?;
    let canonical_expected = canonicalize(&root.join(&explanation.id))?;
    let canonical_artifact = canonicalize(artifact_path)?;
    if !canonical_artifact.starts_with(&canonical_root)
        || canonical_artifact != canonical_expected
    {
        return Err(ArtifactError::Unsafe);
    }

    let canonical_index = canonicalize(&canonical_artifact.join("index.html"))?;
    if !canonical_index.starts_with(&canonical_artifact) {
        return Err(ArtifactError::Unsafe);
    }
    if !canonical_index.metadata().map_err(map_io)?.is_file() {
        return Err(ArtifactError::NotFound);
    }
    File::open(canonical_index).map_err(map_io)
}

#[derive(Debug)]
enum ArtifactError {
    NotFound,
    Unsafe,
    Io(io::Error),
}

fn canonicalize(path: &Path) -> Result<PathBuf, ArtifactError> {
    path.canonicalize().map_err(map_io)
}

fn map_io(error: io::Error) -> ArtifactError {
    if error.kind() == io::ErrorKind::NotFound {
        ArtifactError::NotFound
    } else {
        ArtifactError::Io(error)
    }
}
