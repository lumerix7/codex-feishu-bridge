# V1 Implementation Plan

> Historical note. The original step-by-step v1 plan is no longer useful as a live implementation guide. This file keeps only the compact outcome summary.

## Original v1 goal

Ship a first working bridge that:

- receives Feishu DM messages
- binds each conversation to a real Codex session
- sends user input into Codex
- returns Codex output to Feishu
- supports a small command set
- avoids inventing a second conversation truth layer

## What actually landed

- Feishu websocket ingress plus HTTPS outbound replies
- persistent conversation-to-session bindings
- `app-server` as the preferred backend
- `spawn` as the simpler fallback backend
- streaming-first Feishu rendering with CardKit fallback
- command surface centered on `/help`, `/status`, `/thread`, `/new`, `/resume`, `/session`, `/project`, `/approvals`, `/feishu`, and `/log`

## Where to look now

- `../README.md` for the live command surface and runtime behavior
- `architecture.md` for high-level boundaries
- `core-orchestrator-contract.md` and `codex-adapter-contract.md` for interface intent
- `repo-layout.md` for the current repository structure
