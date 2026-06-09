set shell := ["bash", "-cu"]

default:
    @just --list

install:
    bun install

dev:
    MONICA_HOME="$HOME/monica/dev" bun run tauri dev

dev-cli:
    cargo build -p monica-cli
    cp target/debug/monica ./.monica-bin.tmp
    mv -f ./.monica-bin.tmp ./monica
    [ "$(uname)" = Darwin ] && codesign --force --sign - ./monica || true
    mkdir -p ~/.zsh/completions
    ./monica completions zsh > ~/.zsh/completions/_monica

build:
    bun run tauri build --bundles app

build-debug:
    bun run tauri build --debug --bundles app

install-app: build
    rm -rf /Applications/Monica.app
    cp -R target/release/bundle/macos/Monica.app /Applications/Monica.app
    codesign --force --sign "Monica" /Applications/Monica.app
    xattr -dr com.apple.quarantine /Applications/Monica.app 2>/dev/null || true
    @echo "Installed: /Applications/Monica.app"

install-cli:
    cargo build --release -p monica-cli
    mkdir -p ~/.local/bin
    cp target/release/monica ~/.local/bin/.monica.tmp
    chmod 755 ~/.local/bin/.monica.tmp
    mv -f ~/.local/bin/.monica.tmp ~/.local/bin/monica
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

knip:
    bunx knip

unused-commands:
    #!/usr/bin/env bash
    set -euo pipefail
    bindings="src/commands/bindings.ts"
    cmds=$(sed -n '/^export const commands/,/^};/p' "$bindings" | grep -oE '^\s+[a-zA-Z]+:' | sed 's/[: ]//g')
    found=0
    for cmd in $cmds; do
        if ! grep -rq "commands\.$cmd" src/ --include='*.ts' --include='*.tsx' --exclude="$bindings"; then
            echo "unused command: $cmd"
            found=1
        fi
    done
    if [ "$found" -eq 0 ]; then echo "all commands used"; fi
    exit "$found"

check: lint fmt-check knip unused-commands
    cargo clippy --workspace --all-targets -- -D warnings

generate-bindings:
    cargo test -p monica-app --lib tests::export_typescript_bindings -- --exact

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

kill-dev:
    #!/usr/bin/env bash
    pattern='(tauri dev|vite|cargo).*monica|target/debug/monica'
    pids=$(pgrep -f "$pattern" 2>/dev/null) || { echo "no dev processes found"; exit 0; }
    while read -r pid; do
        cmd=$(ps -p "$pid" -o command= 2>/dev/null) && printf "  kill %s  %s\n" "$pid" "$cmd"
    done <<< "$pids"
    echo "$pids" | xargs kill 2>/dev/null || true

clean:
    rm -rf dist node_modules target monica
