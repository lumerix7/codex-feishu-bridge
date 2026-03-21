# Feishu Adapter Contract

## Purpose

The Feishu adapter is the transport edge of the bridge.

It is responsible for:

- receiving Feishu events
- normalizing inbound messages into the bridge input shape
- sending bridge output back to Feishu
- exposing transport diagnostics needed by the bridge

## Does not own

- Codex session logic
- project/session binding policy
- long-term conversation state
- workflow semantics beyond transport presentation

## Current transport model

Inbound:

- Feishu long-connection websocket mode

Outbound:

- HTTPS OpenAPI sends
- streaming-first CardKit updates when the bridge marks a reply as streaming
- fallback to normal card sends if streaming fails

## Core rules

- deduplicate repeated inbound deliveries when possible
- return quickly from the receive path
- keep transport retries explicit and bounded
- preserve reply/thread metadata needed by the bridge
- do not reinterpret Codex session meaning

## Current responsibilities

- normalize `text` and `post` messages
- keep recent inbound dedup state
- maintain websocket readiness/reconnect diagnostics
- apply retry/backoff to outbound sends
- maintain active streaming-card state

## Current code reference

- `src/adapters/feishu/feishu-gateway.ts`

## Operational note

For current runtime behavior, prefer:

- `../README.md`
- `/feishu`
- `/feishu ws`
- `/feishu send`
- `/feishu doctor`
