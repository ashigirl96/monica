use objc2::runtime::ProtocolObject;
use objc2::AnyThread;
use objc2_app_kit::{NSImage, NSPasteboard, NSPasteboardWriting};
use objc2_foundation::{NSArray, NSString};

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
