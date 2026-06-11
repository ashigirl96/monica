#[cfg(target_os = "macos")]
#[tauri::command]
#[specta::specta]
pub fn clipboard_write_image(path: String) -> Result<(), String> {
    use objc2::runtime::ProtocolObject;
    use objc2::AnyThread;
    use objc2_app_kit::{NSImage, NSPasteboard, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString};

    let ns_path = NSString::from_str(&path);
    let image = NSImage::initWithContentsOfFile(NSImage::alloc(), &ns_path)
        .ok_or_else(|| format!("failed to create NSImage from {path}"))?;

    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();

    let obj = ProtocolObject::from_retained(image);
    let objects: &NSArray<ProtocolObject<dyn NSPasteboardWriting>> =
        &NSArray::from_retained_slice(&[obj]);
    let success = pasteboard.writeObjects(objects);
    if !success {
        return Err("NSPasteboard writeObjects failed".to_string());
    }

    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
#[specta::specta]
pub fn clipboard_write_image(_path: String) -> Result<(), String> {
    Err("clipboard_write_image is only supported on macOS".to_string())
}
