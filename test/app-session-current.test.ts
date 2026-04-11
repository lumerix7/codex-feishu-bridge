import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { App } from "../src/core/app.js";
import { getRecentSessionMessages } from "../src/adapters/codex/session-files.js";

function makeConfig() {
  return {
    port: 3300,
    logLevel: "info",
    nodeEnv: "test",
    feishu: {
      appId: "test-app",
      appSecret: "test-secret",
      botOpenId: "test-bot",
      connectionMode: "websocket",
      wsAutoReconnect: true,
      wsLoggerLevel: "error",
      wsAgentKeepAliveMsecs: 1000,
      wsAgentMaxSockets: 10,
      wsAgentMaxFreeSockets: 10,
      wsConnectWarnAfterMs: 1000,
      wsReconnectWarnThreshold: 3,
      reconnectReadyDebounceMs: 1000,
      sendRetryMaxAttempts: 1,
      sendRetryBaseDelayMs: 100,
      sendRetryMultiplier: 2,
      sendRetryMaxDelayMs: 1000,
      titleMaxLength: 80
    },
    codex: {
      bin: "codex",
      home: "/tmp/codex-home",
      sessionsDir: "/tmp/codex-sessions",
      profileMode: "isolated",
      backendMode: "spawn",
      outputSoftLimit: 4000,
      modelListMaxCount: 100,
      appServerSidebandCards: false,
      appServerInlineBlocks: "full",
      sandboxMode: "default",
      sessionListMaxCount: 100,
      resumeReplayCount: 5,
      runTimeoutMs: 60000,
      approvalTimeoutMs: 60000,
      compactTimeoutMs: 60000,
      spawnStatusIntervalMs: 1000,
      statusIncludeProject: true
    },
    project: {
      allowedRoots: ["/tmp"],
      defaultProject: "/tmp/project-a",
      defaultSearchEnabled: true,
      listMaxCount: 100
    },
    commands: {
      map: {}
    },
    storePath: "/tmp/codex-feishu-bridge-store.json"
  } as const;
}

test("session groups thread details last and renders last message and thread preview as fenced text", async () => {
  const app = new App(makeConfig());
  const store = (app as any).store;
  await store.put({
    conversationKey: "p2p:chat_test",
    codexSessionId: "session-1",
    project: "/tmp/project-a",
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z"
  });

  (app as any).codex = {
    mode: "app-server",
    createSession: async () => "session-1",
    runTurn: async () => {
      throw new Error("not used");
    },
    stop: async () => false,
    getSession: async () => true,
    readThread: async () => ({
      thread: {
        id: "session-1",
        name: "# Review `changes`",
        preview: "thread preview",
        cwd: "/tmp/project-a",
        createdAt: 1_775_689_600,
        updatedAt: 1_775_689_900,
        status: "idle",
        source: { chat: "lark" }
      },
      source: { chat: "lark" }
    })
  };

  const result = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/session"
  });

  assert.equal(typeof result, "string");
  assert.match(
    String(result),
    /- \*\*Source\*\*: `chat:lark`\n.*- \*\*Last message\*\*:\n\n```text\nthread preview\n```\n- \*\*Flags\*\*: `current`, bound\n- \*\*Thread name\*\*: \\# Review \\`changes\\`\n- \*\*Thread status\*\*: `idle`\n- \*\*Thread source\*\*: `chat:lark`\n- \*\*Thread preview\*\*:\n\n```text\nthread preview\n```$/s
  );
});

test("resume reuses the session detail layout with a resume title", async () => {
  const app = new App(makeConfig());

  (app as any).codex = {
    mode: "app-server",
    createSession: async () => "session-1",
    runTurn: async () => {
      throw new Error("not used");
    },
    stop: async () => false,
    getSession: async () => true,
    readThread: async () => ({
      thread: {
        id: "session-1",
        name: "Resume thread",
        preview: "thread preview",
        cwd: "/tmp/project-a",
        createdAt: 1_775_689_600,
        updatedAt: 1_775_689_900,
        status: "idle",
        source: "chat"
      },
      source: "chat"
    })
  };

  const result = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/resume session-1"
  });

  assert.equal(typeof result, "string");
  assert.match(String(result), /^# Resume Session\n\n- \*\*Source\*\*: `explicit`\n\n- \*\*Session\*\*: `session-1`/);
  assert.match(String(result), /- \*\*Last message\*\*:\n\n```text\nthread preview\n```/);
  assert.match(String(result), /- \*\*Thread preview\*\*:\n\n```text\nthread preview\n```$/);
});

