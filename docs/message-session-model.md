# Message and Session Model

## Principle

A Feishu conversation maps to a native Codex session.

## Initial mapping

### P2P
- key: `p2p:<chat_id>`
- default behavior: one active Codex session per direct chat

### Group thread
- key: `group:<chat_id>:thread:<thread_id>`
- default behavior: one active Codex session per thread

### Group non-thread
- key: `chat:<chat_id>`
- acceptable only later; not preferred for v1

## Session lifecycle

- first message with no binding -> create native Codex session
- normal follow-up -> resume existing native Codex session
- `/new` -> create a fresh native Codex session and replace current binding
- `/resume` -> reconnect to a known native session
- `/stop` -> stop the active run without deleting binding

## Stored metadata only

The bridge stores only:
- conversation key
- native Codex session id
- project
- timestamps

It does not store a synthetic message transcript as the session source of truth.

## Footer identity

Feishu footers may include the native Codex session id and the native thread
name when the app-server returns one. Thread names are display metadata only;
the bridge does not use them as session identity.

`feishu.footerThreadNameMaxLength` caps footer thread names and defaults to
`50`. Longer names are shortened in the middle as `begin...end`.
