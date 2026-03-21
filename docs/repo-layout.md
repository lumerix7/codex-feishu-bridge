# Repo Layout

> High-level layout note. The repository now includes more runtime features than this short sketch originally described, but the directory split remains broadly accurate.

## Top level

- `package.json` — scripts and dependencies
- `tsconfig.json` — TypeScript build config
- `.env.example` — runtime config template
- `src/` — implementation
- `docs/` — architecture and design notes
- `deploy/` — install templates and runtime config templates
- `install.sh` — local install/update entrypoint

## `src/`

- `config/` — env parsing and app config
- `types/` — shared domain types
- `core/` — routing, session policy, application flow
- `adapters/feishu/` — Feishu transport adapter
- `adapters/codex/` — Codex runtime adapter
- `store/` — minimal binding store

## Design intent

The repo layout should keep transport, runtime, and state concerns clearly separated. The bridge should stay thin and avoid accumulating a second assistant platform inside `core/`.
