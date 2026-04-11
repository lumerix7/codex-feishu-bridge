# codex-feishu-bridge

Feishu-native control surface for real Codex sessions.

Routes Feishu messages into local Codex sessions and streams Codex output back without inventing a second conversation layer.

## Quick Start

For the full local install plus Feishu app/robot setup, see [`docs/bridge-install-setup-guide.md`](./docs/bridge-install-setup-guide.md).

Install or update the bridge from this checkout:

```bash
./install.sh --yes
```

Then fill in Feishu credentials in:

```bash
~/.config/codex-feishu-bridge/bridge.env
```

For local development without the user service:

```bash
cp .env.example .env
npm install
npm run dev
```

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

- `/help` show commands
- `/status [check-update] [-h|--help]` show current session and run state
- `/new [-C|--cd <dir>] [-h|--help]` create and bind a fresh Codex session
- `/fork [<session-id>|options] [-h|--help]` fork a Codex session and bind the new fork
- `/session [<session-id>|list [options]] [-h|--help]` show the current session, inspect a specific session, or browse recent sessions
- `/resume [<session-id>|options] [-h|--help]` bind a session, or start fresh with `/new -C <dir>` for a different project
- `/stop [-h|--help]` stop the current active run

### Codex

- `/compact [-h|--help]` compact the current bound Codex session
- `/rename [--session <session-id>] ['name'|-- name] [-h|--help]` show or change a native Codex thread name
- `/summary [-h|--help]` show the current bound Codex conversation summary
- `/diff [-h|--help]` show the latest app-server turn diff for the current bound session
- `/skills [list|reload] [-h|--help]` show Codex skills visible for the current project
- `/config [codex-toml] [--layers] [-h|--help]` show key Codex config values for the current project
- `/approvals [mode] [-h|--help]` show or change Codex approvals for future runs
- `/search [on|off] [-h|--help]` show or change live web search for this conversation
- `/model [list [--no-hidden]|name] [--reasoning <level>] [-h|--help]` show, list, or change the native Codex model for the current session
- `/profile [name|clear] [-h|--help]` show or change the Codex profile for this conversation
- `/plan [mode] [-h|--help]` show or change the Codex collaboration mode for this conversation

### Project

- `/project [list|bind [options]|unbind <path>] [-h|--help]` show the current project or manage project bindings
- `/git [args...]` run `git` directly in the current bound project
- `/cat`, `/cp`, `/find`, `/head`, `/ln`, `/ls`, `/mkdir`, `/mv`, `/pwd`, `/readlink`, `/rg`, `/rmdir`, `/sha256sum`, `/tail`, `/tar`, `/touch`, `/tree`, `/trash`, `/trash-list`, `/trash-restore`, `/wc` run local project commands
- `commands.alias` can expose or expand local slash commands such as `/todo` -> `todoist-cli` or `/ls` -> `ls -A`; `commands.direct` exposes identity commands such as `/systemctl`

### Diagnostics

- `/thread [--turns] [-h|--help]` show app-server thread metadata for the current bound session
- `/feishu [ws|send|doctor] [-h|--help]` show Feishu websocket and outbound send diagnostics
- `/log [-n <count>] [--since <expr>] [--grep <text>] [-h|--help]` show recent bridge service logs from systemd journal

## Status

Working v1 bridge:

- Feishu long-connection receive/send
- DM receive plus interactive-card replies
- conversation to native Codex session binding
- `/help` `/status` `/thread` `/compact` `/rename` `/summary` `/diff` `/skills` `/config` `/new` `/resume` `/session` `/stop` `/project` `/approvals` `/feishu` `/log`
- `/search` `/model` `/profile`
- `/git` `/cat` `/cp` `/find` `/head` `/ln` `/ls` `/mkdir` `/pwd` `/readlink` `/rg` `/rmdir` `/sha256sum` `/tail` `/tar` `/touch` `/tree` `/trash` `/trash-list` `/trash-restore` `/wc`
- extra local slash commands can be configured with `commands.alias` and `commands.direct` in `config.json`; legacy `commands.map` is still accepted as aliases
- `/new -C <path>` to switch/bind to another project and create a fresh session in one step
- `/project bind <path>` to rebind a conversation to another directory under the allowed project roots
- `/project bind -n <index>` to bind from `/project list`, which shows the merged bound-and-trusted project set
- `/project unbind <path>` to remove stored bridge bindings for a specific project path; the current conversation project is rejected
- `/approvals` to switch the Codex approval mode used for future runs
- `/model list [--no-hidden]` to query available models from Codex app-server when supported, with a bridge-side fallback list otherwise
- `/thread` to show richer app-server thread metadata for the current bound session
- `/compact` to trigger native Codex thread compaction in `app-server` mode for the current bound session
- `/rename` to show the native Codex thread name for the current bound session; use `--session <session-id>` to inspect or rename another session without rebinding
- `/summary` to read the native Codex conversation summary for the current bound session
- `/diff` to show the latest `turn/diff/updated` payload cached by the bridge
- `/skills` to query native Codex `skills/list` for the current project
- `/config` to query native Codex `config/read` for the current project
- `/config codex-toml` to show a redacted raw view of `~/.codex/config.toml`
- `/log [-n N] [--since <expr>] [--grep <text>]` to tail recent bridge service logs from systemd journal
- `/feishu`, `/feishu ws`, `/feishu send`, and `/feishu doctor` to inspect Feishu websocket readiness, outbound retry/failure counters, and a quick transport health verdict
- `/status check-update` to show a minimal Codex and dependency update view with current vs latest published npm versions
- backend modes: `app-server` and `spawn`

