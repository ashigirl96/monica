use std::io::Read;
use std::thread::{self, JoinHandle};

use tauri::ipc::{Channel, InvokeResponseBody};

const READ_BUF_SIZE: usize = 4096;

pub fn spawn_reader_thread(
    mut reader: Box<dyn Read + Send>,
    channel: Channel<InvokeResponseBody>,
    on_exit: impl FnOnce() + Send + 'static,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut buf = [0u8; READ_BUF_SIZE];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if channel.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        on_exit();
    })
}
