use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::Result;
use oxhttp::model::{Method, Request, Response};
use oxhttp::Server;

mod explanations;
mod response;

use explanations::{ExplanationSource, RuntimeExplanationSource};

pub fn serve(addr: impl Into<SocketAddr>) -> Result<()> {
    let mut addr = addr.into();
    if addr.port() == 0 {
        let listener = std::net::TcpListener::bind(addr)?;
        addr.set_port(listener.local_addr()?.port());
        drop(listener);
    }

    log::info!(target: "monica_web", "listening on http://{addr}");

    let server = Server::new(handle_request).bind(addr);

    server.spawn()?.join()?;
    Ok(())
}

fn handle_request(request: &mut Request) -> Response {
    handle_request_with(
        request,
        &RuntimeExplanationSource,
        &monica_paths::explanations_dir,
    )
}

fn handle_request_with(
    request: &Request,
    source: &dyn ExplanationSource,
    root: &dyn Fn() -> Result<PathBuf>,
) -> Response {
    if !matches!(request.url().host_str(), Some("127.0.0.1" | "localhost" | "::1")) {
        return response::not_found();
    }

    let route = Route::parse(request.url().path());
    if !matches!(route, Route::NotFound) && request.method() != &Method::GET {
        return response::method_not_allowed();
    }

    match route {
        Route::Root => response::plain_ok("Hello from Monica"),
        Route::ExplanationList => explanations::list(source, root),
        Route::ExplanationDetail(id) => explanations::detail(source, root, id),
        Route::NotFound => response::not_found(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Route<'a> {
    Root,
    ExplanationList,
    ExplanationDetail(&'a str),
    NotFound,
}

impl<'a> Route<'a> {
    fn parse(path: &'a str) -> Self {
        match path {
            "/" => Self::Root,
            "/explanations" => Self::ExplanationList,
            _ => {
                let Some(id) = path.strip_prefix("/explanations/") else {
                    return Self::NotFound;
                };
                if monica_domain::is_safe_explanation_id(id) {
                    Self::ExplanationDetail(id)
                } else {
                    Self::NotFound
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
