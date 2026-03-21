# Architecture

> High-level architecture note. This document still reflects the intended boundaries well, but some implementation details and filenames have moved. Use `../README.md` for the live runtime surface.

## One-line definition

`codex-feishu-bridge` is a thin relay that binds Feishu conversations to native Codex sessions and projects Codex output back into Feishu.

## Core model

### Source of truth

- **Conversation state:** Codex native session
- **Chat surface:** Feishu
- **Bridge state:** only routing/binding/runtime metadata

The bridge must not maintain a second full conversation store.

## Main flow

1. Feishu receives a message event.
2. The bridge normalizes the event into an internal input shape.
3. The router resolves the target project and Codex session binding.
4. If no binding exists, the bridge creates a new native Codex session.
5. If a binding exists, the bridge resumes that native Codex session.
6. The bridge sends the user input to Codex.
7. The bridge streams Codex output chunks back to Feishu.
8. Final output is posted back to Feishu.
9. Binding metadata is updated if needed.

## Minimal stored state

The bridge may store:

- Feishu chat/thread id -> Codex session id
- project binding for a session
- active run lock / in-flight status
- last seen message ids for deduplication
- lightweight audit timestamps

The bridge should not store:

- full synthetic conversation history
- rewritten assistant transcripts as system of record
- a separate assistant-native session model

## Proposed layers

### 1. Feishu adapter
Responsibilities:
- websocket connection
- inbound event parsing
- outbound text/card sending
- dedup handling

### 2. Router
Responsibilities:
- decide whether input is a control command or Codex-bound input
- resolve chat/thread binding
- choose project/session target

### 3. Codex runtime adapter
Responsibilities:
- create session
- resume session
- stream output
- stop/cancel active run
- expose native session ids clearly

### 4. Binding store
Responsibilities:
- persist Feishu <-> Codex session bindings
- persist active-run locks and minimal metadata

### 5. Presentation layer
Responsibilities:
- stream readable progress to Feishu
- format final outputs
- keep UX simple and predictable

## Session policy

### Principle
A Feishu thread or DM should map to one active Codex native session unless the user explicitly starts a new one.

### Commands
- `/new`: create a fresh Codex session and rebind current conversation
- `/resume`: reconnect to latest or specified Codex session
- `/stop`: cancel the active Codex run, not the whole binding
- `/status`: show project, session id, and run state

## Project policy

Initial policy should be simple:

- one configured root project
- optional named project shortcuts later
- no arbitrary escape outside configured root by default

## Non-goals

- No fake continuity via replaying full message history
- No heavy platform shell above Codex
- No duplicate memory/session systems
- No broad multi-agent orchestration in v1

## Suggested implementation target

Node/TypeScript.

Reasons:
- better fit with existing JS/TS-heavy tooling
- strong async/event ergonomics for websocket + streaming
- easier long-term integration with broader local tooling
