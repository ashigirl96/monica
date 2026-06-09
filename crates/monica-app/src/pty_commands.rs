use base64::Engine;
use monica_infra::sqlite::TerminalStateSnapshot;
use monica_infra::Runtime;
use monica_pty::{PtyManager, PtyOutput, PtySize, SpawnCommand, SpawnRequest};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PtySpawnEnv {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PtySpawnCommand {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: Vec<PtySpawnEnv>,
}

#[tauri::command]
#[specta::specta]
pub fn pty_spawn(
    state: State<'_, PtyManager>,
    app: AppHandle,
    id: String,
    cwd: String,
    rows: u16,
    cols: u16,
    command: Option<PtySpawnCommand>,
) -> Result<(), String> {
    let output_app = app.clone();
    let exit_app = app;

    state
        .spawn(
            SpawnRequest {
                id: id.clone(),
                cwd,
                rows,
                cols,
                command: command.map(|command| SpawnCommand {
                    program: command.program,
                    args: command.args,
                    env: command
                        .env
                        .into_iter()
                        .map(|env| (env.key, env.value))
                        .collect(),
                }),
            },
            move |output: PtyOutput| {
                let event = format!("pty:output:{}", output.id);
                let _ = output_app.emit(&event, &output.data);
            },
            move |id: String, code: Option<u32>| {
                let event = format!("pty:exit:{id}");
                let _ = exit_app.emit(&event, code);
            },
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn pty_write(state: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    let engine = base64::engine::general_purpose::STANDARD;
    let bytes = engine.decode(&data).map_err(|e| e.to_string())?;
    state.write(&id, &bytes).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn pty_resize(
    state: State<'_, PtyManager>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    state
        .resize(&id, PtySize { rows, cols })
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn pty_kill(state: State<'_, PtyManager>, id: String) -> Result<(), String> {
    state.kill(&id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn terminal_load_state() -> Result<TerminalStateSnapshot, String> {
    let runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    runtime
        .repositories
        .load_terminal_state()
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn terminal_save_state(state: TerminalStateSnapshot) -> Result<(), String> {
    let mut runtime = Runtime::open_default().map_err(|e| e.to_string())?;
    runtime
        .repositories
        .save_terminal_state(&state)
        .map_err(|e| e.to_string())
}
