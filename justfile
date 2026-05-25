set shell := ["bash", "-cu"]

default:
    @just --list

install:
    bun install

dev:
    bun run tauri dev

build:
    bun run tauri build --bundles app

build-debug:
    bun run tauri build --debug --bundles app

install-local: build
    rm -rf /Applications/Monica.app
    cp -R src-tauri/target/release/bundle/macos/Monica.app /Applications/Monica.app
    xattr -dr com.apple.quarantine /Applications/Monica.app 2>/dev/null || true
    @echo "Installed: /Applications/Monica.app"

preview:
    bun --bun vite preview

lint:
    bunx oxlint

fmt:
    bunx oxfmt

fmt-check:
    bunx oxfmt --check

check: lint fmt-check
    cd src-tauri && cargo clippy --all-targets -- -D warnings

analyze:
    bun --bun vite build --mode analyze
    @echo "open dist/stats.html"

bloat:
    cd src-tauri && cargo bloat --release --crates

size:
    @du -sh dist 2>/dev/null || true
    @ls -lh src-tauri/target/release/bundle/*/ 2>/dev/null || true

clean:
    rm -rf dist node_modules src-tauri/target
