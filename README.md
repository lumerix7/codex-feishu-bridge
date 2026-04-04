# codex-feishu-bridge

Feishu-native control surface for real Codex sessions.

Routes Feishu messages into local Codex sessions and streams Codex output back without inventing a second conversation layer.

## Goal

`codex-feishu-bridge` forwards Feishu input into real Codex sessions and sends Codex output back to Feishu. Codex native sessions are the single source of truth for conversation state.

## Principles

- Feishu is the control surface.
- Codex is the execution engine.
- Codex native sessions are the only session truth.
- The bridge stores only bindings and runtime metadata.
- Do not replay message history to simulate continuity.
- Do not create a second assistant/session abstraction above Codex.

## Scope

### In scope
- Feishu bot websocket ingress
- DM-first message handling
- Feishu conversation/thread to Codex session binding
- Create/resume/stop native Codex sessions
- Stream Codex output back to Feishu
- Minimal command set for control and status
- Small local metadata store for bindings and active-run locks

### Out of scope (initially)
- Broad plugin platform
- Independent long-term memory system
- Synthetic conversation storage
- Multi-provider orchestration
- Heavy card UX or product shell behavior
- Image-first message support beyond plain text/card rendering; this is worth revisiting later, but it likely increases token and payload cost enough that it should stay opt-in

## Commands

### Core

- `/help [-h|--help]` show commands
- `/status [check-update] [-h|--help]` show current session and run state
- `/new [-C|--cd <dir>] [-h|--help]` create and bind a fresh Codex session
- `/fork [<session-id>|options] [-h|--help]` fork a Codex session and bind the new fork
- `/session [list [options]] [-h|--help]` show the current session or browse recent sessions
- `/resume [<session-id>|options] [-h|--help]` bind a session, or start fresh with `/new -C <dir>` for a different project
- `/stop [-h|--help]` stop the current active run

### Codex

- `/compact [-h|--help]` compact the current bound Codex session
- `/summary [-h|--help]` show the current bound Codex conversation summary
- `/diff [-h|--help]` show the latest app-server turn diff for the current bound session
- `/skills [--reload] [-h|--help]` show Codex skills visible for the current project
- `/config [codex-toml] [--layers] [-h|--help]` show key Codex config values for the current project
- `/approvals [mode] [-h|--help]` show or change Codex approvals for future runs
- `/search [on|off] [-h|--help]` show or change live web search for this conversation
- `/model [--list|name|clear] [-h|--help]` show, list, or change the Codex model for this conversation
- `/profile [name|clear] [-h|--help]` show or change the Codex profile for this conversation

### Project

- `/project [list [options]|bind [options]|unbind <path>] [-h|--help]` show the current project or manage project bindings
- `/git [args...]` run `git` directly in the current bound project
- `/cat`, `/find`, `/head`, `/ls`, `/pwd`, `/rg`, `/sha256sum`, `/tail`, `/tree`, `/wc` run local project commands

### Diagnostics

- `/thread [--turns] [-h|--help]` show app-server thread metadata for the current bound session
- `/feishu [ws|send|doctor] [-h|--help]` show Feishu websocket and outbound send diagnostics
- `/log [-n <count>] [--since <expr>] [--grep <text>] [-h|--help]` show recent bridge service logs from systemd journal

## Status

Working v1 bridge:

- Feishu long-connection receive/send
- DM receive plus interactive-card replies
- conversation to native Codex session binding
- `/help` `/status` `/thread` `/compact` `/summary` `/diff` `/skills` `/config` `/new` `/resume` `/session` `/stop` `/project` `/approvals` `/feishu` `/log`
- `/search` `/model` `/profile`
- `/git` `/cat` `/find` `/head` `/ls` `/pwd` `/rg` `/sha256sum` `/tail` `/tree` `/wc`
- `/new -C <path>` to switch/bind to another project and create a fresh session in one step
- `/project bind <path>` to rebind a conversation to another directory under the allowed project roots
- `/project bind -n <index>` to bind from `/project list`, which is ordered current project first and then by project name ascending
- `/project unbind <path>` to remove stored bridge bindings for a specific project path; the current conversation project is rejected
- `/approvals` to switch the Codex approval mode used for future runs
- `/model --list [--no-hidden]` to query available models from Codex app-server when supported, with a bridge-side fallback list otherwise
- `/thread` to show richer app-server thread metadata for the current bound session
- `/compact` to trigger native Codex thread compaction in `app-server` mode for the current bound session
- `/summary` to read the native Codex conversation summary for the current bound session
- `/diff` to show the latest `turn/diff/updated` payload cached by the bridge
- `/skills` to query native Codex `skills/list` for the current project
- `/config` to query native Codex `config/read` for the current project
- `/config codex-toml` to show a redacted raw view of `~/.codex/config.toml`
- `/log [-n N] [--since <expr>] [--grep <text>]` to tail recent bridge service logs from systemd journal
- `/feishu`, `/feishu ws`, `/feishu send`, and `/feishu doctor` to inspect Feishu websocket readiness, outbound retry/failure counters, and a quick transport health verdict
- `/status check-update` to show a minimal Codex/Feishu update view with current vs latest published npm versions
- backend modes: `app-server`, `spawn`, and experimental `terminal`

