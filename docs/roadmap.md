# Roadmap

## Current state

Already implemented:

- Feishu websocket ingress plus HTTPS outbound replies
- persistent conversation/session binding
- `app-server` preferred backend
- `spawn` fallback backend
- streaming-first Feishu replies
- Feishu transport diagnostics via `/feishu`
- native-style status via `/status`
- session/project switching and session listing
- Feishu-mediated approvals for `app-server` default mode

## Near-term ideas

- broader docs cleanup so contract notes match the live bridge more closely
- better large-output UX beyond paged streaming cards
- more diagnostics around update checks and runtime provenance
- optional image/file support if the token and payload cost is justified

## Non-goals

- synthetic transcript storage as a second source of truth
- a separate assistant/session layer above Codex
- heavy product-shell behavior inside the bridge
