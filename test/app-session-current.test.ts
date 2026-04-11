import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { App } from "../src/core/app.js";
import { getRecentSessionMessages } from "../src/adapters/codex/session-files.js";

let storeCounter = 0;

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
      titleMaxLength: 80,
      footerThreadNameMaxLength: 50
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
      map: {},
      alias: {},
      direct: []
    },
    storePath: `/tmp/codex-feishu-bridge-session-current-store-${process.pid}-${storeCounter++}.json`
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
    /- \*\*Source\*\*: `chat:lark`\n.*- \*\*Last user message\*\*:\n\n```text\n\(no preview\)\n```\n- \*\*Last message\*\*:\n\n```text\nthread preview\n```\n- \*\*Flags\*\*: `current`, bound\n- \*\*Thread name\*\*: \\# Review \\`changes\\`\n- \*\*Thread status\*\*: `idle`\n- \*\*Thread source\*\*: `chat:lark`\n- \*\*Thread preview\*\*:\n\n```text\nthread preview\n```$/s
  );
});

test("session detail keeps hyphens readable while escaping markdown punctuation", async () => {
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
        name: "review-since-0407 #tag",
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
  assert.match(String(result), /- \*\*Thread name\*\*: review-since-0407 \\#tag/);
  assert.doesNotMatch(String(result), /review\\-since\\-0407/);
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
  assert.match(String(result), /- \*\*Last user message\*\*:\n\n```text\n\(no preview\)\n```/);
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
  assert.match(String(result), /- \*\*Last user message\*\*:\n\n```text\n\(no preview\)\n```/);
  assert.match(String(result), /- \*\*Last message\*\*:\n\n```text\nforked preview\n```/);
  assert.match(String(result), /- \*\*Thread preview\*\*:\n\n```text\nforked preview\n```$/);
});

test("fork explicit session resolves model options from the target session", async () => {
  const app = new App(makeConfig());
  const store = (app as any).store;
  await store.put({
    conversationKey: "p2p:chat_test",
    codexSessionId: "bound-session",
    project: "/tmp/project-a",
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z"
  });

  (app as any).rememberSessionModelOverride("bound-session", {
    model: "bound-model",
    reasoning: "xhigh"
  });

  let seenSourceSession = "";
  let seenOptions: Record<string, unknown> | undefined;
  (app as any).codex = {
    mode: "app-server",
    createSession: async () => "unused",
    runTurn: async () => {
      throw new Error("not used");
    },
    stop: async () => false,
    getSession: async () => true,
    readThread: async (sessionId: string) => ({
      thread: {
        id: sessionId,
        name: `Thread ${sessionId}`,
        model: sessionId === "target-session" ? "target-thread-model" : "bound-thread-model",
        reasoningEffort: "low"
      }
    }),
    readConfig: async () => ({
      config: {
        model: "target-config-model",
        model_reasoning_effort: "medium"
      }
    }),
    forkSession: async (sessionId: string, _project: string, options: Record<string, unknown>) => {
      seenSourceSession = sessionId;
      seenOptions = options;
      return {
        thread: {
          id: "forked-session",
          name: "Forked thread",
          preview: "forked preview",
          cwd: "/tmp/project-a",
          createdAt: 1_775_689_600,
          updatedAt: 1_775_689_900,
          status: "idle",
          source: { chat: "lark" }
        }
      };
    }
  };

  const result = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/fork target-session"
  });

  assert.equal(typeof result, "string");
  assert.equal(seenSourceSession, "target-session");
  assert.equal(seenOptions?.model, "target-config-model");
  assert.equal(seenOptions?.reasoningEffort, "medium");
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

test("session help works regardless of -h position", async () => {
  const app = new App(makeConfig());

  for (const text of [
    "/session -h",
    "/session session-1 -h",
    "/session -h session-1",
    "/session list --source exec -h"
  ]) {
    const result = await app.handleIncoming({
      chatId: "chat_test",
      messageId: "msg_test",
      chatType: "p2p",
      text
    });

    assert.equal(typeof result, "string");
    assert.match(String(result), /^# Session\n\nInspect the current bound session, inspect one specific native Codex session, or browse recent sessions\./);
  }
});

test("rename help works regardless of -h position", async () => {
  const app = new App(makeConfig());

  for (const text of [
    "/rename -h",
    "/rename 'Review changes' -h",
    "/rename --session session-1 -h",
    "/rename -h --session session-1",
    "/rename 'Review changes' --session session-1 -h"
  ]) {
    const result = await app.handleIncoming({
      chatId: "chat_test",
      messageId: "msg_test",
      chatType: "p2p",
      text
    });

    assert.equal(typeof result, "string");
    assert.match(String(result), /^# Rename\n\nShow or change a native Codex thread name\./);
  }
});

test("session with an explicit session id renders that session without bound flags", async () => {
  const app = new App(makeConfig());
  const store = (app as any).store;
  await fs.mkdir("/tmp/project-b", { recursive: true });
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
    getSession: async (sessionId: string) => sessionId === "session-2",
    readThread: async (sessionId: string) => ({
      thread: {
        id: sessionId,
        name: `Thread ${sessionId}`,
        preview: `preview ${sessionId}`,
        cwd: "/tmp/project-b",
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
    text: "/session session-2"
  });

  assert.equal(typeof result, "string");
  assert.match(String(result), /^# Session\n\n- \*\*Session\*\*: `session-2`\n- \*\*Project\*\*: `\/tmp\/project-b`/);
  assert.match(String(result), /- \*\*Flags\*\*: -\n- \*\*Thread name\*\*: Thread session-2/);
});

test("session detail prefers the actual latest session message over thread preview", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-feishu-bridge-session-detail-"));
  const projectDir = path.join(root, "project-a");
  await fs.mkdir(projectDir, { recursive: true });
  const filePath = path.join(root, "2026", "04", "09", "session-1.jsonl");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    [
      JSON.stringify({
        payload: {
          id: "session-1",
          timestamp: "2026-04-09T12:00:00.000Z",
          cwd: projectDir
        }
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "First question"
        }
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Actual latest assistant message"
        }
      })
    ].join("\n")
  );

  const config = {
    ...makeConfig(),
    codex: {
      ...makeConfig().codex,
      sessionsDir: root
    },
    project: {
      ...makeConfig().project,
      allowedRoots: [root],
      defaultProject: projectDir
    },
    storePath: path.join(root, "store.json")
  } as const;
  const app = new App(config);
  const store = (app as any).store;
  await store.put({
    conversationKey: "p2p:chat_test",
    codexSessionId: "session-1",
    project: projectDir,
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
    readThread: async () => ({
      thread: {
        id: "session-1",
        name: "Thread session-1",
        preview: "thread preview only",
        cwd: projectDir,
        createdAt: 1_775_689_600,
        updatedAt: 1_775_689_900,
        status: "idle",
        source: { chat: "lark" }
      },
      source: { chat: "lark" }
    })
  };

  for (const text of ["/session", "/session session-1"]) {
    const result = await app.handleIncoming({
      chatId: "chat_test",
      messageId: "msg_test",
      chatType: "p2p",
      text
    });

    assert.equal(typeof result, "string");
    assert.match(String(result), /- \*\*Last user message\*\*:\n\n```text\nFirst question\n```/);
    assert.match(String(result), /- \*\*Last message\*\*:\n\n```text\nActual latest assistant message\n```/);
    assert.match(String(result), /- \*\*Thread preview\*\*:\n\n```text\nthread preview only\n```$/);
  }
});

test("resume without a selector warns and points to explicit last aliases", async () => {
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
    /^# Resume\n\n- \*\*Warning\*\*: pick a session explicitly, or use `-` to resume the saved last session\n- \*\*Usage\*\*: `\/resume \[<session-id>\|-\|--last\|-n <index>\|list\|-h\]`$/
  );
});

test("resume last aliases render source as last", async () => {
  for (const text of ["/resume -", "/resume --last"]) {
    const app = new App(makeConfig());
    const store = (app as any).store;
    await store.put({
      conversationKey: "p2p:chat_test",
      codexSessionId: "current-session",
      lastCodexSessionId: "older-session",
      lastProject: "/tmp/project-a",
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

    const result = await app.handleIncoming({
      chatId: "chat_test",
      messageId: "msg_test",
      chatType: "p2p",
      text
    });

    assert.equal(typeof result, "string");
    assert.match(String(result), /^# Resume Session\n\n- \*\*Source\*\*: `last`\n\n- \*\*Session\*\*: `older-session`/);
    const binding = await store.get("p2p:chat_test");
    assert.equal(binding?.codexSessionId, "older-session");
    assert.equal(binding?.lastCodexSessionId, "current-session");
  }
});

test("resume last without a saved previous session warns", async () => {
  const app = new App(makeConfig());
  const store = (app as any).store;
  await store.put({
    conversationKey: "p2p:chat_test",
    codexSessionId: "current-session",
    project: "/tmp/project-a",
    createdAt: "2026-04-08T00:00:00.000Z",
    updatedAt: "2026-04-08T00:00:00.000Z"
  });

  const result = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/resume -"
  });

  assert.equal(typeof result, "object");
  assert.equal((result as any).severity, "warning");
  assert.match(
    String((result as any).text),
    /no last session is saved for this conversation/
  );
});

test("resume explicit session saves previous current session for resume last", async () => {
  const app = new App(makeConfig());
  const store = (app as any).store;
  await store.put({
    conversationKey: "p2p:chat_test",
    codexSessionId: "session-a",
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

  const explicitResult = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/resume session-b"
  });

  assert.equal(typeof explicitResult, "string");
  assert.match(String(explicitResult), /^# Resume Session\n\n- \*\*Source\*\*: `explicit`\n\n- \*\*Session\*\*: `session-b`/);
  let binding = await store.get("p2p:chat_test");
  assert.equal(binding?.codexSessionId, "session-b");
  assert.equal(binding?.lastCodexSessionId, "session-a");

  const lastResult = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/resume -"
  });

  assert.equal(typeof lastResult, "string");
  assert.match(String(lastResult), /^# Resume Session\n\n- \*\*Source\*\*: `last`\n\n- \*\*Session\*\*: `session-a`/);
  binding = await store.get("p2p:chat_test");
  assert.equal(binding?.codexSessionId, "session-a");
  assert.equal(binding?.lastCodexSessionId, "session-b");
});

test("resume last failure keeps saved last session unchanged", async () => {
  const app = new App(makeConfig());
  const store = (app as any).store;
  await store.put({
    conversationKey: "p2p:chat_test",
    codexSessionId: "session-a",
    lastCodexSessionId: "missing-session",
    lastProject: "/tmp/project-a",
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
    getSession: async () => false
  };

  const result = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/resume -"
  });

  assert.equal(typeof result, "object");
  assert.equal((result as any).severity, "error");
  assert.match(String((result as any).text), /Session not found: missing-session/);
  const binding = await store.get("p2p:chat_test");
  assert.equal(binding?.codexSessionId, "session-a");
  assert.equal(binding?.lastCodexSessionId, "missing-session");
});

test("resume explicit missing session renders as error with list hint", async () => {
  const app = new App(makeConfig());
  (app as any).codex = {
    mode: "spawn",
    createSession: async () => "unused",
    runTurn: async () => {
      throw new Error("not used");
    },
    stop: async () => false,
    getSession: async () => false
  };

  const result = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/resume missing-session"
  });

  assert.equal(typeof result, "object");
  assert.equal((result as any).severity, "error");
  assert.match(
    String((result as any).text),
    /^# Resume\n\n- \*\*Error\*\*: Session not found: missing-session\n- \*\*Note\*\*: Use `\/resume list` or `\/session list` to find resumable sessions\.$/
  );
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
    text: "[Codex] 2026-04-09T20:27:10+08:00\n\nbefore ``` inside",
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