## Feishu Transport Notes

- Inbound Feishu events use long-connection mode over the Feishu SDK websocket client.
- Outbound bridge replies use Feishu HTTPS OpenAPI calls. Streaming replies use CardKit streaming update APIs over HTTPS.
- The bridge now uses keep-alive HTTP/HTTPS agents for Feishu SDK transport and detaches inbound event processing from the websocket callback so the handler returns quickly.
- `/feishu` is the quickest way to inspect recent websocket readiness, reconnect state, inbound message timing, and outbound retry/failure counters.

Useful official references:

- Long connection mode: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode>
- Handle events: <https://open.feishu.cn/document/server-side-sdk/python--sdk/handle-events>
- Handle callbacks: <https://open.feishu.cn/document/server-side-sdk/python--sdk/handle-callbacks>
- Scenario examples: <https://open.feishu.cn/document/server-side-sdk/python--sdk/scenario-example>
- Message create API: <https://open.feishu.cn/document/server-docs/im-v1/message/create>
- CardKit streaming updates: <https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview>

## Run

1. Copy `.env.example` to `.env` and fill in Feishu credentials.
2. Install dependencies with `npm install`.
3. Start the bridge with `npm run dev`.

For a full local install from the current checkout, including package install, build, user unit install, and hard restart:

```bash
./install.sh
```

Or:

```bash
npm run install:local
```

## User Service

- Repo-owned systemd template: `deploy/systemd/codex-feishu-bridge.service.in`
- User config templates: `deploy/config/bridge.env.example` and `deploy/config/config.json`
- `config.json` is the primary bridge config. `bridge.env` is only for secrets,
  proxy/custom-CA settings, the config path, and similar process env.
- Optional startup-ready notification: set `FEISHU_STARTUP_NOTIFY_CHAT_ID` in `bridge.env`
  to get a one-time Feishu message after the websocket is connected and outbound
  message sending is working.
- Install or update the user service with:

```bash
./install.sh
```

- `install.sh` renders the current checkout path into the unit, writes the unit to:
  `~/.config/systemd/user/codex-feishu-bridge.service`
- `install.sh` builds a detached package payload, installs the global `codex-feishu-bridge`
  binary under your npm prefix, and points the user service at that binary.
- It preserves existing `~/.config/codex-feishu-bridge/bridge.env` and `config.json` if they
  already exist.
- Machine-specific proxy or custom CA settings should live in
  `~/.config/codex-feishu-bridge/bridge.env`, not in the repo-owned systemd unit template.
- Fresh installs rewrite the checked-in JSON template into a usable local config:
  `project.defaultPath` becomes the current checkout and `project.allowedRoots`
  includes that checkout.
- Project access is controlled by `project.allowedRoots`. `project.defaultPath`
  must stay under one of those allowed roots.
- `project.defaultSearchEnabled=true` makes new conversations and `/new`
  sessions default to live web search enabled.
- The checked-in JSON template defaults to `codex.backendMode = "app-server"`
  and `codex.sandboxMode = "danger-full-access"` for the lowest-friction
  bridge experience. Switch to `default` if you specifically want Feishu-mediated
  approval prompts.
- The script asks for confirmation, then installs or updates the unit, reloads user systemd,
  enables the service, and performs a hard restart.

For local testing without Feishu, run `npm run cli -- --chat-id test-terminal`. This uses the same binding logic as Feishu `p2p:<chat_id>` conversations, so the chosen `chatId` becomes the reusable bridge conversation key.

