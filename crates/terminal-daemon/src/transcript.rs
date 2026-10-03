//! Bounded per-session output capture: raw PTY bytes appended to `<dir>/<id>.log`, rotated
//! once into `<id>.log.1` at the size cap. Disk usage stays ≤ 2 × ROTATE_BYTES per session
//! no matter how much a detached process prints; attach replays the combined tail.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

const ROTATE_BYTES: u64 = 1024 * 1024;

pub struct Transcript {
    path: PathBuf,
    rotated_path: PathBuf,
    file: File,
    len: u64,
    rotate_bytes: u64,
}

impl Transcript {
    pub fn open(dir: &Path, session_id: &str) -> Result<Self> {
        Self::open_with_limit(dir, session_id, ROTATE_BYTES)
    }

    fn open_with_limit(dir: &Path, session_id: &str, rotate_bytes: u64) -> Result<Self> {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("failed to create {}", dir.display()))?;
        let path = dir.join(format!("{session_id}.log"));
        let rotated_path = dir.join(format!("{session_id}.log.1"));
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .with_context(|| format!("failed to open {}", path.display()))?;
        let len = file.metadata()?.len();
        Ok(Self {
            path,
            rotated_path,
            file,
            len,
            rotate_bytes,
        })
    }

    pub fn append(&mut self, bytes: &[u8]) -> Result<()> {
        self.file.write_all(bytes)?;
        self.len += bytes.len() as u64;
        if self.len >= self.rotate_bytes {
            self.file.flush()?;
            std::fs::rename(&self.path, &self.rotated_path)?;
            self.file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)?;
            self.len = 0;
        }
        Ok(())
    }

    /// The last `max_bytes` of output across the rotated and current files. May start
    /// mid-escape-sequence; replay consumers accept a possibly mangled first row.
    pub fn tail(&mut self, max_bytes: usize) -> Result<Vec<u8>> {
        self.file.flush()?;
        let mut combined = Vec::new();
        if self.len < max_bytes as u64 {
            if let Ok(mut rotated) = File::open(&self.rotated_path) {
                let want = max_bytes as u64 - self.len;
                let rotated_len = rotated.metadata()?.len();
                if rotated_len > want {
                    rotated.seek(SeekFrom::Start(rotated_len - want))?;
                }
                rotated.read_to_end(&mut combined)?;
            }
        }
        let mut current = File::open(&self.path)?;
        if self.len > max_bytes as u64 {
            current.seek(SeekFrom::Start(self.len - max_bytes as u64))?;
        }
        current.read_to_end(&mut combined)?;
        if combined.len() > max_bytes {
            combined.drain(..combined.len() - max_bytes);
        }
        Ok(combined)
    }

    /// Delete both transcript files (used when a session is reaped).
    pub fn remove_files(dir: &Path, session_id: &str) {
        let _ = std::fs::remove_file(dir.join(format!("{session_id}.log")));
        let _ = std::fs::remove_file(dir.join(format!("{session_id}.log.1")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "monica-transcript-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn append_and_tail_within_one_file() {
        let dir = temp_dir("plain");
        let mut t = Transcript::open_with_limit(&dir, "ts-1", 1024).unwrap();
        t.append(b"hello ").unwrap();
        t.append(b"world").unwrap();

        assert_eq!(t.tail(1024).unwrap(), b"hello world");
        assert_eq!(t.tail(5).unwrap(), b"world");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rotation_keeps_disk_bounded_and_tail_spans_files() {
        let dir = temp_dir("rotate");
        let mut t = Transcript::open_with_limit(&dir, "ts-1", 16).unwrap();
        t.append(b"0123456789abcdef").unwrap(); // hits the cap → rotates
        t.append(b"GHIJ").unwrap();

        assert!(dir.join("ts-1.log.1").exists());
        assert_eq!(t.tail(8).unwrap(), b"cdefGHIJ");
        assert_eq!(t.tail(100).unwrap(), b"0123456789abcdefGHIJ");

        // A second rotation overwrites the previous .log.1: total disk stays ≤ 2 files.
        t.append(b"KLMNOPQRSTUVWXYZ").unwrap();
        assert_eq!(std::fs::read(dir.join("ts-1.log.1")).unwrap(), b"GHIJKLMNOPQRSTUVWXYZ");
        assert_eq!(t.tail(100).unwrap(), b"GHIJKLMNOPQRSTUVWXYZ");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tiny_tail_trims_combined_read_to_max_bytes() {
        let dir = temp_dir("tiny");
        let mut t = Transcript::open_with_limit(&dir, "ts-1", 4).unwrap();
        t.append(b"12345").unwrap(); // rotated into .log.1
        t.append(b"6").unwrap();

        assert_eq!(t.tail(1).unwrap(), b"6");
        assert_eq!(t.tail(3).unwrap(), b"456");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reopen_resumes_existing_log() {
        let dir = temp_dir("reopen");
        {
            let mut t = Transcript::open_with_limit(&dir, "ts-1", 1024).unwrap();
            t.append(b"before").unwrap();
        }
        let mut t = Transcript::open_with_limit(&dir, "ts-1", 1024).unwrap();
        t.append(b" after").unwrap();
        assert_eq!(t.tail(1024).unwrap(), b"before after");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn remove_files_deletes_both() {
        let dir = temp_dir("remove");
        let mut t = Transcript::open_with_limit(&dir, "ts-1", 4).unwrap();
        t.append(b"12345").unwrap(); // rotated
        t.append(b"6").unwrap();
        drop(t);
        Transcript::remove_files(&dir, "ts-1");
        assert!(!dir.join("ts-1.log").exists());
        assert!(!dir.join("ts-1.log.1").exists());
        std::fs::remove_dir_all(&dir).ok();
    }
}
