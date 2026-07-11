use std::fs::File;

use oxhttp::model::{Body, HeaderName, Response, Status};

const HTML_CONTENT_TYPE: &str = "text/html; charset=utf-8";
const TEXT_CONTENT_TYPE: &str = "text/plain; charset=utf-8";

pub(super) fn plain_ok(body: &'static str) -> Response {
    build(Status::OK, TEXT_CONTENT_TYPE, body)
}

pub(super) fn html(body: String) -> Response {
    build(Status::OK, HTML_CONTENT_TYPE, body)
}

pub(super) fn html_file(file: File) -> Response {
    build(Status::OK, HTML_CONTENT_TYPE, Body::from_read(file))
}

pub(super) fn not_found() -> Response {
    build(Status::NOT_FOUND, TEXT_CONTENT_TYPE, "Not found")
}

pub(super) fn internal_error() -> Response {
    build(
        Status::INTERNAL_SERVER_ERROR,
        TEXT_CONTENT_TYPE,
        "Internal server error",
    )
}

pub(super) fn method_not_allowed() -> Response {
    let mut response = build(
        Status::METHOD_NOT_ALLOWED,
        TEXT_CONTENT_TYPE,
        "Method not allowed",
    );
    response
        .append_header(HeaderName::ALLOW, "GET")
        .expect("static Allow header must be valid");
    response
}

fn build(status: Status, content_type: &'static str, body: impl Into<Body>) -> Response {
    Response::builder(status)
        .with_header(HeaderName::CONTENT_TYPE, content_type)
        .expect("static Content-Type header must be valid")
        .with_header("Cache-Control", "no-store")
        .expect("static Cache-Control header must be valid")
        .with_header("X-Content-Type-Options", "nosniff")
        .expect("static X-Content-Type-Options header must be valid")
        .with_body(body)
}