## Backend Mode

- `codex.backendMode = "app-server"` is the preferred backend now and the checked-in default for new installs.
- `app-server` keeps a local `codex app-server` subprocess per bound native session and talks to it over
  stdio JSON-RPC for `thread/start`, `thread/resume`, `turn/start`,
  `turn/interrupt`, approval callbacks, user-input requests, live token usage, thread/account reads, and model listing.
- Official Codex app-server docs: <https://developers.openai.com/codex/app-server>
- `codex.backendMode = "spawn"` starts one `codex exec` or `codex exec resume`
  process per turn while the bridge persists the native session id.
- `spawn` is still useful as a simpler fallback backend when you want fewer moving parts and do not need the richer `app-server` features.
- `spawn` now emits lightweight progress updates such as session start, thinking, long-run heartbeat, and upstream websocket retry notices when Codex exposes them.
- `codex.backendMode = "terminal"` is experimental. It is intended for a
  terminal-derived Codex experience projected into Feishu, but the current
  Codex interactive CLI is still a full-screen TUI and not yet reliable enough
  to use as the default backend.
- In `spawn`, `codex.sandboxMode = "workspace-write"` maps to Codex `--full-auto`.
- In `spawn`, `codex.sandboxMode = "danger-full-access"` maps to Codex `--dangerously-bypass-approvals-and-sandbox`.
- In `app-server`, `codex.sandboxMode = "default"` maps to `sandbox=workspace-write` plus `approvalPolicy=on-request`.
- In `app-server`, `codex.sandboxMode = "danger-full-access"` maps to `sandbox=danger-full-access` plus `approvalPolicy=never`.
- In `app-server`, only `default` and `full-access` are advertised in `/approvals`.
  `auto` is still accepted as a compatibility alias for `default`.
- In `app-server`, `/model --list` now uses the native `model/list` RPC when available, follows `nextCursor`, and includes hidden models by default unless `--no-hidden` is passed.
- In `app-server`, `/compact` uses the native `thread/compact/start` RPC and then reads the updated conversation summary.
- In `app-server`, `/summary`, `/skills`, and `/config` use native `getConversationSummary`, `skills/list`, and `config/read` RPCs.
- In `app-server`, `/diff` reads the latest cached `turn/diff/updated` notification for the bound session.
- `codex.approvalTimeoutMs` controls how long the bridge waits for a Feishu approval or user-input reply before sending a timeout-safe response back to Codex.
- `codex.runTimeoutMs` controls the maximum lifetime of one active Codex run
- `codex.compactTimeoutMs` controls how long the bridge waits for native `thread/compacted` when `/compact` is used
  before the bridge terminates it.
- `codex.spawn.statusIntervalMs` controls the heartbeat interval for long-running
  `spawn` turns. Set it to `0` to disable heartbeats.
- `feishu.sendRetry.maxAttempts`, `feishu.sendRetry.baseDelayMs`,
  `feishu.sendRetry.multiplier`, and `feishu.sendRetry.maxDelayMs` control
  retry/backoff for transient Feishu send failures such as `502`, `429`, and
  short network errors. `maxAttempts = 0` means one send attempt with no retry.
- `feishu.wsAutoReconnect` controls the Feishu SDK websocket auto-reconnect switch.
- `feishu.wsLoggerLevel` controls how much of the Feishu SDK websocket lifecycle is mirrored into the service logs. The checked-in default is currently `debug` for easier live troubleshooting, but `warn` is the quieter long-term setting if the host is stable.
- `feishu.wsAgent.keepAliveMsecs`, `feishu.wsAgent.maxSockets`, and `feishu.wsAgent.maxFreeSockets` control the keep-alive HTTP/HTTPS agent used by the Feishu SDK transport.
- `feishu.wsConnectWarnAfterMs` is the doctor threshold for “still not ready after startup”.
- `feishu.wsReconnectWarnThreshold` is the doctor threshold for repeated reconnects after startup.
- `feishu.reconnectReadyDebounceMs` controls how often the bridge may send a Feishu `Reconnected` ready card after websocket recovery.
- `feishu.titleMaxLength` controls how long Feishu card titles may grow before the bridge shortens them as `begin...end`. The checked-in default is `80`.
- `codex.modelListMaxCount` controls how many entries `/model --list` will fetch at most while following app-server `model/list` pagination. The checked-in default is `100`.
- `/feishu ws` and `/feishu doctor` include reconnect counters so you can tell the difference between an occasional reconnect and a flapping long-connection session.
- Outbound Feishu replies currently use interactive cards with a schema `2.0` markdown body, card title, chat-list summary, and per-reply header template color.
- `codex.terminal.flushIdleMs` controls the quiet window before terminal output
  is projected back to Feishu as one reply.
