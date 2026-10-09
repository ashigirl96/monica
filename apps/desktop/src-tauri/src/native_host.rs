//! Chrome Extension が Backend の port と chat の token を引く Native Messaging の host の manifest（ADR-0034）。

use std::fs;
use std::io;
use std::path::Path;

use crate::locations;

/// `scripts/native-host.ts` の `RELEASE_NATIVE_HOST` と揃える。Chrome Extension が build の時に焼く名前。
const NAME: &str = "com.ashigirl96.monica";
/// release の Chrome Extension の ID（`docs/packages/extension.md`）。dev の ID は dev の manifest にだけ書く。
const RELEASE_ORIGIN: &str = "chrome-extension://dnggfebiponjhdpjgmdfafaghpbkejop/";

pub fn install() {
    let Some(native_host) = locations::native_host() else {
        return;
    };
    if let Err(error) = write_manifest(&native_host.manifest_dir, &native_host.host) {
        eprintln!(
            "[shell] could not write the native messaging host manifest in {}: {error}",
            native_host.manifest_dir.display()
        );
    }
}

fn write_manifest(dir: &Path, host: &Path) -> io::Result<()> {
    let manifest = dir.join(format!("{NAME}.json"));
    let content = manifest_json(host);
    if fs::read(&manifest).is_ok_and(|current| current == content.as_bytes()) {
        return Ok(());
    }
    fs::create_dir_all(dir)?;
    let staged = dir.join(format!("{NAME}.json.tmp"));
    fs::write(&staged, &content)?;
    fs::rename(&staged, &manifest)
}

fn manifest_json(host: &Path) -> String {
    let manifest = serde_json::json!({
        "name": NAME,
        "description": "Hands the Monica Chrome Extension the port and the chat token of the Backend",
        "path": host.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": [RELEASE_ORIGIN],
    });
    format!(
        "{}\n",
        serde_json::to_string_pretty(&manifest).expect("a manifest serializes")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    const HOST: &str = "/Applications/Monica.app/Contents/MacOS/monica";

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("monica-native-host-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn read_manifest(dir: &Path) -> serde_json::Value {
        serde_json::from_slice(&fs::read(dir.join(format!("{NAME}.json"))).unwrap()).unwrap()
    }

    #[test]
    fn writes_a_manifest_that_lets_only_the_release_extension_start_the_bundled_cli() {
        let root = temp("fresh");
        let dir = root.join("Google/Chrome/NativeMessagingHosts");

        write_manifest(&dir, Path::new(HOST)).unwrap();
        let manifest = read_manifest(&dir);
        fs::remove_dir_all(&root).unwrap();

        assert_eq!(
            manifest,
            serde_json::json!({
                "name": "com.ashigirl96.monica",
                "description": "Hands the Monica Chrome Extension the port and the chat token of the Backend",
                "path": HOST,
                "type": "stdio",
                "allowed_origins": ["chrome-extension://dnggfebiponjhdpjgmdfafaghpbkejop/"],
            })
        );
    }

    #[test]
    fn leaves_a_manifest_with_the_same_content_unwritten() {
        let dir = temp("same");
        write_manifest(&dir, Path::new(HOST)).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();

        let again = write_manifest(&dir, Path::new(HOST));
        let moved = write_manifest(
            &dir,
            Path::new("/Applications/Other.app/Contents/MacOS/monica"),
        );
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        fs::remove_dir_all(&dir).unwrap();

        assert!(again.is_ok());
        assert!(moved.is_err());
    }

    #[test]
    fn rewrites_a_manifest_that_names_another_cli() {
        let dir = temp("moved");
        write_manifest(
            &dir,
            Path::new("/Applications/Old.app/Contents/MacOS/monica"),
        )
        .unwrap();

        write_manifest(&dir, Path::new(HOST)).unwrap();
        let manifest = read_manifest(&dir);
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(manifest["path"], HOST);
        assert_eq!(names, vec!["com.ashigirl96.monica.json"]);
    }

    // dev の manifest は `bun run extension` が書く。debug の Shell が書くと、ユーザーの release の host を上書きする。
    #[test]
    #[cfg(debug_assertions)]
    fn a_debug_shell_has_no_manifest_to_write() {
        assert!(locations::native_host().is_none());
    }
}
