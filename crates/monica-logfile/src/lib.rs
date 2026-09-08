//! Daily-rotated append-only debug logs: `<dir>/<stem>_<YYYY-MM-DD>.log`, keyed on the local date.
//!
//! Retention is by age, not by disk size: a size cap loses history in bursts (the tauri-plugin-log
//! `monica.log` target burned all 5 of its generations in a single day), and these logs are read
//! days after the failure they recorded. A total-size cap survives only as a safety valve.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use chrono::{DateTime, Days, Local, NaiveDate};

const RETENTION_DAYS: u64 = 14;
const MAX_TOTAL_BYTES: u64 = 50 * 1024 * 1024;
const SUFFIX: &str = ".log";
const DAY_FORMAT: &str = "%Y-%m-%d";

pub struct DailyLog {
    dir: PathBuf,
    stem: String,
    retention_days: u64,
    max_total_bytes: u64,
    open_day: Mutex<OpenDay>,
}

struct OpenDay {
    day: NaiveDate,
    file: File,
}

impl DailyLog {
    /// Opens today's file and runs housekeeping. The value is meant to be held for the life of
    /// the process: it re-resolves the day on every append, so a daemon that outlives local
    /// midnight keeps landing in the right file without reopening.
    pub fn open(dir: &Path, stem: &str) -> Result<Self> {
        Self::open_with_policy(
            dir,
            stem,
            Local::now().date_naive(),
            RETENTION_DAYS,
            MAX_TOTAL_BYTES,
        )
    }

    fn open_with_policy(
        dir: &Path,
        stem: &str,
        today: NaiveDate,
        retention_days: u64,
        max_total_bytes: u64,
    ) -> Result<Self> {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("failed to create {}", dir.display()))?;
        migrate_legacy(dir, stem, legacy_day(dir, stem, today));
        sweep(dir, stem, today, retention_days, max_total_bytes);
        let file = open_day_file(dir, stem, today)?;
        Ok(Self {
            dir: dir.to_path_buf(),
            stem: stem.to_string(),
            retention_days,
            max_total_bytes,
            open_day: Mutex::new(OpenDay { day: today, file }),
        })
    }

    /// Appends `line` plus a newline. Best-effort: a logging failure must never surface to the
    /// caller.
    pub fn append(&self, line: &str) {
        self.append_on(Local::now().date_naive(), line);
    }

    fn append_on(&self, today: NaiveDate, line: &str) {
        let Ok(mut open_day) = self.open_day.lock() else {
            return;
        };
        if open_day.day != today {
            sweep(
                &self.dir,
                &self.stem,
                today,
                self.retention_days,
                self.max_total_bytes,
            );
            // Keeping the stale handle beats dropping the line when the new day cannot be opened.
            if let Ok(file) = open_day_file(&self.dir, &self.stem, today) {
                *open_day = OpenDay { day: today, file };
            }
        }
        // One `write_all` so concurrent processes appending to the same file interleave whole
        // lines rather than fragments.
        let mut buf = String::with_capacity(line.len() + 1);
        buf.push_str(line);
        buf.push('\n');
        let _ = (&open_day.file).write_all(buf.as_bytes());
    }
}

fn open_day_file(dir: &Path, stem: &str, day: NaiveDate) -> Result<File> {
    let path = day_path(dir, stem, day);
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .with_context(|| format!("failed to open {}", path.display()))
}

fn day_path(dir: &Path, stem: &str, day: NaiveDate) -> PathBuf {
    dir.join(format!("{stem}_{}{SUFFIX}", day.format(DAY_FORMAT)))
}

fn legacy_path(dir: &Path, stem: &str) -> PathBuf {
    dir.join(format!("{stem}{SUFFIX}"))
}

/// `Some` only for `<stem>_<YYYY-MM-DD>.log`. Everything else — other stems, the undated legacy
/// file, `.bak` copies, unparseable dates — yields `None` and is never touched by `sweep`.
fn parse_day(name: &str, stem: &str) -> Option<NaiveDate> {
    let rest = name.strip_prefix(stem)?.strip_prefix('_')?;
    NaiveDate::parse_from_str(rest.strip_suffix(SUFFIX)?, DAY_FORMAT).ok()
}

/// The day the pre-rotation `<stem>.log` belongs to, from its mtime. Falls back to `today` when
/// the mtime is unreadable, so the file still joins the rotation instead of growing forever.
fn legacy_day(dir: &Path, stem: &str, today: NaiveDate) -> NaiveDate {
    std::fs::metadata(legacy_path(dir, stem))
        .and_then(|meta| meta.modified())
        .map(|mtime| DateTime::<Local>::from(mtime).date_naive())
        .unwrap_or(today)
}

