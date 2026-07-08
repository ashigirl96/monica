//! claude CLI プロセスとの stream-json I/O を担う transport 層。

mod subprocess;

pub use subprocess::SubprocessTransport;
