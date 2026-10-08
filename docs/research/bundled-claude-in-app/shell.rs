// Shell 役。apps/desktop/src-tauri/src/backend.rs の command() と同じ形で Backend 役を起こす。
// usage: probe-shell --home <dir> [--claude macos|resources] -- <Backend 役に渡す引数...>
// `open` で起こすと env を渡せないので、MONICA_HOME は引数で受ける（本物は env か ~/.monica）。
use std::env;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};

fn json_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let mut home: Option<PathBuf> = None;
    let mut placement = String::from("macos");
    let mut rest: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--home" => {
                home = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--claude" => {
                placement = args[i + 1].clone();
                i += 2;
            }
            "--" => {
                rest = args[i + 1..].to_vec();
                break;
            }
            _ => i += 1,
        }
    }
    let exe = env::current_exe().expect("current_exe is readable");
    let macos = exe.parent().expect("exe has a directory").to_path_buf();
    // 引数を渡せない起こし方（osascript の launch）では、.app の隣の home-launch に書き、env だけを見る。
    let (home, rest) = match home {
        Some(home) => (home, rest),
        None => (
            macos.join("../../../home-launch"),
            vec![String::from("launch"), String::from("env")],
        ),
    };
    std::fs::create_dir_all(&home).expect("home is creatable");
    let claude = match placement.as_str() {
        "resources" => macos.parent().unwrap().join("Resources/claude"),
        _ => macos.join("claude"),
    };

    let mut log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(home.join("shell.jsonl"))
        .expect("shell.jsonl is writable");
    let mut keys: Vec<String> = env::vars_os()
        .map(|(k, _)| k.to_string_lossy().into_owned())
        .collect();
    keys.sort();
    let keys_json: Vec<String> = keys.iter().map(|k| json_string(k)).collect();
    let _ = writeln!(
        log,
        "{{\"event\":\"shell-start\",\"pid\":{},\"ppid\":{},\"exe\":{},\"claude\":{},\"PATH\":{},\"envKeys\":[{}]}}",
        std::process::id(),
        std::os::unix::process::parent_id(),
        json_string(&exe.to_string_lossy()),
        json_string(&claude.to_string_lossy()),
        json_string(&env::var("PATH").unwrap_or_default()),
        keys_json.join(",")
    );

    let mut command = Command::new(macos.join("monica-backend"));
    command
        .args(&rest)
        .env("MONICA_HOME", &home)
        .env("MONICA_PTYD_PATH", macos.join("monica-ptyd"))
        .env("MONICA_NOTES_PORT", "19380")
        // 実装で Shell が足す想定の env。ptyd の MONICA_PTYD_PATH と同じ形（ADR-0032）。
        .env("MONICA_CLAUDE_PATH", &claude)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = writeln!(
                log,
                "{{\"event\":\"backend-spawn-failed\",\"error\":{}}}",
                json_string(&error.to_string())
            );
            return;
        }
    };
    let _ = writeln!(log, "{{\"event\":\"backend-spawned\",\"pid\":{}}}", child.id());
    // 本物の Shell と同じく write 側を握ったまま何も書かない。
    let _stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("stdout is piped");
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let _ = writeln!(log, "{{\"event\":\"backend-stdout\",\"line\":{}}}", json_string(&line));
    }
    let status = child.wait();
    let _ = writeln!(
        log,
        "{{\"event\":\"backend-exited\",\"status\":{}}}",
        json_string(&format!("{status:?}"))
    );
}
