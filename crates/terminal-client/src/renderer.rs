use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::lock;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendererGeneration {
    pub renderer: u64,
    pub connection: u64,
}

type PrepareRenderer = Box<dyn Fn(&str) + Send + Sync>;

#[derive(Clone, Copy, Serialize)]
pub struct RendererOutput {
    pub generation: RendererGeneration,
    pub sequence: u64,
}

#[derive(Default)]
pub struct Renderers {
    state: Mutex<State>,
    request: Mutex<Option<PrepareRenderer>>,
}

#[derive(Default)]
struct State {
    connection: u64,
    next: u64,
    sessions: HashMap<String, Renderer>,
}

struct Renderer {
    generation: RendererGeneration,
    heartbeat: Option<Instant>,
    output: u64,
    parsed: u64,
    pending: VecDeque<(u64, Instant)>,
}

impl Renderers {
    pub fn on_request(&self, request: impl Fn(&str) + Send + Sync + 'static) {
        *lock(&self.request) = Some(Box::new(request));
    }

    pub fn request(&self, session: &str) {
        if let Some(request) = lock(&self.request).as_ref() {
            request(session);
        }
    }

    pub fn register(&self, session: &str) -> RendererGeneration {
        let mut state = lock(&self.state);
        state.next += 1;
        let generation = RendererGeneration {
            renderer: state.next,
            connection: state.connection,
        };
        state.sessions.insert(
            session.into(),
            Renderer {
                generation,
                heartbeat: None,
                output: 0,
                parsed: 0,
                pending: VecDeque::new(),
            },
        );
        generation
    }

    pub fn disconnect(&self) {
        let mut state = lock(&self.state);
        state.connection += 1;
        state.sessions.clear();
    }

    pub fn remove(&self, session: &str, generation: RendererGeneration) {
        let mut state = lock(&self.state);
        if state
            .sessions
            .get(session)
            .is_some_and(|r| r.generation == generation)
        {
            state.sessions.remove(session);
        }
    }

    pub fn exited(&self, session: &str) {
        lock(&self.state).sessions.remove(session);
    }

    pub fn output(&self, session: &str, now: Instant) -> Option<RendererOutput> {
        let mut state = lock(&self.state);
        let renderer = state.sessions.get_mut(session)?;
        renderer.output += 1;
        if renderer.pending.len() == 1024 {
            // Keep the oldest timestamp when coalescing progress; overload fails closed.
            renderer.pending.back_mut().unwrap().0 = renderer.output;
        } else {
            renderer.pending.push_back((renderer.output, now));
        }
        Some(RendererOutput {
            generation: renderer.generation,
            sequence: renderer.output,
        })
    }

    pub fn parsed(
        &self,
        session: &str,
        generation: RendererGeneration,
        sequence: u64,
        now: Instant,
    ) {
        let mut state = lock(&self.state);
        let Some(renderer) = state.sessions.get_mut(session) else {
            return;
        };
        if renderer.generation != generation
            || sequence > renderer.output
            || sequence < renderer.parsed
        {
            return;
        }
        renderer.heartbeat = Some(now);
        renderer.parsed = sequence;
        while renderer
            .pending
            .front()
            .is_some_and(|&(output, _)| output <= sequence)
        {
            renderer.pending.pop_front();
        }
    }

    pub fn current(&self, session: &str, now: Instant) -> Option<RendererGeneration> {
        let state = lock(&self.state);
        state
            .sessions
            .get(session)
            .filter(|r| healthy(r, now))
            .map(|r| r.generation)
    }

    pub fn ready(&self, session: &str, generation: RendererGeneration, now: Instant) -> bool {
        self.current(session, now) == Some(generation)
    }

    pub fn admit<T>(
        &self,
        session: &str,
        generation: RendererGeneration,
        write: impl FnOnce() -> T,
    ) -> Option<T> {
        let state = lock(&self.state);
        let renderer = state.sessions.get(session)?;
        if renderer.generation != generation || !healthy(renderer, Instant::now()) {
            return None;
        }
        drop(state);
        Some(write())
    }
}

fn healthy(renderer: &Renderer, now: Instant) -> bool {
    renderer
        .heartbeat
        .is_some_and(|last| now.saturating_duration_since(last) < Duration::from_secs(6))
        && renderer
            .pending
            .front()
            .is_none_or(|&(_, since)| now.saturating_duration_since(since) < Duration::from_secs(6))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_is_bound_to_renderer_connection_and_parsed_output() {
        let renderers = Renderers::default();
        let now = Instant::now();
        let old = renderers.register("session");
        assert!(!renderers.ready("session", old, now));
        renderers.parsed("session", old, 0, now);
        assert!(renderers.ready("session", old, now));
        assert!(!renderers.ready("other", old, now));
        assert!(!renderers.ready("session", old, now + Duration::from_secs(6)));
        let sequence = renderers.output("session", now).unwrap().sequence;
        renderers.parsed("session", old, 0, now + Duration::from_secs(5));
        assert!(!renderers.ready("session", old, now + Duration::from_secs(6)));
        renderers.parsed("session", old, sequence, now + Duration::from_secs(6));
        assert!(renderers.ready("session", old, now + Duration::from_secs(6)));
        let replacement = renderers.register("session");
        renderers.parsed("session", old, sequence, now);
        assert!(!renderers.ready("session", old, now));
        assert!(!renderers.ready("session", replacement, now));
        renderers.parsed("session", replacement, 0, now);
        renderers.remove("session", old);
        assert!(renderers.ready("session", replacement, now));
        renderers.disconnect();
        assert!(!renderers.ready("session", replacement, now));
        renderers.parsed("session", replacement, 0, now);
        assert!(!renderers.ready("session", replacement, now));
    }
    #[test]
    fn parsing_progress_ages_only_unparsed_output_and_exit_cannot_be_revived() {
        let renderers = Renderers::default();
        let now = Instant::now();
        let generation = renderers.register("session");
        renderers.parsed("session", generation, 0, now);
        renderers.output("session", now);
        renderers.output("session", now + Duration::from_secs(5));
        renderers.parsed("session", generation, 1, now + Duration::from_secs(5));
        assert!(renderers.ready("session", generation, now + Duration::from_secs(6)));
        assert!(!renderers.ready("session", generation, now + Duration::from_secs(11)));
        for _ in 0..2000 {
            renderers.output("session", now);
        }
        renderers.parsed("session", generation, 1000, now + Duration::from_secs(5));
        assert!(!renderers.ready("session", generation, now + Duration::from_secs(6)));
        renderers.parsed("session", generation, 2002, now + Duration::from_secs(6));
        assert!(renderers.ready("session", generation, now + Duration::from_secs(6)));
        renderers.exited("session");
        renderers.parsed("session", generation, 2, now);
        assert!(!renderers.ready("session", generation, now));
    }
}
