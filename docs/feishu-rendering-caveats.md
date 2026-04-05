# Feishu Rendering Caveats

Feishu card markdown rendering is not fully stable across clients for long fenced output.

Observed behavior:

- The same fenced raw-text/code payload may render differently on desktop and mobile.
- Some large `git diff`-style outputs can fall back to a claybank/plain-looking style instead of the expected code-block styling.
- This can happen even when the outbound chunk is correctly fenced and chunk boundaries are correct.

Implications:

- Do not assume Feishu will render every fenced chunk exactly like standard Markdown.
- When debugging rendering issues, distinguish transport/chunk correctness from client-side rendering.
- Verify suspicious cases on the target Feishu client, especially mobile.

Current bridge guidance:

- Keep local command output simple and centrally rendered.
- Prefer normal paginated cards for completed local command output instead of live streaming.
- Treat unusual Feishu code-block styling as a client-rendering caveat unless logs show malformed outbound chunk text.
