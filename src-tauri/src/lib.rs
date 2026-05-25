mod terminal;

use tauri::{Manager, WindowEvent};

use crate::terminal::SessionManager;
use crate::terminal::commands::{terminal_close, terminal_open, terminal_resize, terminal_write};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(SessionManager::new());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                let manager = window.state::<SessionManager>();
                manager.close_all();
            }
        })
        .invoke_handler(tauri::generate_handler![
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
