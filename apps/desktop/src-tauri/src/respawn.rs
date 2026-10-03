use std::collections::VecDeque;
use std::time::{Duration, Instant};

const BACKOFF_SECS: [u64; 4] = [0, 1, 2, 4];
const WINDOW: Duration = Duration::from_secs(60);

/// Backend の予期しない終了から次の spawn までの待ちを決める。
/// 上限があるのは、migrate の失敗のような決定的なエラーで spawn を回し続けないため。
pub struct Respawn {
    failures: VecDeque<Instant>,
}

impl Respawn {
    pub fn new() -> Self {
        Self { failures: VecDeque::new() }
    }

    /// 失敗を数え、次の spawn までの待ちを返す。諦めるときは None。
    pub fn after_failure(&mut self, now: Instant) -> Option<Duration> {
        while self.failures.front().is_some_and(|at| now.duration_since(*at) > WINDOW) {
            self.failures.pop_front();
        }
        self.failures.push_back(now);
        BACKOFF_SECS.get(self.failures.len() - 1).map(|s| Duration::from_secs(*s))
    }

    pub fn reset(&mut self) {
        self.failures.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(s: f64) -> Duration {
        Duration::from_secs_f64(s)
    }

    #[test]
    fn waits_longer_after_each_failure_and_gives_up_at_the_fifth_within_a_minute() {
        let start = Instant::now();
        let mut respawn = Respawn::new();

        assert_eq!(respawn.after_failure(start), Some(secs(0.0)));
        assert_eq!(respawn.after_failure(start + secs(0.3)), Some(secs(1.0)));
        assert_eq!(respawn.after_failure(start + secs(1.6)), Some(secs(2.0)));
        assert_eq!(respawn.after_failure(start + secs(3.9)), Some(secs(4.0)));
        assert_eq!(respawn.after_failure(start + secs(8.2)), None);
    }

    #[test]
    fn forgets_failures_older_than_a_minute() {
        let start = Instant::now();
        let mut respawn = Respawn::new();
        for at in [0.0, 0.3, 1.6, 3.9] {
            respawn.after_failure(start + secs(at));
        }

        assert_eq!(respawn.after_failure(start + secs(62.0)), Some(secs(1.0)));
    }

    #[test]
    fn retry_starts_over_after_giving_up() {
        let start = Instant::now();
        let mut respawn = Respawn::new();
        for at in [0.0, 0.3, 1.6, 3.9, 8.2] {
            respawn.after_failure(start + secs(at));
        }

        respawn.reset();

        assert_eq!(respawn.after_failure(start + secs(9.0)), Some(secs(0.0)));
    }
}
