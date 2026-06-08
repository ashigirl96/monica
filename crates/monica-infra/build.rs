use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let migrations_dir = manifest_dir.join("src/sqlite/migrations");
    println!("cargo:rerun-if-changed={}", migrations_dir.display());

    let mut migrations = fs::read_dir(&migrations_dir)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", migrations_dir.display()))
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "sql"))
        .collect::<Vec<_>>();
    migrations.sort();

    let mut seen_versions = Vec::new();
    let mut output = String::from("const MIGRATIONS: &[Migration] = &[\n");
    for path in migrations {
        println!("cargo:rerun-if-changed={}", path.display());
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_else(|| panic!("invalid migration file name: {}", path.display()));
        let (version, name) = parse_migration_name(file_name);
        if seen_versions.contains(&version) {
            panic!("duplicate SQLite migration version: {version}");
        }
        seen_versions.push(version);
        output.push_str(&format!(
            "    Migration {{ version: {version}, name: {name:?}, sql: include_str!({path:?}) }},\n",
            path = path.display().to_string()
        ));
    }
    output.push_str("];\n");

    let out_path = PathBuf::from(env::var("OUT_DIR").unwrap()).join("sqlite_migrations.rs");
    fs::write(&out_path, output)
        .unwrap_or_else(|e| panic!("failed to write {}: {e}", out_path.display()));
}

fn parse_migration_name(file_name: &str) -> (i64, String) {
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or_else(|| panic!("invalid migration file name: {file_name}"));
    let (version, name) = stem.split_once('_').unwrap_or_else(|| {
        panic!("migration file must be named <version>_<name>.sql: {file_name}")
    });
    let version = version
        .parse::<i64>()
        .unwrap_or_else(|e| panic!("invalid migration version in {file_name}: {e}"));
    if version <= 0 {
        panic!("migration version must be positive: {file_name}");
    }
    (version, name.to_string())
}
