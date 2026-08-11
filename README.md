# pi-essentials

Essential extensions for [pi](https://github.com/earendil-works/pi). Quality-of-life improvements that every setup should have.

This is a fork of [samfoy/pi-essentials](https://github.com/samfoy/pi-essentials) (published on npm as `@samfp/pi-essentials`). It keeps the upstream extensions and adds durable subagents, herdr-first pane tooling, `split_pane`, smarter tab/session naming, and a few other fixes (see [What's new in this fork](#whats-new-in-this-fork)).

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

## What's included

| Extension | What it does |
| --- | --- |
| **Subagent** | `subagent`, `subagent_status`, and `subagent_kill` tools that spawn durable background or interactive pi subagents whose results auto-inject back |
| **Split Pane** | `split_pane` tool that runs any long-running local process (dev server, watcher, notebook…) in a named side pane beside the agent |
| **Auto Session Name** | Names sessions from the first user message as a short hyphenated slug, so you don't get `unnamed-session-1` or a truncated sentence |
| **Auto Title** | Names the host terminal tab/pane from that same slug (herdr preferred, tmux fallback) |
| **Compact Header** | Clean table-style startup header with pi version, model, thinking level, prompts, skills, and keybinding reference |
| **Clipboard Image** | Paste base64 image data (PNG/JPEG) directly into the prompt |
| **Image Context Pruner** | Strips images from older messages to save context tokens |
| **Markdown Viewer** | Rendered markdown preview on Ctrl+O for `.md` files, plus `/mdview` and `/mermaid` commands |
| **Screenshot** | `/ss` command to grab a clipboard image or send a file to the agent. Requires kitty terminal + `kitten` binary |
| **Context Pruner** | `context_prune` tool that lets the agent replace bulky search results with short summaries to free context space |
| **Daily Log** | `daily_log` tool that appends timestamped entries to a daily markdown note (configurable via env vars) |
| **Meat** | `/meat` command (run [meat](https://github.com/boldsoftware/meat), save to `.meat/latest.diff`, inject the reading diff), plus `meat_annotate` tool + `/meat-annotate` command that open the reading diff in the [Plannotator](https://github.com/backnotprop/plannotator) browser UI (via its official pi extension's shared event API) and return the user's verdict + annotations to the agent |
| **Token Tracker** | `token_tracker` tool + `/tokens` command that aggregate LLM token usage and cost per model — pi's own usage parsed from session transcripts, plus the opencode CLI's ledger queried directly from its SQLite database |
| **Handoff** | `/handoff <topic>` writes a session handoff doc (git state and session file auto-gathered, agent authors the summary); `/handoff` in a new session picks a doc and injects it as the first message — no manual "read the handoff" instruction |
| **BTW** | `/btw` side-chat popover for quick tangential questions, with thread restore/reset and optional summary injection into the main chat |
| **Files** | `/files` browser (also Ctrl+Shift+O) with git status and session file references, plus reveal/Quick Look/open/edit/diff-in-VS-Code actions; Ctrl+Shift+R Quick Looks the latest referenced file |
| **Goal** | `/goal <objective>` long-running objective mode with automatic continuation and the `get_goal`, `create_goal`, `update_goal` tools; token/time budgets, session-log persistence |
| **Unified Edit** | Replaces the built-in `edit` tool with a single text payload supporting marked row edit scripts (`[file]` headers, `@REPLACE`/`@INS.PRE`/`@INS.AFTER`/`@DEL`/`@APPEND`) and Codex-style `*** Begin/End Patch` patches, with preflight validation and live diff preview |
| **No Sleep** | `/no-sleep` macOS `caffeinate` integration that prevents sleep while an agent turn or the whole session is active (`PI_NO_SLEEP`/`PI_NO_SLEEP_SCOPE`/`PI_NO_SLEEP_DISPLAY` env vars) |
| **Split Fork** | `/split-fork [prompt]` branches the current session into a new pi process in a right-hand Ghostty split (macOS) |
| **Whimsical** | Replaces the default thinking/status text with a random whimsical phrase while the agent works (`Combobulating...`, `Bribing the byte fairies...`) |

## Skills

The package ships two agent skills (loaded on-demand from `skills/`):

- **commit** — guidance for making concise Conventional Commits-style git commits with good subjects and bodies (read before any commit)
- **frontend-design** — create distinctive, production-ready frontend UI with strong visual direction: typography, color, layout, motion systems, and a self-validation checklist

## What's new in this fork

On top of the upstream extension set:

- **Agent-stuff port.** `/btw`, `/files`, `/goal`, unified `edit`, `/no-sleep`, and `/split-fork` plus the `commit` and `frontend-design` skills are ported from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) and adapted to pi 0.83's API (the `goal` tool schema uses `Type.Union` literals instead of `StringEnum`, and the BTW resource loader implements 0.83's source-returning methods). Note that the **unified edit extension replaces pi's built-in `edit` tool** — remove `./dist/unified-edit.js` from `package.json` to keep the built-in.
- **Herdr compatibility.** Interactive subagents, `split_pane`, and auto-title prefer [herdr](https://herdr.dev/) when pi is running inside it (`HERDR_ENV=1`). Upstream interactive subagents were tmux-only; this fork detects herdr first, drives `herdr pane` / `herdr agent` / `herdr tab`, and falls back to tmux when herdr isn't present.
- **Durable subagents.** Background runs persist their transcript under `~/.pi/agent/subagent-sessions/`. On a clean finish the file is deleted; on a crash, kill, or API-credit death it survives and can be resumed with `/resume-subagent`. Runs stream JSON events for a live progress widget showing turns, token usage, cost, and model.
- **Interactive subagents.** `subagent` with `interactive: true` spawns a steerable pi session in its own pane via `herdr agent start` when inside herdr, otherwise a tmux window. Results still auto-inject when done. The pane/tab is named after the task.
- **`subagent_kill` + timeouts.** Kill a subagent by ID or let it auto-kill after a timeout (`timeout` param, default 10 minutes).
- **Failure diagnostics.** Crashed runs report exit code, signal, stderr, a trail of the tool calls it made, and partial output. Event logs are kept at `/tmp/subagent-<id>-events.jsonl` for post-mortem (`jq . < file`).
- **`split_pane` tool.** Splits a named side pane (herdr preferred, tmux fallback) and runs any long-running command in its interactive shell: `./gradlew bootRun`, `flutter run`, `docker compose up`, `npm run dev`… The agent pane keeps focus; logs stream in the pane and Ctrl-C there stops the process. Dedups by pane `name`: if a pane with the same name already exists in the current tab, it reuses that pane instead of splitting a duplicate (the model's context is lossy, so the tool checks the mux itself — pass `force: true` for a second instance).
- **Slug-based tab/session names.** Auto-title and auto-session-name share one `titleFromPrompt` policy that turns a long first message into a 3-4 word hyphenated slug (`fix-login-page`) instead of truncating the sentence. Auto-title refreshes when the session gets a proper name (e.g. from auto-session-name or `/name`), and renames the herdr pane *and* its tab, or the tmux window/pane.
- **`PI_TAB_LABEL` integration.** The subagent spawner sets `PI_TAB_LABEL` on interactive subagent panes so the tab and session show the task instead of the framed prompt; auto-title and auto-session-name honor it.
- **Smarter compact header.** Resolves the *host* pi version by walking up from the running binary (the linked package can lag behind), and shows provider, model, thinking level, available prompts and skills.
- **Precompiled build.** All extensions are bundled to `dist/*.js` with esbuild so pi loads them without per-startup jiti transpilation; `npm test` runs `tsc --noEmit` plus unit tests.
- **Meat.** One extension for the meat reading-diff abridger: `/meat` runs it and injects the abridged diff into the conversation (full output saved to `.meat/latest.diff`), while `meat_annotate` / `/meat-annotate` run meat and open the reading diff in Plannotator's browser annotation UI over the shared `plannotator:request` event channel of the official `@plannotator/pi-extension`. Blocks until the user approves, annotates, or closes; the verdict and feedback come back to the agent as instructions. The opencode backend work in meat is orthogonal — this works with whatever model backend meat uses today.
- **Token tracker.** `token_tracker` tool + `/tokens` command report per-model token usage and cost from two streams: pi's own session transcripts (`~/.pi/agent/sessions`, `subagent-sessions` — every assistant message carries provider/model/usage) and the opencode CLI's SQLite ledger (`~/.local/share/opencode/opencode.db`, the data behind `opencode stats`, queried via `node:sqlite`). Model variants merge; `--days N` and `--source pi|opencode|all` filter the report.

## Usage

### Subagents (agent tools)

The model can use these tools. You'll usually just ask it to spawn a subagent:

- `subagent {id, task, workingDir?, interactive?, timeout?}`: spawn a background pi subagent. Give it a short id (`cr-review`, `coverage-check`) and a self-contained task. Live progress appears in a widget; results auto-inject as a message when done.
  - `interactive: true`: spawn a full interactive pi in a herdr pane (or tmux window) you can steer; requires herdr or tmux.
  - `timeout`: minutes before the subagent is auto-killed (default 10).
- `subagent_status`: list running subagents with elapsed time, mode, current activity, and usage.
- `subagent_kill {id}`: terminate a running subagent.

### Resuming crashed subagents (user command)

```bash
/resume-subagent          # pick a crashed session to resume (switches into it)
/resume-subagent list     # show saved crash files with relative times
/resume-subagent purge    # delete all saved crash files
```

### Side panes (agent tool)

- `split_pane {command, name, cwd?, direction?, force?}`: run a long-running process in its own named side pane. `command` is the exact shell command (env vars, `&&`, pipes all work); `name` is the pane label shown in the tab strip (e.g. `api`, `storybook`, `watcher`); `direction` is `right` (default) or `down`. Ctrl-C in the pane stops the process. If a pane with the same `name` already exists in the current tab, the tool points you at it instead of splitting a duplicate (pass `force: true` to split a second instance anyway).

### Other tools and commands

- `context_prune {tool_use_id, summary}`: the agent replaces bulky tool results (search hits, long reads) with a short summary to free context.
- `/meat [meat args]`: run the meat reading-diff abridger on the current repo (e.g. `/meat HEAD~3`, `/meat -staged`, `/meat -w`, `/meat -no-cache`, `/meat -model opencode/claude-sonnet-4-6`). Saves the full output to `.meat/latest.diff` and injects the abridged diff into the conversation for review. Default with no args is HEAD (not working-tree WIP); meat caches identical diffs under `~/.meat`.
- `meat_annotate {revision?, staged?, working?, content?, title?, noCache?}`: runs `meat` to abridge a diff (latest commit by default; pass a sha/range, `staged`, or `working`), opens the reading diff in the Plannotator browser UI (Approve / Annotate / Close gate — input is blocked until then), and returns the verdict + feedback for the agent to act on. The review doc puts the whole meat reading-diff in one code fence so Plannotator shows it as monospace code with real line breaks; long lines soft-wrap at 100 cols with a `↳` continuation marker. Pass `content` to annotate existing text without running meat; `noCache: true` forces a fresh meat run. Honors abort and a UI timeout so a dead browser session cannot pin the agent turn forever.
- `token_tracker {days?, source?}`: aggregate LLM token usage and cost per model. `days` limits the window to the last N days (default: all time); `source` is `pi` (parsed from session transcripts), `opencode` (queried from opencode's SQLite ledger), or `all` (both + a combined total). Answers "how many tokens / how much did we spend".
- `/handoff <topic>`: end-of-session handoff. Gathers the session's mechanical state (branch, working tree, diff stat, recent commits, session file path) and asks the agent to write `handoff/handoff-<topic>.md` using a fixed template. `/handoff` with no args (or `/handoff resume`) lists saved docs, picks one, and injects it as the first user message of the new session — the agent starts with full context, no manual instruction needed. `/handoff list` and `/handoff delete` manage the docs. A one-line hint appears at session start (startup or `/new`) when unread handoff docs exist in the project — resuming a doc marks it consumed, so the hint stops showing it until the doc is updated again (state in `handoff/.handoff-state.json`). Docs live in `handoff/` (gitignored) by default; `PI_HANDOFF_DIR` overrides the directory.
- `/tokens [--days N] [--source pi|opencode|all]`: command form of `token_tracker`; injects the same report into the conversation.
- `/meat-annotate [revision|range|-staged|-w|-no-cache]`: same flow as `meat_annotate`, driven from the prompt; the verdict is shown as a notification.
- `daily_log {entry}`: appends a timestamped entry to today's note (see env vars below).
- `/ss [prompt]`: grab the clipboard image and send it to the agent; `/ss <path> [prompt]` sends an image file.
- `/mdview [path]`: render a markdown file in the terminal; `/mermaid`: render mermaid from a file or stdin. Ctrl+O on a `.md` file while reading/editing shows the rendered preview.
- `/btw [question]`: open a side-chat popover for quick tangential questions (Esc closes). `/btw` with an existing thread asks whether to continue it or start fresh; closing with a thread offers to inject a summary of it into the main chat. Threads persist in the session log.
- `/files`: browse files with git status and session references — type to filter, Enter to pick, Ctrl+Shift+D to diff in VS Code, then reveal in Finder / open / Quick Look / edit in `$EDITOR` / add `@path` to the prompt. Ctrl+Shift+O is the same browser; Ctrl+Shift+R Quick Looks the latest file referenced in the session.
- `/goal <objective>`: set a long-running objective. The agent auto-continues toward it across turns (usage/budget accounting in the status line), with `get_goal`/`create_goal`/`update_goal` tools for the model, and `/goal edit|pause|resume|clear` for you. Budgets and blocked/complete status flow through `/goal` messages.
- `edit` (agent tool): accepts one `text` payload — a marked row script (`[path]` headers, `@REPLACE`/`@INS.PRE N`/`@INS.POST N`/`@INS.BEFORE`/`@INS.AFTER`/`@DEL N-M`/`@APPEND` with `+`/`-` rows) or a Codex-style `*** Begin Patch` … `*** End Patch` patch. Validates everything before touching files and shows a live diff preview in the tool header.
- `/no-sleep [status|on|off|toggle|agent|session]`: prevent macOS sleep via `caffeinate` while the agent is running (default scope) or for the whole session. `PI_NO_SLEEP_DISPLAY=1` also keeps the display awake; the assertion dies with the pi process.
- `/split-fork [prompt]`: fork the current session (committed state only) into a new pi process in a right-hand Ghostty split; the fork resumes from the same session branch.

### Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `PI_TAB_LABEL` | - | Pins the tab/session label (set by the subagent spawner for interactive runs) |
| `HERDR_ENV` / `HERDR_PANE_ID` / `HERDR_TAB_ID` | set by herdr | Detected automatically when pi runs inside herdr; not something you set by hand |
| `DAILY_LOG_DIR` | `~/daily-notes` | Directory for daily notes |
| `DAILY_LOG_SECTION` | `## Journal` | Section header new entries are appended under |
| `DAILY_LOG_TEMPLATE` | - | Path to a template file for new notes |
| `DAILY_LOG_CREATE_CMD` | - | Shell command to create new notes (receives `DATE` env var) |
| `MEAT_BIN` | `meat` | Path to the meat binary used by the meat extension |
| `MEAT_ANNOTATE_TIMEOUT_MS` | `1200000` (20 min) | Timeout for the meat phase |
| `MEAT_ANNOTATE_UI_TIMEOUT_MS` | `1800000` (30 min) | Timeout waiting on the Plannotator browser decision; abort also cancels |
| `PI_AGENT_DIR` | `~/.pi/agent` | Where pi session transcripts live (sessions + subagent-sessions subdirs) for the token tracker |
| `OPENCODE_DATA_DIR` | `~/.local/share/opencode` (or `$XDG_DATA_HOME/opencode`) | Where opencode keeps `opencode.db`, its usage ledger, for the token tracker |

## Requirements

- pi 0.57+ (peer dependency)
- **Meat.** Needs `meat` on PATH (`go install meat.dev/cmd/meat@latest`) with API keys for its model backend; the annotate flows additionally need the official Plannotator pi extension installed (`pi install npm:@plannotator/pi-extension`).
- **Token Tracker.** The pi stream needs nothing extra (it reads pi's own session transcripts). The opencode stream needs the opencode CLI's ledger (`~/.local/share/opencode/opencode.db`, created by opencode 1.x) and Node ≥ 22.5 for `node:sqlite`.
- **Herdr (preferred) or tmux.** Interactive subagents, `split_pane`, and herdr tab naming need one of these. Herdr wins when `HERDR_ENV=1` and `HERDR_PANE_ID` are set; otherwise tmux is used when available.
- **Subagents.** Background mode works anywhere; `interactive: true` needs herdr or tmux.
- **Split Pane.** Pi must be running inside herdr or tmux (it refuses to run otherwise, so the process stays visible).
- **Auto Title.** Works standalone for OSC title escape sequences; herdr naming needs `herdr` on PATH inside a herdr pane, tmux fallback needs `tmux`.
- **Screenshots.** Kitty terminal with `clipboard_control read-clipboard`, tmux with `allow-passthrough on`, `~/.local/bin/kitten` on the remote.
- **No Sleep.** macOS only (uses the built-in `caffeinate`).
- **Split Fork.** macOS + [Ghostty](https://ghostty.org/) (drives it via AppleScript); the forked process runs `pi --session …` from the split's working directory.
- **Mermaid rendering.** Internet access (uses the mermaid.ink API).

## Development

```bash
npm ci            # install deps
npm test          # typecheck (tsc --noEmit) + unit tests
npm run build     # bundle all extensions to dist/*.js
npm run dev       # rebuild dist/*.js on change (watch mode)
```

## License

MIT