fn migrate_legacy(dir: &Path, stem: &str, day: NaiveDate) {
    let legacy = legacy_path(dir, stem);
    if !legacy.exists() {
        return;
    }
    let target = day_path(dir, stem, day);
    if target.exists() {
        // Renaming would clobber a day we already rotated; keeping both loses nothing.
        return;
    }
    let _ = std::fs::rename(&legacy, &target);
}

fn sweep(dir: &Path, stem: &str, today: NaiveDate, retention_days: u64, max_total_bytes: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let cutoff = today.checked_sub_days(Days::new(retention_days));
    let mut kept: Vec<(NaiveDate, PathBuf, u64)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(day) = name.to_str().and_then(|name| parse_day(name, stem)) else {
            continue;
        };
        if cutoff.is_some_and(|cutoff| day < cutoff) {
            let _ = std::fs::remove_file(entry.path());
            continue;
        }
        // A file whose size is unreadable is left out of the total and out of the candidates.
        let Ok(size) = entry.metadata().map(|meta| meta.len()) else {
            continue;
        };
        kept.push((day, entry.path(), size));
    }

    let mut total: u64 = kept.iter().map(|(_, _, size)| size).sum();
    if total <= max_total_bytes {
        return;
    }
    kept.sort_by_key(|(day, _, _)| *day);
    for (day, path, size) in &kept {
        if total <= max_total_bytes {
            break;
        }
        // Today and anything dated later are being written right now — a file can be dated ahead
        // of this process when the clock or zone moves back, or when a sweep that captured
        // yesterday runs after another process opened today. Unlinking one cannot free enough to
        // satisfy the cap anyway, since the current day always stays.
        if *day >= today {
            continue;
        }
        if std::fs::remove_file(path).is_ok() {
            total -= size;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STEM: &str = "hook-claude";
    const NO_CAP: u64 = u64::MAX;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "monica-logfile-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn day(year: i32, month: u32, date: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(year, month, date).expect("valid date")
    }

    fn write(dir: &Path, name: &str, bytes: &[u8]) {
        std::fs::create_dir_all(dir).expect("create dir");
        std::fs::write(dir.join(name), bytes).expect("write");
    }

    #[test]
    fn append_writes_to_todays_file_creating_the_dir() {
        let dir = temp_dir("append");
        let today = day(2026, 9, 9);
        let log =
            DailyLog::open_with_policy(&dir, STEM, today, RETENTION_DAYS, NO_CAP).unwrap();
        log.append_on(today, "first");
        log.append_on(today, "second");

        let body = std::fs::read_to_string(dir.join("hook-claude_2026-09-09.log")).unwrap();
        assert_eq!(body, "first\nsecond\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn append_rolls_over_when_the_local_date_changes() {
        let dir = temp_dir("rollover");
        // today - 14 on the 9th, so it survives the open and falls out of retention on the 10th.
        write(&dir, "hook-claude_2026-08-26.log", b"cutoff day");
        let log = DailyLog::open_with_policy(&dir, STEM, day(2026, 9, 9), RETENTION_DAYS, NO_CAP)
            .unwrap();

        log.append_on(day(2026, 9, 9), "ninth");
        log.append_on(day(2026, 9, 10), "tenth");

        assert_eq!(
            std::fs::read_to_string(dir.join("hook-claude_2026-09-09.log")).unwrap(),
            "ninth\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("hook-claude_2026-09-10.log")).unwrap(),
            "tenth\n"
        );
        assert!(
            !dir.join("hook-claude_2026-08-26.log").exists(),
            "housekeeping must run again on the new day"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn retention_deletes_only_days_older_than_cutoff() {
        let dir = temp_dir("retention");
        write(&dir, "hook-claude_2026-08-26.log", b"cutoff day"); // today - 14
        write(&dir, "hook-claude_2026-08-25.log", b"one day older");

        DailyLog::open_with_policy(&dir, STEM, day(2026, 9, 9), RETENTION_DAYS, NO_CAP).unwrap();

        assert!(dir.join("hook-claude_2026-08-26.log").exists());
        assert!(!dir.join("hook-claude_2026-08-25.log").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unknown_files_are_never_touched() {
        let dir = temp_dir("unknown");
        let survivors = [
            "monica.log",
            "hook-claude.log.bak",
            "hook-claude_notadate.log",
            "hook-claude_2026-01-01.log.gz",
            "hook-codex_2026-01-01.log",
        ];
        for name in survivors {
            write(&dir, name, b"x");
        }

        DailyLog::open_with_policy(&dir, STEM, day(2026, 9, 9), RETENTION_DAYS, 0).unwrap();

        for name in survivors {
            assert!(dir.join(name).exists(), "{name} must survive");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn total_size_cap_deletes_oldest_days_first() {
        let dir = temp_dir("size-cap");
        write(&dir, "hook-claude_2026-09-07.log", b"0123456789");
        write(&dir, "hook-claude_2026-09-08.log", b"0123456789");
        write(&dir, "hook-claude_2026-09-09.log", b"0123456789");

        DailyLog::open_with_policy(&dir, STEM, day(2026, 9, 9), RETENTION_DAYS, 15).unwrap();

        assert!(!dir.join("hook-claude_2026-09-07.log").exists());
        assert!(!dir.join("hook-claude_2026-09-08.log").exists());
        assert!(dir.join("hook-claude_2026-09-09.log").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn future_dated_files_survive_the_cap() {
        let dir = temp_dir("size-cap-future");
        write(&dir, "hook-claude_2026-09-08.log", b"0123456789");
        write(&dir, "hook-claude_2026-09-10.log", b"0123456789"); // another process' day

        DailyLog::open_with_policy(&dir, STEM, day(2026, 9, 9), RETENTION_DAYS, 1).unwrap();

        assert!(!dir.join("hook-claude_2026-09-08.log").exists());
        assert_eq!(
            std::fs::read(dir.join("hook-claude_2026-09-10.log")).unwrap(),
            b"0123456789"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn todays_file_survives_the_cap_on_its_own() {
        let dir = temp_dir("size-cap-today");
        write(&dir, "hook-claude_2026-09-09.log", b"0123456789");

        DailyLog::open_with_policy(&dir, STEM, day(2026, 9, 9), RETENTION_DAYS, 1).unwrap();

        assert_eq!(
            std::fs::read(dir.join("hook-claude_2026-09-09.log")).unwrap(),
            b"0123456789"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn legacy_file_is_renamed_to_the_given_day() {
        let dir = temp_dir("legacy");
        write(&dir, "hook-claude.log", b"before rotation\n");

        migrate_legacy(&dir, STEM, day(2026, 9, 9));

        assert!(!dir.join("hook-claude.log").exists());
        assert_eq!(
            std::fs::read(dir.join("hook-claude_2026-09-09.log")).unwrap(),
            b"before rotation\n"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn legacy_file_is_left_alone_when_the_dated_file_exists() {
        let dir = temp_dir("legacy-conflict");
        write(&dir, "hook-claude.log", b"legacy");
        write(&dir, "hook-claude_2026-09-09.log", b"dated");

        migrate_legacy(&dir, STEM, day(2026, 9, 9));

        assert_eq!(std::fs::read(dir.join("hook-claude.log")).unwrap(), b"legacy");
        assert_eq!(
            std::fs::read(dir.join("hook-claude_2026-09-09.log")).unwrap(),
            b"dated"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Covers the mtime → local-date resolution that the `migrate_legacy` tests inject past. The
    /// assertion avoids naming the target day so a run crossing local midnight cannot flake.
    #[test]
    fn open_folds_the_legacy_file_into_the_rotation() {
        let dir = temp_dir("legacy-open");
        write(&dir, "hook-claude.log", b"before rotation\n");

        let log = DailyLog::open_with_policy(
            &dir,
            STEM,
            Local::now().date_naive(),
            RETENTION_DAYS,
            NO_CAP,
        )
        .unwrap();
        log.append("after rotation");

        assert!(!dir.join("hook-claude.log").exists());
        let rotated = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|entry| {
                let name = entry.file_name();
                name.to_str()
                    .and_then(|name| parse_day(name, STEM))
                    .is_some()
            })
            .any(|entry| {
                std::fs::read_to_string(entry.path())
                    .unwrap_or_default()
                    .contains("before rotation")
            });
        assert!(rotated, "legacy content must land in a dated file");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The public entry point, so the real clock and the policy constants are wired at least
    /// once. Asserts on the shape rather than on a named day to stay stable across midnight.
    #[test]
    fn open_writes_a_single_dated_file() {
        let dir = temp_dir("open");
        let log = DailyLog::open(&dir, STEM).unwrap();
        log.append("line");

        let dated: Vec<PathBuf> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|entry| {
                let name = entry.file_name();
                name.to_str()
                    .and_then(|name| parse_day(name, STEM))
                    .is_some()
            })
            .map(|entry| entry.path())
            .collect();
        assert_eq!(dated.len(), 1, "expected one dated file, got {dated:?}");
        assert_eq!(std::fs::read_to_string(&dated[0]).unwrap(), "line\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sweep_tolerates_a_missing_dir() {
        let dir = temp_dir("missing");
        sweep(&dir, STEM, day(2026, 9, 9), RETENTION_DAYS, 0);
        assert!(!dir.exists());
    }
}
