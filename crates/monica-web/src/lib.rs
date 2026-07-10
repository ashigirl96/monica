use std::net::SocketAddr;

use anyhow::Result;
use oxhttp::model::{Body, Response, Status};
use oxhttp::Server;

pub fn serve(addr: impl Into<SocketAddr>) -> Result<()> {
    let mut addr = addr.into();
    if addr.port() == 0 {
        let listener = std::net::TcpListener::bind(addr)?;
        addr.set_port(listener.local_addr()?.port());
        drop(listener);
    }

    log::info!(target: "monica_web", "listening on http://{addr}");

    let server = Server::new(|_request| {
        Response::builder(Status::OK)
            .with_body(Body::from("Hello from Monica"))
    })
        .bind(addr);

    server.spawn()?.join()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxhttp::model::{Method, Request};
    use oxhttp::Client;

    #[test]
    fn root_returns_hello() {
        let port = {
            let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            listener.local_addr().unwrap().port()
        };

        std::thread::spawn(move || {
            serve(([127, 0, 0, 1], port)).unwrap();
        });

        let client = Client::new();
        let url = format!("http://127.0.0.1:{port}/");
        let mut response = None;
        for _ in 0..50 {
            match client.request(Request::builder(Method::GET, url.parse().unwrap()).build()) {
                Ok(r) => {
                    response = Some(r);
                    break;
                }
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(10)),
            }
        }
        let response = response.expect("server did not start within 500ms");

        assert_eq!(response.status(), Status::OK);
        let body = response.into_body().to_string().unwrap();
        assert!(body.contains("Hello from Monica"), "body was: {body}");
    }
}
