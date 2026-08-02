# pi-essentials

Essential extensions for [pi](https://github.com/earendil-works/pi) — quality-of-life improvements that every setup should have.

This is a fork of [samfoy/pi-essentials](https://github.com/samfoy/pi-essentials) (published on npm as `@samfp/pi-essentials`). It keeps all the original extensions and adds new ones — durable subagents, a `split_pane` tool for running long-lived processes, automatic terminal tab naming, and more (see [What's new in this fork](#whats-new-in-this-fork)).

## Install

From git (this fork):

```bash
pi install git:github.com/abster12/pi-essentials
```

Prefer the original upstream package from npm:

```bash
pi install npm:@samfp/pi-essentials
```

Or install from a local checkout (e.g. for development):

```bash
npm ci
npm run build
pi install -l .
```

## What's Included

| Extension | What it does |
|-----------|-------------|
| **Subagent** | `subagent`, `subagent_status`, and `subagent_kill` tools — spawn durable background or interactive pi subagents whose results auto-inject back |
| **Split Pane** | `split_pane` tool — run any long-running local process (dev server, watcher, notebook…) in a named side pane beside the agent |
| **Auto Session Name** | Names sessions from the first user message — no more `unnamed-session-1` |
| **Auto Title** | Names the host terminal tab/pane from your first message (herdr and tmux) |
| **Compact Header** | Clean table-style startup header with pi version, model, thinking level, prompts, skills, and keybinding reference |
| **Clipboard Image** | Paste base64 image data (PNG/JPEG) directly into the prompt |
| **Image Context Pruner** | Strips images from older messages to save context tokens |
| **Markdown Viewer** | Rendered markdown preview on Ctrl+O for `.md` files, plus `/mdview` and `/mermaid` commands |
| **Screenshot** | `/ss` command — grab clipboard image or send a file to the agent. Requires kitty terminal + `kitten` binary |
| **Context Pruner** | `context_prune` tool — lets the agent replace bulky search results with short summaries to free context space |
| **Daily Log** | `daily_log` tool — append timestamped entries to a daily markdown note (configurable via env vars) |

## What's new in this fork

On top of the upstream extension set:

- **Durable subagents** — background runs persist their transcript under `~/.pi/agent/subagent-sessions/`; on a clean finish the file is deleted, but on a crash, kill, or API-credit death it survives and can be resumed with `/resume-subagent`. Runs stream JSON events for a live progress widget showing turns, token usage, cost, and model.
- **Interactive subagents** — `subagent` with `interactive: true` spawns a full, steerable pi session in its own pane: a new herdr pane (`herdr agent start`) when pi runs inside herdr, otherwise a tmux window. Results still auto-inject into your session when done. The pane/tab is named after the task.
- **`subagent_kill` + timeouts** — kill a subagent by ID or let it auto-kill after a timeout (`timeout` param, default 10 minutes).
- **Failure diagnostics** — crashed runs report exit code, signal, stderr, a trail of the tool calls it made, and partial output. Event logs are kept at `/tmp/subagent-<id>-events.jsonl` for post-mortem (`jq . < file`).
- **`split_pane` tool** — splits a named side pane (herdr preferred, tmux fallback) and runs any long-running command in its interactive shell: `./gradlew bootRun`, `flutter run`, `docker compose up`, `npm run dev`… The agent pane keeps focus; logs stream in the pane and Ctrl-C there stops the process.
- **Auto Title extension** — names your terminal tab from the first message; refreshes when the session gets a proper name (e.g. from auto-session-name or `/name`). Renames the herdr pane *and* its tab, or the tmux window/pane.
- **`PI_TAB_LABEL` integration** — the subagent spawner sets `PI_TAB_LABEL` on interactive subagent panes so the tab and session show the task instead of the framed prompt; auto-title and auto-session-name honor it.
- **Smarter compact header** — resolves the *host* pi version by walking up from the running binary (the linked package can lag behind), and shows provider, model, thinking level, available prompts and skills.
- **Precompiled build** — all extensions are bundled to `dist/*.js` with esbuild so pi loads them without per-startup jiti transpilation; `npm test` runs `tsc --noEmit` plus unit tests.

## Usage

### Subagents (agent tools)

The model can use these tools — you'll usually just ask it to spawn a subagent:

- `subagent {id, task, workingDir?, interactive?, timeout?}` — spawn a background pi subagent. Give it a short id (`cr-review`, `coverage-check`) and a self-contained task. Live progress appears in a widget; results auto-inject as a message when done.
  - `interactive: true` — spawn a full interactive pi in a herdr pane (or tmux window) you can steer; requires herdr or tmux.
  - `timeout` — minutes before the subagent is auto-killed (default 10).
- `subagent_status` — list running subagents with elapsed time, mode, current activity, and usage.
- `subagent_kill {id}` — terminate a running subagent.

### Resuming crashed subagents (user command)

```bash
/resume-subagent          # pick a crashed session to resume (switches into it)
/resume-subagent list     # show saved crash files with relative times
/resume-subagent purge    # delete all saved crash files
```

### Side panes (agent tool)

- `split_pane {command, name, cwd?, direction?}` — run a long-running process in its own named side pane. `command` is the exact shell command (env vars, `&&`, pipes all work); `name` is the pane label shown in the tab strip (e.g. `api`, `storybook`, `watcher`); `direction` is `right` (default) or `down`. Ctrl-C in the pane stops the process.

### Other tools and commands

- `context_prune {tool_use_id, summary}` — the agent replaces bulky tool results (search hits, long reads) with a short summary to free context.
- `daily_log {entry}` — appends a timestamped entry to today's note (see env vars below).
- `/ss [prompt]` — grab the clipboard image and send it to the agent; `/ss <path> [prompt]` sends an image file.
- `/mdview [path]` — render a markdown file in the terminal; `/mermaid` — render mermaid from a file or stdin. Ctrl+O on a `.md` file while reading/editing shows the rendered preview.

### Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `PI_TAB_LABEL` | — | Pins the tab/session label (set by the subagent spawner for interactive runs) |
| `DAILY_LOG_DIR` | `~/daily-notes` | Directory for daily notes |
| `DAILY_LOG_SECTION` | `## Journal` | Section header new entries are appended under |
| `DAILY_LOG_TEMPLATE` | — | Path to a template file for new notes |
| `DAILY_LOG_CREATE_CMD` | — | Shell command to create new notes (receives `DATE` env var) |

## Requirements

- pi 0.57+ (peer dependency)
- **Subagents** — background mode works anywhere; `interactive: true` needs herdr (preferred) or tmux
- **Split Pane** — pi running inside herdr or tmux (it refuses to run otherwise, so the process stays visible)
- **Auto Title** — works standalone; herdr naming needs `herdr` on PATH with `HERDR_ENV=1`, tmux fallback needs `tmux`
- **Screenshots** — kitty terminal with `clipboard_control read-clipboard`, tmux with `allow-passthrough on`, `~/.local/bin/kitten` on the remote
- **Mermaid rendering** — internet access (uses the mermaid.ink API)

## Development

```bash
npm ci            # install deps
npm test          # typecheck (tsc --noEmit) + unit tests
npm run build     # bundle all extensions to dist/*.js
npm run dev       # rebuild dist/*.js on change (watch mode)
```

## License

MIT
