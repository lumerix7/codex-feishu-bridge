# Codex Adapter Contract

## Purpose

The Codex adapter hides backend-specific runtime details while preserving real Codex session semantics.

Current backends:

- `app-server`
- `spawn`
- experimental `terminal`

## Required capabilities

The adapter layer must support:

- create a real Codex session
- resume a real Codex session
- run one user turn against a session
- stop the active run
- validate whether a session exists

When supported by the backend, it may also expose:

- thread reads
- account reads
- rate-limit reads
- model listing

## Core rules

- returned session ids must be real Codex session ids
- resume must not silently create a new session
- stop targets the run, not the session
- the adapter must not invent synthetic transcript continuity
- stream and final result semantics must remain explicit

## Session vs run

- session: long-lived Codex conversation identity
- run: one active execution within that session

This distinction is important for:

- `/new`
- `/resume`
- `/stop`
- `/status`

## Backend notes

### `app-server`

- preferred backend
- richer structured notifications and server requests
- supports approvals, user-input requests, thread/account reads, rate limits, and model listing

### `spawn`

- simpler fallback backend
- uses `codex exec` / `codex exec resume`
- fewer structured capabilities, but lower coordination complexity

### `terminal`

- experimental
- not the default path

## Current code reference

- `src/adapters/codex/backend.ts`
- `src/adapters/codex/codex-runtime.ts`
- `src/adapters/codex/app-server-client.ts`
- `src/adapters/codex/runtime-meta.ts`