## Feishu Transport Notes

- Inbound Feishu events use long-connection mode over the Feishu SDK websocket client.
- Outbound bridge replies use Feishu HTTPS OpenAPI calls. Streaming replies use CardKit streaming update APIs over HTTPS.
- The bridge now uses keep-alive HTTP/HTTPS agents for Feishu SDK transport and detaches inbound event processing from the websocket callback so the handler returns quickly.
- `/feishu` is the quickest way to inspect recent websocket readiness, reconnect state, inbound message timing, and outbound retry/failure counters.
- Warning: Feishu client rendering for large fenced output is not fully consistent across desktop/mobile or all content shapes; see [`docs/feishu-rendering-caveats.md`](./docs/feishu-rendering-caveats.md).

Useful official references:

- Long connection mode: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode>
- Handle events: <https://open.feishu.cn/document/server-side-sdk/python--sdk/handle-events>
- Handle callbacks: <https://open.feishu.cn/document/server-side-sdk/python--sdk/handle-callbacks>
- Scenario examples: <https://open.feishu.cn/document/server-side-sdk/python--sdk/scenario-example>
- Message create API: <https://open.feishu.cn/document/server-docs/im-v1/message/create>
- CardKit streaming updates: <https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview>

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
- `codex-feishu-bridge` is also a normal CLI entrypoint exposed by the package `bin` field.
  After install, it may appear on your shell `PATH` at your npm global prefix, such as
  `/path/to/node/bin/codex-feishu-bridge`, `/usr/local/bin/codex-feishu-bridge`, or a user-local
  npm bin directory.
- The current user service also uses that npm-global binary path for `ExecStart`. This is normal,
  but it means the same command name may exist both as a service target and as an interactive
  shell command on hosts where the npm global bin directory is on `PATH`.
- If you want to inspect which one your shell resolves, use:

```bash
which -a codex-feishu-bridge
readlink -f "$(command -v codex-feishu-bridge)"
systemctl --user cat codex-feishu-bridge.service
```

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
- In `spawn`, `codex.sandboxMode = "workspace-write"` maps to Codex `--full-auto`.
- In `spawn`, `codex.sandboxMode = "danger-full-access"` maps to Codex `--dangerously-bypass-approvals-and-sandbox`.
- In `app-server`, `codex.sandboxMode = "default"` maps to `sandbox=workspace-write` plus `approvalPolicy=on-request`.
- In `app-server`, `codex.sandboxMode = "danger-full-access"` maps to `sandbox=danger-full-access` plus `approvalPolicy=never`.
- In `app-server`, only `default` and `full-access` are advertised in `/approvals`.
  `auto` is still accepted as a compatibility alias for `default`.
- In `app-server`, the bridge completes the native `initialize` → `initialized` handshake on each subprocess connection.
- In `app-server`, retryable overload replies (`code -32001`) are retried with jittered backoff in the bridge client.
- In `app-server`, native `thread/list` calls now follow `nextCursor` pagination instead of reading only one page.
- In `app-server`, `/model list` now uses the native `model/list` RPC when available, follows `nextCursor`, and includes hidden models by default unless `--no-hidden` is passed.
- In `app-server`, `/compact` uses the native `thread/compact/start` RPC and then reads the updated conversation summary.
- In `app-server`, `/rename` uses the native `thread/name/set` RPC and then reads the updated thread metadata.
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
- `feishu.titleMaxLength` controls how long Feishu card titles may grow before the bridge shortens them as `begin...end`. The checked-in default is `120`.
- `feishu.footerThreadNameMaxLength` controls how long footer thread names may grow before the bridge shortens them as `begin...end`. The checked-in default is `50`.
- `codex.outputSoftLimit` controls when local bridge command output such as `/git`, `/rg`, `/find`, `/log`, and similar results will be cut off with `[output truncated]`. The checked-in default is `100000`.
- `codex.modelListMaxCount` controls how many entries `/model list` will fetch at most while following app-server `model/list` pagination. The checked-in default is `100`.
- `session.listMaxCount` controls the maximum number of entries `/session list`, `/resume list`, and `/fork list` will return. The checked-in default is `100`.
- `project.listMaxCount` controls how many entries `/project list` will return at most from the merged bound-and-trusted project set. The checked-in default is `100`.
- `/feishu ws` and `/feishu doctor` include reconnect counters so you can tell the difference between an occasional reconnect and a flapping long-connection session.
- Outbound Feishu replies currently use interactive cards with a schema `2.0` markdown body, card title, chat-list summary, and per-reply header template color.
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
  - `## Dependencies`
    - `### Feishu`
    - `### dotenv`
- In the update-only view, non-OK update states are emphasized and available updates use a warning card.
- Time values shown by the bridge now use local ISO timestamps with timezone offsets, for example:
  - `2026-03-01T10:35:00+08:00`
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
- `/help` and `/session --raw-markdown` keep the raw fenced markdown appendix for debugging and exact markdown inspection.
- `--raw-markdown` is for source-shaped replies where exact markdown structure matters; short state or mutation commands such as `/rename` should render normally instead.
- Other bridge replies and Codex streams render without the raw markdown appendix and keep only the rendered markdown plus footer/meta block.
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
