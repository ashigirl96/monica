use std::env;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let migrations_dir = manifest_dir.join("src/sqlite/migrations");
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

    println!("cargo:rerun-if-changed={}", migrations_dir.display());

    let mut entries: Vec<(String, String, PathBuf)> = Vec::new();

    for entry in fs::read_dir(&migrations_dir).expect("cannot read migrations directory") {
        let entry = entry.unwrap();
        let file_name = entry.file_name().into_string().unwrap();
        if !file_name.ends_with(".sql") {
            continue;
        }
        println!("cargo:rerun-if-changed={}", entry.path().display());

        let stem = file_name.strip_suffix(".sql").unwrap();
        let (version, name) = stem
            .split_once('_')
            .unwrap_or_else(|| panic!("invalid migration filename: {file_name} (expected TIMESTAMP_name.sql)"));

        assert!(
            version.chars().all(|c| c.is_ascii_digit()),
            "invalid version in migration filename: {file_name}"
        );

        entries.push((version.to_string(), name.to_string(), entry.path()));
    }

    assert!(
        !entries.is_empty(),
        "no .sql migration files found in {}",
        migrations_dir.display()
    );

    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let mut seen = std::collections::HashSet::new();
    for (version, _, _) in &entries {
        assert!(
            seen.insert(version.clone()),
            "duplicate migration version: {version}"
        );
    }

    let mut out = fs::File::create(out_dir.join("migrations_generated.rs")).unwrap();

    writeln!(out, "pub(crate) const MIGRATIONS: &[Migration] = &[").unwrap();
    for (version, name, path) in &entries {
        let path_str = path.to_str().unwrap().replace('\\', "/");
        writeln!(out, "    Migration {{").unwrap();
        writeln!(out, "        version: \"{version}\",").unwrap();
        writeln!(out, "        name: \"{name}\",").unwrap();
        writeln!(out, "        sql: include_str!(\"{path_str}\"),").unwrap();
        writeln!(out, "    }},").unwrap();
    }
    writeln!(out, "];").unwrap();
}
