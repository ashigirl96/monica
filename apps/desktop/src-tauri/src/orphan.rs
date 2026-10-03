use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::STOP_GRACE;

#[derive(Deserialize)]
struct BackendJson {
    port: u16,
    pid: i32,
}

#[derive(Deserialize)]
struct Health {
    pid: i32,
}

/// app が `RunEvent::Exit` を踏まずに死んだときに残った Backend を止める。
/// pid だけで決めないのは、死んだ Backend の pid が別の process に再利用されていることがあるため。
pub fn stop(home: &Path) {
    let Some(published) = std::fs::read_to_string(home.join("backend.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<BackendJson>(&text).ok())
    else {
        return;
    };
    if !is_alive(published.pid) || health_pid(published.port) != Some(published.pid) {
        return;
    }
    eprintln!("[shell] stopping the orphaned Backend (pid {})", published.pid);
    // SAFETY: kill(2) は pid と signal の値を渡すだけで、メモリには触らない。
    unsafe { libc::kill(published.pid, libc::SIGTERM) };
    if !exits_within(published.pid, STOP_GRACE) {
        unsafe { libc::kill(published.pid, libc::SIGKILL) };
        exits_within(published.pid, STOP_GRACE);
    }
}

fn is_alive(pid: i32) -> bool {
    // SAFETY: signal 0 は存在と権限を確かめるだけで、何も送らない。
    let found = unsafe { libc::kill(pid, 0) } == 0;
    found || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn exits_within(pid: i32, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if !is_alive(pid) {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    false
}

fn health_pid(port: u16) -> Option<i32> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(500)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(1))).ok()?;
    let request = format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    let (_, body) = response.split_once("\r\n\r\n")?;
    serde_json::from_str::<Health>(body).ok().map(|health| health.pid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::os::unix::process::ExitStatusExt;
    use std::path::PathBuf;
    use std::process::{Child, Command};
    use std::thread;

    fn home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tania-orphan-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sleeper() -> Child {
        Command::new("sleep").arg("30").spawn().unwrap()
    }

    fn serve_health(pid: u32) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            // 要求を読み切らずに閉じると RST になり、client は応答を読めない。
            let mut request = Vec::new();
            let mut chunk = [0; 256];
            while !request.ends_with(b"\r\n\r\n") {
                let n = stream.read(&mut chunk).unwrap();
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..n]);
            }
            let body = format!(r#"{{"name":"tania-backend","pid":{pid},"startedAt":"2026-10-03T00:00:00.000Z"}}"#);
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len(),
            );
        });
        port
    }

    fn publish(home: &Path, port: u16, pid: u32) {
        std::fs::write(
            home.join("backend.json"),
            format!(r#"{{"port":{port},"token":"t","pid":{pid},"startedAt":"2026-10-03T00:00:00.000Z"}}"#),
        )
        .unwrap();
    }

    #[test]
    fn stops_the_backend_that_backend_json_and_health_agree_on() {
        let home = home("agree");
        let child = sleeper();
        let pid = child.id();
        publish(&home, serve_health(pid), pid);
        let waiter = thread::spawn(move || {
            let mut child = child;
            child.wait().unwrap()
        });

        stop(&home);

        assert_eq!(waiter.join().unwrap().signal(), Some(libc::SIGTERM));
    }

    #[test]
    fn spares_a_process_that_health_does_not_vouch_for() {
        let home = home("disagree");
        let mut child = sleeper();
        let pid = child.id();
        publish(&home, serve_health(pid + 1), pid);

        stop(&home);

        let still_running = child.try_wait().unwrap().is_none();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(still_running);
    }
}
