//! Repeat suppression for a scheduler that ticks far faster than its failures change.
//!
//! A worker polling every couple of seconds turns one stuck dependency into tens of thousands of
//! identical lines a day, which is how `monica.log`'s five rotation generations were once burned
//! through in ten hours. This tracks the last summary a caller reported and answers whether it is
//! worth saying out loud; the caller keeps ownership of the log level, so the same machine serves
//! ERROR, WARN and INFO call sites.

pub struct TickLog {
    last: Option<String>,
    suppressed: u32,
    heartbeat: u32,
}

impl TickLog {
    /// `every` bounds how many identical ticks may pass before one is reported anyway; `0` never
    /// reports. Total silence after the first line would make a permanently wedged worker
    /// indistinguishable from a healthy one, so a ticking caller should pass a real interval.
    pub fn with_heartbeat(every: u32) -> Self {
        Self { last: None, suppressed: 0, heartbeat: every }
    }

    /// Report this tick's fault summary. `Some(n)` means say it out loud, having swallowed `n`
    /// identical ticks since the last time; `None` means it repeats the previous tick and belongs
    /// at DEBUG. Keep the summary free of values that change every tick (timestamps, durations,
    /// row ids) or nothing will ever dedup.
    pub fn observe(&mut self, summary: &str) -> Option<u32> {
        if self.last.as_deref() == Some(summary) {
            self.suppressed += 1;
            if self.heartbeat == 0 || self.suppressed < self.heartbeat {
                return None;
            }
        } else {
            self.last = Some(summary.to_string());
        }
        Some(std::mem::take(&mut self.suppressed))
    }

    /// The tick came back clean. Forgets the fault history so a later recurrence of the same
    /// summary reads as new rather than as a repeat, and returns how many ticks were suppressed
    /// while faulted so the caller can log the recovery. Emits nothing on its own and does not
    /// advance the heartbeat, which keeps a healthy worker silent.
    pub fn clear(&mut self) -> Option<u32> {
        self.last.take()?;
        Some(std::mem::take(&mut self.suppressed))
    }
}

#[cfg(test)]
mod tests {
    use super::TickLog;

    #[test]
    fn the_first_observation_is_always_loud() {
        let mut tick = TickLog::with_heartbeat(0);
        assert_eq!(tick.observe("boom"), Some(0));
    }

    #[test]
    fn an_identical_summary_repeats() {
        let mut tick = TickLog::with_heartbeat(0);
        tick.observe("boom");
        assert_eq!(tick.observe("boom"), None);
        assert_eq!(tick.observe("boom"), None);
    }

    #[test]
    fn a_changed_summary_reports_what_it_swallowed() {
        let mut tick = TickLog::with_heartbeat(0);
        tick.observe("boom");
        tick.observe("boom");
        tick.observe("boom");
        assert_eq!(tick.observe("other"), Some(2));
    }

    #[test]
    fn alternating_summaries_are_never_suppressed() {
        let mut tick = TickLog::with_heartbeat(0);
        for _ in 0..8 {
            assert_eq!(tick.observe("a"), Some(0));
            assert_eq!(tick.observe("b"), Some(0));
        }
    }

    #[test]
    fn the_heartbeat_breaks_a_long_silence_and_restarts_the_count() {
        let mut tick = TickLog::with_heartbeat(3);
        assert_eq!(tick.observe("boom"), Some(0));
        assert_eq!(tick.observe("boom"), None);
        assert_eq!(tick.observe("boom"), None);
        assert_eq!(tick.observe("boom"), Some(3));
        // The counter restarted, so the next heartbeat is another full interval away.
        assert_eq!(tick.observe("boom"), None);
    }

    #[test]
    fn a_zero_heartbeat_suppresses_forever() {
        let mut tick = TickLog::with_heartbeat(0);
        tick.observe("boom");
        for _ in 0..10_000 {
            assert_eq!(tick.observe("boom"), None);
        }
    }

    /// The whole point of `clear`: a fault that comes back after a healthy stretch must be loud
    /// again, not silently folded into the run that ended hours ago.
    #[test]
    fn the_same_fault_after_a_recovery_is_loud_again() {
        let mut tick = TickLog::with_heartbeat(0);
        tick.observe("boom");
        tick.observe("boom");
        tick.clear();
        assert_eq!(tick.observe("boom"), Some(0));
    }

    #[test]
    fn clear_reports_the_suppressed_run_it_ended() {
        let mut tick = TickLog::with_heartbeat(0);
        tick.observe("boom");
        tick.observe("boom");
        tick.observe("boom");
        assert_eq!(tick.clear(), Some(2));
    }

    #[test]
    fn clear_is_silent_when_nothing_was_faulted() {
        let mut tick = TickLog::with_heartbeat(0);
        assert_eq!(tick.clear(), None);
        tick.observe("boom");
        tick.clear();
        assert_eq!(tick.clear(), None);
    }

    #[test]
    fn clear_right_after_a_heartbeat_reports_an_empty_run() {
        let mut tick = TickLog::with_heartbeat(2);
        tick.observe("boom");
        assert_eq!(tick.observe("boom"), None);
        assert_eq!(tick.observe("boom"), Some(2));
        assert_eq!(tick.clear(), Some(0));
    }

    /// A healthy worker calls `clear` on every tick; that must not creep toward a heartbeat.
    #[test]
    fn a_healthy_run_of_clears_stays_silent() {
        let mut tick = TickLog::with_heartbeat(3);
        for _ in 0..10 {
            assert_eq!(tick.clear(), None);
        }
        assert_eq!(tick.observe("boom"), Some(0));
    }
}
