# codex-feishu-bridge

`codex-feishu-bridge` is a Feishu-native control surface for real local Codex sessions. Feishu is the chat UI, Codex is the execution engine, and native Codex sessions remain the only source of truth for conversation state. The bridge keeps only conversation-to-session bindings, project/runtime metadata, and transport state; it should not invent a second assistant or replay history to fake continuity.

## Refs & Docs

- Main project doc: [`README.md`](./README.md)
- Sibling bridge reference: `../claude-feishu-bridge/`
- Codex app-server product docs: <https://developers.openai.com/codex/app-server>
- Codex app-server implementation reference: <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>
- Feishu long connection docs: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode>
- Feishu CardKit streaming docs: <https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview>

## Development / Install

- Build + Install + Start: `./install.sh --yes`
- Deps: `npm install`
- Local dev: `npm run dev`
- Service template: [`deploy/systemd/codex-feishu-bridge.service.in`](./deploy/systemd/codex-feishu-bridge.service.in)
- Main config template: [`deploy/config/config.json`](./deploy/config/config.json)

## Testing

- Typecheck/build: `npm run build`
- Full tests: `npm test`
- Gateway-focused tests: `npm test -- --test-name-pattern='buildRenderPlan|splitMessageText|renderOutgoingBody'`
- Command parser tests: `npm test -- --test-name-pattern='command-router'`

## Tips

- Be proactive: when a durable rule changes, update this file briefly; keep details in `README.md` or `docs/`.
- Prefer simple first, then one step more.
- Prefer `app-server` backend; it is the main path now.
- Keep output/rendering decisions centralized. Message-level body modes such as raw markdown or raw text should be marked in the app layer and rendered once in the Feishu gateway.
- For fenced output, use the shared dynamic-fence rule: fence length is `max(3, longest backtick run + 1)`.
- Local command output is usually normal rendered markdown containing fenced `text` blocks, not raw-body mode.
- Reserve `--raw-markdown` for source-shaped replies; keep short state/mutation commands rendered normally.
- Keep `/rename` native in `app-server`.
- Useful runtime checks:
  - `systemctl --user status codex-feishu-bridge.service`
  - `systemctl --user cat codex-feishu-bridge.service`
  - `which -a codex-feishu-bridge`