- `codex.terminal.flushMaxChars` caps one terminal-mode Feishu reply so noisy
  screens do not flood the chat.
- Numeric config values must be integers. Invalid values now fail fast during startup.

The bridge still accepts the old env-style JSON keys as a compatibility fallback,
but new config should use the structured schema.

## Feishu Rendering

- Inbound Feishu messages support both plain `text` and rich `post` payloads.
- Outbound replies are streaming-first when the bridge marks them as streaming, and otherwise use normal Feishu interactive cards.
- The card body keeps the same markdown content string the bridge generates, plus a raw fenced markdown appendix for clients that do not render every markdown feature consistently.
- Long replies are still split on markdown block boundaries so fenced code blocks stay valid across pages/chunks.

## Status Notes

- `/status` shows the normal three-section view:
  - `## Codex`
  - `## Bridge`
  - `## Feishu`
- `/status check-update` switches to a minimal two-section view:
  - `## Codex`
  - `## Feishu`
- In the update-only view, non-OK update states are emphasized.
- Time values shown by the bridge now use local ISO timestamps with timezone offsets, for example:
  - `2026-03-01T10:35:00.000+08:00`
- Rate-limit reset times in `/status` now use that same local ISO format.

## Streaming Replies

- The bridge now uses Feishu CardKit streaming cards first whenever a reply is marked as streaming.
- Bridge command replies such as `/status` use synthetic streaming for one-shot output:
  line-by-line when practical, with long lines split into smaller visible steps.
- Codex `app-server` replies use real upstream stream updates from Codex. The bridge accumulates text and updates one live Feishu card for the turn instead of sending a new card for each update.
- On the `app-server` path, bridge/Codex operational events such as approvals, tool calls, diffs, and command completions can be surfaced as separate side-band cards with `codex.appServer.sidebandCards`.
- Those same operational events can also be folded into the main live stream as rendered fenced blocks with `codex.appServer.inlineBlocks = "off" | "compact" | "full"`.
- `compact` keeps the inline blocks short and summary-oriented.
- `full` keeps the current full-detail inline rendering, including heavy raw payloads when Codex emits them.
- The checked-in defaults are:
  - `codex.appServer.sidebandCards = false`
  - `codex.appServer.inlineBlocks = "full"`
- The streamed card keeps the same final content shape as normal cards:
  rendered markdown, a raw fenced markdown appendix, and the footer/meta block.
- Large replies now use paged streaming cards first instead of dropping straight to normal chunked cards.
- If CardKit create or update fails, the bridge falls back to the normal interactive-card send path.
- Current practical limits:
  - one live streaming card per Codex reply context
  - one-shot oversized replies may span multiple streaming pages/cards
  - fallback to normal chunked cards still exists when the streaming path itself fails
  - live Codex delta updates are throttled before sending to Feishu to stay within CardKit update limits
- Required Feishu permission for streaming cards:
  - `cardkit:card:write`

## Codex Profile Mode

- `codex.profileMode = "isolated"` gives the bridge its own Codex home. This is
  the default in development and is the safest mode for testing.
- `codex.profileMode = "personal"` points the bridge at your personal `~/.codex`
  so Feishu and your local terminal can reuse the same Codex sessions.
- `personal + spawn` is currently a compatibility mode, not the safest one. It may interfere with an interactive Codex instance that is already running against the same home.

## Session Binding

- Feishu does not provide a native Codex session id. The bridge binds a Feishu conversation key to a Codex session id in its local store.
- `p2p` chats bind on `p2p:<chat_id>`.
- If a conversation already has a bound session, the bridge reuses it.
- If a run is already active for that conversation, the bridge rejects a second concurrent turn instead of guessing which live run to reuse.
- `/resume` can append recent thread history after a real session change with `--messages <count>`.
- The checked-in default is `session.resumeReplayCount = 5`.