test("fork reuses the session detail layout and prefixes from", async () => {
  const app = new App(makeConfig());
  const store = (app as any).store;
  await store.put({
    conversationKey: "p2p:chat_test",
    codexSessionId: "session-1",
    project: "/tmp/project-a",
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z"
  });

  (app as any).codex = {
    mode: "app-server",
    createSession: async () => "unused",
    runTurn: async () => {
      throw new Error("not used");
    },
    stop: async () => false,
    getSession: async () => true,
    forkSession: async () => ({
      thread: {
        id: "session-2",
        name: "Forked thread",
        preview: "forked preview",
        cwd: "/tmp/project-a",
        createdAt: 1_775_689_600,
        updatedAt: 1_775_689_900,
        status: "idle",
        source: { chat: "lark" }
      },
      source: { chat: "lark" }
    })
  };

  const result = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/fork"
  });

  assert.equal(typeof result, "string");
  assert.match(String(result), /^# Fork Session\n\n- \*\*Source\*\*: `current`\n- \*\*From\*\*: `session-1`\n\n- \*\*Session\*\*: `session-2`/);
  assert.match(String(result), /- \*\*Last message\*\*:\n\n```text\nforked preview\n```/);
  assert.match(String(result), /- \*\*Thread preview\*\*:\n\n```text\nforked preview\n```$/);
});

test("resume help works regardless of -h position", async () => {
  const app = new App(makeConfig());

  for (const text of [
    "/resume -h",
    "/resume session-1 -h",
    "/resume -h session-1",
    "/resume --messages 8 -h"
  ]) {
    const result = await app.handleIncoming({
      chatId: "chat_test",
      messageId: "msg_test",
      chatType: "p2p",
      text
    });

    assert.equal(typeof result, "string");
    assert.match(String(result), /^# Resume\n\nResume a session\./);
  }
});

test("resume without a selector warns and points to explicit latest aliases", async () => {
  const app = new App(makeConfig());

  const result = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/resume"
  });

  assert.equal(typeof result, "object");
  assert.equal((result as any).severity, "warning");
  assert.match(
    String((result as any).text),
    /^# Resume\n\n- \*\*Error\*\*: pick a session explicitly, or use `-` to resume the most recent session\n- \*\*Usage\*\*: `\/resume \[<session-id>\|-\|--last\|-n <index>\|list\|-h\]`$/
  );
});

test("resume last aliases render source as last", async () => {
  const app = new App(makeConfig());
  const store = (app as any).store;
  await store.put({
    conversationKey: "p2p:chat_test",
    codexSessionId: "older-session",
    project: "/tmp/project-a",
    createdAt: "2026-04-08T00:00:00.000Z",
    updatedAt: "2026-04-08T00:00:00.000Z"
  });

  (app as any).codex = {
    mode: "spawn",
    createSession: async () => "unused",
    runTurn: async () => {
      throw new Error("not used");
    },
    stop: async () => false,
    getSession: async () => true
  };

  for (const text of ["/resume -", "/resume --last"]) {
    const result = await app.handleIncoming({
      chatId: "chat_test",
      messageId: "msg_test",
      chatType: "p2p",
      text
    });

    assert.equal(typeof result, "string");
    assert.match(String(result), /^# Resume Session\n\n- \*\*Source\*\*: `last`\n\n- \*\*Session\*\*: `older-session`/);
  }
});

test("recent replay messages render as Codex/User headings with dynamic fenced text", () => {
  const app = new App(makeConfig());

  const assistantRendered = (app as any).renderRecentSessionReplayMessage(
    {
      role: "assistant",
      text: "before ``` inside",
      timestamp: "2026-04-09T12:27:10.194Z"
    },
    0
  );
  const userRendered = (app as any).renderRecentSessionReplayMessage(
    { role: "user", text: "plain user text" },
    1
  );

  assert.deepEqual(assistantRendered, {
    text: "[Codex] 2026-04-09T20:27:10.194+08:00\n\nbefore ``` inside",
    bodyFormat: "raw-text"
  });
  assert.deepEqual(userRendered, {
    text: "[User]\n\nplain user text",
    bodyFormat: "raw-text"
  });
});

test("recent session messages keep consecutive duplicate text when timestamps differ", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-feishu-bridge-session-test-"));
  const filePath = path.join(
    root,
    "2026",
    "04",
    "09",
    "session-019d6704-c1d9-7623-a6c9-b6368155ba85.jsonl"
  );
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    [
      JSON.stringify({
        payload: {
          id: "019d6704-c1d9-7623-a6c9-b6368155ba85",
          timestamp: "2026-04-09T12:00:00.000Z",
          cwd: "/tmp/project-a"
        }
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "same text",
          timestamp: "2026-04-09T12:01:00.000Z"
        }
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "same text",
          timestamp: "2026-04-09T12:02:00.000Z"
        }
      })
    ].join("\n"),
    "utf8"
  );

  try {
    const messages = await getRecentSessionMessages(root, "019d6704-c1d9-7623-a6c9-b6368155ba85", 10);
    assert.deepEqual(messages, [
      {
        role: "assistant",
        text: "same text",
        timestamp: "2026-04-09T12:01:00.000Z"
      },
      {
        role: "assistant",
        text: "same text",
        timestamp: "2026-04-09T12:02:00.000Z"
      }
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
