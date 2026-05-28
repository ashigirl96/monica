set shell := ["bash", "-cu"]

default:
    @just --list

install:
    bun install

dev:
    bun run tauri dev

dev-cli:
    cargo build -p monica-cli
    cp target/debug/monica ./monica
    [ "$(uname)" = Darwin ] && codesign --force --sign - ./monica || true
    mkdir -p ~/.zsh/completions
    ./monica completions zsh > ~/.zsh/completions/_monica

build:
    bun run tauri build --bundles app

build-debug:
    bun run tauri build --debug --bundles app

install-local: build install-cli
    rm -rf /Applications/Monica.app
    cp -R target/release/bundle/macos/Monica.app /Applications/Monica.app
    xattr -dr com.apple.quarantine /Applications/Monica.app 2>/dev/null || true
    @echo "Installed: /Applications/Monica.app"

install-cli:
    cargo build --release -p monica-cli
    mkdir -p ~/.local/bin
    cp target/release/monica ~/.local/bin/monica
    @echo "Installed: ~/.local/bin/monica"
    mkdir -p ~/.zsh/completions
    ~/.local/bin/monica completions zsh > ~/.zsh/completions/_monica
    @echo "Installed: ~/.zsh/completions/_monica"

preview:
    bun --bun vite preview

lint:
    bunx oxlint

fmt:
    bunx oxfmt

fmt-check:
    bunx oxfmt --check

check: lint fmt-check
    cargo clippy --workspace --all-targets -- -D warnings

test:
    cargo test --workspace

analyze:
    bun --bun vite build --mode analyze
    @echo "open dist/stats.html"

bloat:
    cargo bloat --release --crates -p monica-app

size:
    @du -sh dist 2>/dev/null || true
    @ls -lh target/release/bundle/*/ 2>/dev/null || true

clean:
    rm -rf dist node_modules target monica
