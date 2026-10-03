use std::fs;
use std::path::Path;

use crate::locations;

pub fn link(home: &Path) {
    let Some(cli) = locations::cli() else {
        eprintln!("[shell] TANIA_BIN is not set; leaving $TANIA_HOME/bin/tania as it is");
        return;
    };
    place(&home.join("bin/tania"), &cli);
    if let Some(link) = locations::user_cli_link() {
        place(&link, &cli);
    }
}

fn place(link: &Path, target: &Path) {
    if fs::read_link(link).is_ok_and(|current| current == target) {
        return;
    }
    let staged = link.with_extension("tmp");
    let result = fs::create_dir_all(link.parent().expect("link has a parent"))
        .and_then(|()| match fs::remove_file(&staged) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        })
        .and_then(|()| std::os::unix::fs::symlink(target, &staged))
        .and_then(|()| fs::rename(&staged, link));
    if let Err(error) = result {
        eprintln!(
            "[shell] could not link {} to {}: {error}",
            link.display(),
            target.display()
        );
    }
}
