use tauri::menu::{Menu, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Wry};

pub(crate) const NEW_WINDOW_ID: &str = "new_window";

pub(crate) fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::default(app)?;
    let new_window = MenuItemBuilder::with_id(NEW_WINDOW_ID, "New Window")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(app)?;
    let separator = PredefinedMenuItem::separator(app)?;

    match file_submenu(&menu)? {
        Some(file) => file.insert_items(&[&new_window, &separator], 0)?,
        // The default menu has no File submenu on Linux.
        None => {
            let file = SubmenuBuilder::new(app, "File").item(&new_window).build()?;
            menu.insert(&file, 0)?;
        }
    }
    Ok(menu)
}

fn file_submenu(menu: &Menu<Wry>) -> tauri::Result<Option<Submenu<Wry>>> {
    for item in menu.items()? {
        if let Some(submenu) = item.as_submenu() {
            if submenu.text()? == "File" {
                return Ok(Some(submenu.clone()));
            }
        }
    }
    Ok(None)
}
