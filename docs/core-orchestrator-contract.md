# Core Orchestrator Contract

## Purpose

The core orchestrator is the bridge layer that connects:

- Feishu transport
- Codex runtime/backend
- persistent conversation/session bindings

It decides where an inbound message should go and how outbound progress or final output should be projected back to Feishu.

## Owns

- conversation key resolution
- command routing
- project/session binding lookup and mutation
- one-active-run-per-conversation enforcement
- mapping Codex updates into Feishu replies
- user-visible error projection

## Does not own

- raw Feishu websocket or HTTPS transport details
- low-level Codex subprocess or app-server details
- synthetic conversation history as a source of truth
- long-term memory or a second assistant/session model

## Core rules

- Feishu is the control surface.
- Codex is the conversation and execution source of truth.
- The bridge stores only routing and runtime metadata.
- One conversation maps to one Codex session unless the user explicitly changes it with commands like `/new` or `/resume`.
- One conversation has at most one active run at a time.

## Main flow

1. Receive a normalized inbound message from the Feishu adapter.
2. Resolve the conversation key.
3. Parse command vs Codex turn.
4. Resolve the current binding and project.
5. Run the command or send the turn to Codex.
6. Forward progress/final output back to Feishu.
7. Update active-run state and binding metadata as needed.

## Current command responsibilities

The orchestrator is the place where bridge commands are handled, including:

- `/help`
- `/status`
- `/thread`
- `/new`
- `/resume`
- `/session`
- `/stop`
- `/project`
- `/approvals`
- `/feishu`
- `/log`
- local helper commands such as `/git`, `/pwd`, `/ls`, `/cat`, `/tree`, `/find`, `/rg`

## Failure model

The orchestrator should fail clearly and explicitly for cases like:

- invalid project path
- missing or invalid session binding
- no active run to stop
- Codex backend launch or request failure
- Feishu send failure

It must not silently change semantics to hide those failures.

## Current code reference

- `src/core/app.ts`
- `src/core/command-router.ts`
- `src/core/conversation-key.ts`
