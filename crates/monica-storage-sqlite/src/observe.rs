//! Connection-level observability. SQLite hands both callbacks a bare `fn` pointer, so every
//! tunable lives in a `const` here rather than on the store.

use std::time::Duration;

use rusqlite::trace::TraceEvent;

pub(crate) const TARGET_MIGRATIONS: &str = "monica_storage_sqlite::migrations";
pub(crate) const TARGET_QUERY: &str = "monica_storage_sqlite::query";
pub(crate) const TARGET_BUSY: &str = "monica_storage_sqlite::busy";
pub(crate) const TARGET_TX: &str = "monica_storage_sqlite::tx";

const SLOW_QUERY_MS: u128 = 100;
const SQL_PREVIEW_CHARS: usize = 200;

pub(crate) const BUSY_TIMEOUT_MS: u64 = 5_000;

pub(crate) fn on_trace(event: TraceEvent<'_>) {
    let TraceEvent::Profile(stmt, duration) = event else {
        return;
    };
    if !is_slow(duration) {
        return;
    }
    log::warn!(target: TARGET_QUERY, "{}", slow_query_line(duration, &stmt.sql()));
}

pub(crate) fn on_busy(count: i32) -> bool {
    match busy_decision(count, BUSY_TIMEOUT_MS) {
        BusyDecision::Sleep { waited_ms, sleep_ms } => {
            log::debug!(target: TARGET_BUSY, "sqlite busy retry={count} waited_ms={waited_ms} sleep_ms={sleep_ms}");
            std::thread::sleep(Duration::from_millis(sleep_ms));
            true
        }
        BusyDecision::GiveUp { waited_ms } => {
            log::debug!(target: TARGET_BUSY, "sqlite busy gave up retries={count} waited_ms={waited_ms}");
            false
        }
    }
}

fn is_slow(duration: Duration) -> bool {
    duration.as_millis() >= SLOW_QUERY_MS
}

/// `sql` comes from `sqlite3_sql`, which leaves placeholders unexpanded — bind values never reach
/// the log. Whitespace is collapsed so one statement stays one greppable line.
fn slow_query_line(duration: Duration, sql: &str) -> String {
    format!(
        "slow query duration_ms={} sql={}",
        duration.as_millis(),
        sql_preview(sql)
    )
}

fn sql_preview(sql: &str) -> String {
    let mut preview = String::with_capacity(sql.len());
    let mut pending_space = false;
    for ch in sql.trim().chars() {
        if ch.is_whitespace() {
            pending_space = true;
            continue;
        }
        if pending_space {
            preview.push(' ');
            pending_space = false;
        }
        preview.push(ch);
    }
    if let Some((boundary, _)) = preview.char_indices().nth(SQL_PREVIEW_CHARS) {
        preview.truncate(boundary);
        preview.push('…');
    }
    preview
}

#[derive(Debug, PartialEq, Eq)]
enum BusyDecision {
    Sleep { waited_ms: u64, sleep_ms: u64 },
    GiveUp { waited_ms: u64 },
}

/// SQLite's own `sqliteDefaultBusyCallback` schedule, reproduced verbatim. Registering a busy
/// handler replaces the one `busy_timeout` installs, so the wait behaviour is only unchanged as
/// long as these tables and the clamp match upstream.
const BUSY_DELAYS_MS: [u64; 12] = [1, 2, 5, 10, 15, 20, 25, 25, 25, 50, 50, 100];
const BUSY_TOTALS_MS: [u64; 12] = [0, 1, 3, 8, 18, 33, 53, 78, 103, 128, 178, 228];

fn busy_decision(count: i32, timeout_ms: u64) -> BusyDecision {
    let count = u64::try_from(count).unwrap_or(0);
    let last = BUSY_DELAYS_MS.len() as u64 - 1;
    let (mut sleep_ms, waited_ms) = if count <= last {
        let i = count as usize;
        (BUSY_DELAYS_MS[i], BUSY_TOTALS_MS[i])
    } else {
        let tail = BUSY_DELAYS_MS[last as usize];
        (
            tail,
            BUSY_TOTALS_MS[last as usize] + tail.saturating_mul(count - last),
        )
    };
    if waited_ms + sleep_ms > timeout_ms {
        if waited_ms >= timeout_ms {
            return BusyDecision::GiveUp { waited_ms };
        }
        sleep_ms = timeout_ms - waited_ms;
    }
    BusyDecision::Sleep {
        waited_ms,
        sleep_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slow_query_is_gated_on_the_threshold() {
        assert!(!is_slow(Duration::from_millis(SLOW_QUERY_MS as u64 - 1)));
        assert!(is_slow(Duration::from_millis(SLOW_QUERY_MS as u64)));
        assert!(is_slow(Duration::from_secs(3)));
    }

    #[test]
    fn slow_query_line_carries_duration_and_sql() {
        let line = slow_query_line(Duration::from_millis(142), "SELECT 1");
        assert_eq!(line, "slow query duration_ms=142 sql=SELECT 1");
    }

    #[test]
    fn sql_preview_collapses_a_multiline_statement_into_one_line() {
        let preview = sql_preview(
            r#"
            SELECT id
              FROM tasks
             WHERE status = ?1
            "#,
        );
        assert_eq!(preview, "SELECT id FROM tasks WHERE status = ?1");
    }

    #[test]
    fn sql_preview_truncates_on_a_char_boundary() {
        let sql = "あ".repeat(SQL_PREVIEW_CHARS + 50);
        let preview = sql_preview(&sql);
        assert_eq!(preview.chars().count(), SQL_PREVIEW_CHARS + 1);
        assert!(preview.ends_with('…'));
    }

    #[test]
    fn sql_preview_keeps_a_statement_that_fits() {
        let sql = "x".repeat(SQL_PREVIEW_CHARS);
        assert_eq!(sql_preview(&sql), sql);
    }

    #[test]
    fn busy_decision_matches_the_sqlite_default_schedule() {
        let schedule = BUSY_DELAYS_MS.iter().zip(&BUSY_TOTALS_MS);
        for (count, (&sleep_ms, &waited_ms)) in schedule.enumerate() {
            assert_eq!(
                busy_decision(count as i32, BUSY_TIMEOUT_MS),
                BusyDecision::Sleep {
                    waited_ms,
                    sleep_ms
                },
                "count={count}"
            );
        }
    }

    #[test]
    fn busy_decision_repeats_the_last_delay_past_the_table() {
        assert_eq!(
            busy_decision(12, BUSY_TIMEOUT_MS),
            BusyDecision::Sleep {
                waited_ms: 328,
                sleep_ms: 100
            }
        );
        assert_eq!(
            busy_decision(14, BUSY_TIMEOUT_MS),
            BusyDecision::Sleep {
                waited_ms: 528,
                sleep_ms: 100
            }
        );
    }

    #[test]
    fn busy_decision_clamps_the_last_sleep_to_the_remaining_timeout() {
        assert_eq!(
            busy_decision(3, 10),
            BusyDecision::Sleep {
                waited_ms: 8,
                sleep_ms: 2
            }
        );
    }

    #[test]
    fn busy_decision_gives_up_once_the_timeout_is_spent() {
        assert_eq!(busy_decision(3, 8), BusyDecision::GiveUp { waited_ms: 8 });
        assert_eq!(busy_decision(0, 0), BusyDecision::GiveUp { waited_ms: 0 });
    }
}
