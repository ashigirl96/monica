fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let dist = std::path::Path::new(&manifest).join("../../dist-web");
    std::fs::create_dir_all(&dist).ok();
}
