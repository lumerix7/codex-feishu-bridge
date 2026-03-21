# Binding Store Contract

## Purpose

The binding store persists the minimal metadata needed to answer:

> Given a bridge conversation key, which real Codex session and project should this message use?

## What it stores

Each binding record should stay small and explicit:

- `conversationKey`
- `codexSessionId`
- `project`
- timestamps
- small per-conversation settings such as search/model/profile overrides when needed by the live bridge

## What it must not become

- a transcript store
- a long-term memory store
- a second source of truth for conversation history
- a place to mirror full Codex session state

## Core rules

- one binding per conversation key
- session ids must be real Codex session ids
- project must remain explicit
- writes should be atomic when practical
- missing storage is a normal empty state, not corruption

## Current behavior notes

- the bridge keeps active-run state separately in memory
- deleting or changing a binding must not delete the underlying Codex session
- stale bindings are possible if the Codex session disappears; that is an orchestration problem, not necessarily store corruption

## Current code reference

- `src/store/binding-store.ts`
- `src/types/domain.ts`
