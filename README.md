# qweb

**English** | [简体中文](README.zh-CN.md)

Streaming web workbench for AI coding agents — currently wired to Claude Code, architected to host other agents.

Chat is the full-width protagonist; the file tree and editor live in floating panes summoned from the title bar. One self-contained binary serves the UI, no runtime dependencies.

## Features

- **Streaming chat** — live output, interrupt (ESC), queue messages mid-reply, refresh-safe (conversation replays from a ring buffer), resume any past session
- **File management** — tree with context menu (rename/move/upload/download), multi-tab editor, `@` file mention in the composer
- **Permission approvals** — tool calls render as human-readable cards (command, file paths highlighted); allow or deny in one click
- **Multi-engine** — engine switcher per new session; Claude Code today, other agents slot in
- **Two form factors, same code** — single-file server (browser) and native Windows desktop app
- **Auth optional** — password mode with login page, or no-auth for local use
- **Reverse-proxy friendly** — zero-config base path: works behind nginx with or without a path prefix

## Quick start

```bash
git clone https://github.com/hb9630/qweb && cd qweb
(cd frontend && npm install)   # Rust deps go through the mirror in backend/.cargo
./build.sh                     # → ./qweb (single binary, ~19MB, frontend embedded)
./qweb                         # opens the browser; --no-browser to skip
```

**Windows desktop app** (Tauri + WebView2, needs MSVC Build Tools + Rust `x86_64-pc-windows-msvc`):

```bash
./build.sh desktop             # → ./qweb-desktop.exe, double-click to launch
```

Closing the window exits and reaps all session child processes.

**Linux server with systemd**: `./build.sh deploy` installs to `/usr/local/qweb` and generates the unit (port 18090 by default).

## CLI

```bash
./qweb -p 18090                # port (QWEB_PORT)
./qweb --home /data/ws         # workspace root (QWEB_HOME)
./qweb --single                # single-session mode (QWEB_SINGLE=1)
./qweb --auth password --password=xxx   # password auth (QWEB_AUTH/QWEB_PASSWORD)
./qweb --no-browser            # don't auto-open browser
./qweb --help
```

Precedence: CLI > env > default. The startup banner always prints the effective config.

## License

Apache-2.0 — see [LICENSE](LICENSE).
