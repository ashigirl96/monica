use objc2::runtime::ProtocolObject;
use objc2::AnyThread;
use objc2_app_kit::{
    NSImage, NSPasteboard, NSPasteboardReading, NSPasteboardTypeFileURL, NSPasteboardWriting,
};
use objc2_foundation::{NSArray, NSString, NSURL};

/// NSPasteboard は main thread でしか呼べないので、Tauri が main thread で走らせる sync command にしておく。
#[tauri::command]
pub fn clipboard_write_image(path: String) -> Result<(), String> {
    let image = NSImage::initWithContentsOfFile(NSImage::alloc(), &NSString::from_str(&path))
        .ok_or_else(|| format!("cannot read an image from {path}"))?;
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    let objects: &NSArray<ProtocolObject<dyn NSPasteboardWriting>> =
        &NSArray::from_retained_slice(&[ProtocolObject::from_retained(image)]);
    if !pasteboard.writeObjects(objects) {
        return Err(format!("the pasteboard refused the image from {path}"));
    }
    Ok(())
}

/// Finder のコピーは file reference URL（`file:///.file/id=…`）で来るので、文字列のまま parse せず NSURL の `path` で実の path に解決する。
#[tauri::command]
pub fn clipboard_read_file_paths() -> Vec<String> {
    let Some(items) = NSPasteboard::generalPasteboard().pasteboardItems() else {
        return Vec::new();
    };
    // SAFETY: AppKit が定義する変更されない定数を読むだけ。
    let file_url = unsafe { NSPasteboardTypeFileURL };
    items
        .iter()
        .filter_map(|item| {
            let plist = item.propertyListForType(file_url)?;
            // SAFETY: plist は同じ型の `propertyListForType` が返したもので、NSURL が受け取る形をしている。
            let url = unsafe {
                NSURL::initWithPasteboardPropertyList_ofType(NSURL::alloc(), &plist, file_url)
            }?;
            if !url.isFileURL() {
                return None;
            }
            Some(url.path()?.to_string())
        })
        .collect()
}
