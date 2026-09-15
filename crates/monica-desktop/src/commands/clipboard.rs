/// Deliberately sync: NSPasteboard requires the main thread. Do NOT wrap in `off_main`.
#[cfg(target_os = "macos")]
#[tauri::command]
#[specta::specta]
pub fn clipboard_write_image(path: String) -> Result<(), monica_api::ApiError> {
    use monica_api::ApiError;
    use objc2::runtime::ProtocolObject;
    use objc2::AnyThread;
    use objc2_app_kit::{NSImage, NSPasteboard, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString};

    let log_ids = crate::command_log::ids![path];
    crate::command_log::operation_sync("clipboard_write_image", log_ids, move || {
        let ns_path = NSString::from_str(&path);
        let image = NSImage::initWithContentsOfFile(NSImage::alloc(), &ns_path)
            .ok_or_else(|| ApiError::external(format!("failed to create NSImage from {path}")))?;

        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();

        let obj = ProtocolObject::from_retained(image);
        let objects: &NSArray<ProtocolObject<dyn NSPasteboardWriting>> =
            &NSArray::from_retained_slice(&[obj]);
        let success = pasteboard.writeObjects(objects);
        if !success {
            return Err(ApiError::external("NSPasteboard writeObjects failed"));
        }

        Ok(())
    })
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
#[specta::specta]
pub fn clipboard_write_image(_path: String) -> Result<(), monica_api::ApiError> {
    crate::command_log::operation_sync(
        "clipboard_write_image",
        crate::command_log::Ids::default(),
        || {
            Err(monica_api::ApiError::external(
                "clipboard_write_image is only supported on macOS",
            ))
        },
    )
}
