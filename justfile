set shell := ["bash", "-cu"]

default:
    @just --list

install:
    bun install

dev: dev-cli ptyd-bin
    MONICA_HOME="$HOME/monica/dev" MONICA_CLI_PATH="{{justfile_directory()}}/monica" MONICA_PTYD_PATH="{{justfile_directory()}}/target/debug/monica-ptyd" bun run tauri dev

dev-cli:
    cargo build -p monica-cli
    cp target/debug/monica ./.monica-bin.tmp
    mv -f ./.monica-bin.tmp ./monica
    [ "$(uname)" = Darwin ] && codesign --force --sign - ./monica || true
    mkdir -p ~/.zsh/completions
    ./monica completions zsh > ~/.zsh/completions/_monica

# tauri.conf.json's externalBin makes every monica-app compile (dev, clippy, tests)
# require binaries/monica-ptyd-<host-triple>; this provides it. Release builds overwrite
# it with a release binary via beforeBuildCommand.
ptyd-bin:
    cargo build -p monica-ptyd
    mkdir -p crates/monica-app/binaries
    cp target/debug/monica-ptyd "crates/monica-app/binaries/monica-ptyd-$(rustc -vV | sed -n 's/host: //p')"

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
    # Exactly two spaces of indent: deeper-indented lines are fields of inlined
    # return types (e.g. `Option<Struct>` commands), not command names.
    cmds=$(sed -n '/^export const commands/,/^};/p' "$bindings" | grep -oE '^  [a-zA-Z]+:' | sed 's/[: ]//g')
    found=0
    for cmd in $cmds; do
        if ! grep -rq "commands\.$cmd" src/ --include='*.ts' --include='*.tsx' --exclude="$bindings"; then
            echo "unused command: $cmd"
            found=1
        fi
    done
    if [ "$found" -eq 0 ]; then echo "all commands used"; fi
    exit "$found"

# Fails on any verbatim clone of 100+ tokens. Smaller duplication is reviewed by humans;
# this gate only blocks the copy-paste class that linters cannot see.
dup:
    bunx jscpd src crates --format "typescript,tsx,rust" --ignore "**/bindings.ts" --min-tokens 100 --threshold 0 --silent

check: lint fmt-check knip unused-commands dup ptyd-bin
    cargo clippy --workspace --all-targets -- -D warnings

generate-bindings: ptyd-bin
    cargo test -p monica-app --lib tests::export_typescript_bindings -- --exact

test: ptyd-bin
    cargo test --workspace
    bun test

# Coverage doubles as dead-code detection: a pub fn at 0% that no caller or test reaches
# is invisible to clippy (rustc has no cross-crate dead_code analysis in a workspace).
coverage: ptyd-bin
    cargo llvm-cov --workspace

coverage-html: ptyd-bin
    cargo llvm-cov --workspace --html --open

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
