# Feishu DM V1 Event Flow

> Historical note. This file used to describe the earliest DM-only text-in/text-out flow. The current bridge now supports richer command handling, streaming cards, and app-server integration.

## Original minimal flow

1. Receive a Feishu DM event.
2. Normalize it into the bridge input shape.
3. Resolve the conversation key.
4. Route command vs Codex turn.
5. Create or reuse the bound Codex session.
6. Send the turn to Codex.
7. Return the reply to Feishu.

## Current flow differences

- inbound events still enter through Feishu long-connection websocket mode
- outbound replies are now HTTPS card sends, usually streaming-first
- command replies may use synthetic streaming
- Codex `app-server` replies use real upstream stream updates
- approvals and user-input requests may round-trip through Feishu in `app-server` mode
- `/status` and `/feishu` expose richer runtime diagnostics than the original v1 flow expected

## Current references

- `../README.md` for the live behavior
- `feishu-adapter-contract.md` for transport boundary intent
- `message-session-model.md` for conversation/session mapping
