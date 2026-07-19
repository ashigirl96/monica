use anyhow::Result;
use clap::{Subcommand, ValueEnum};
use monica_domain::SyncedBlockMode;

use crate::event_sink::{self, CliFacade};

#[derive(Clone, ValueEnum)]
pub enum ShowFormat {
    /// Markdown projection (agent / human readable)
    Md,
    /// Raw ProseMirror doc JSON (the source of truth)
    Json,
}

#[derive(Subcommand)]
pub enum NoteCommand {
    /// Print a note (markdown projection by default)
    Show {
        /// note id (e.g. `note-42`)
        id: String,
        #[arg(long, value_enum, default_value_t = ShowFormat::Md)]
        format: ShowFormat,
        /// Inline-expand synced blocks instead of `![[..]]` references
        #[arg(long)]
        expand: bool,
    },
    /// Full-text search across note bodies (FTS5)
    Search {
        /// query string (matched against title / project / date / body text)
        query: String,
    },
}

pub fn run(cmd: NoteCommand) -> Result<()> {
    let mut monica = event_sink::open()?;
    match cmd {
        NoteCommand::Show { id, format, expand } => show(&mut monica, &id, format, expand),
        NoteCommand::Search { query } => search(&mut monica, &query),
    }
}

fn show(monica: &mut CliFacade, id: &str, format: ShowFormat, expand: bool) -> Result<()> {
    match format {
        ShowFormat::Md => {
            let mode =
                if expand { SyncedBlockMode::Expand } else { SyncedBlockMode::Reference };
            println!("{}", monica.notes().note_markdown(id, mode)?);
        }
        ShowFormat::Json => {
            // 真実の raw doc JSON をそのまま出す（--expand は markdown 専用なので無視）。
            let note = monica.notes().get_note(id)?;
            println!("{}", note.content.as_str());
        }
    }
    Ok(())
}

fn search(monica: &mut CliFacade, query: &str) -> Result<()> {
    let results = monica.notes().search_notes(query)?;
    if results.is_empty() {
        println!("No notes matched {query:?}.");
        return Ok(());
    }
    let mut table = vec![vec![
        "ID".to_string(),
        "KIND".to_string(),
        "DATE".to_string(),
        "PREVIEW".to_string(),
    ]];
    for note in &results {
        table.push(vec![
            note.id.as_str().to_string(),
            note.kind.display_name(&note.date),
            note.date.clone(),
            note.preview.clone().unwrap_or_default(),
        ]);
    }
    print!("{}", crate::table::render_table(&table));
    Ok(())
}
