import assert from "node:assert/strict";
import test from "node:test";
import { App } from "../src/core/app.js";

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
    storePath: `/tmp/codex-feishu-bridge-session-list-store-${process.pid}-${storeCounter++}.json`
  } as const;
}

test("session list pins the bound session first before other project/time ordering", () => {
  const app = new App(makeConfig());
  const sorted = (app as any).sortSessionEntries(
    [
      {
        sessionId: "session-newer",
        cwd: "/tmp/project-a",
        createdAt: "2026-04-09T10:00:00.000Z"
      },
      {
        sessionId: "session-bound",
        cwd: "/tmp/project-a",
        createdAt: "2026-04-08T10:00:00.000Z"
      },
      {
        sessionId: "session-other-project",
        cwd: "/tmp/project-b",
        createdAt: "2026-04-10T10:00:00.000Z"
      }
    ],
    "/tmp/project-a",
    "session-bound"
  );

  assert.deepEqual(
    sorted.map((item: { sessionId: string }) => item.sessionId),
    ["session-bound", "session-newer", "session-other-project"]
  );
});

test("session list renders thread name column after last message", () => {
  const app = new App(makeConfig());
  const rendered = (app as any).renderSessionList("Session List", [
    {
      sessionId: "session-1",
      cwd: "/tmp/project-a",
      createdAt: "2026-04-09T10:00:00.000Z",
      updatedAt: "2026-04-09T12:00:00.000Z",
      preview: "last message",
      threadName: "Review changes",
      threadPreview: "thread preview",
      source: "chat"
    }
  ]);

  assert.match(
    rendered,
    /\| # \| Project \| Updated \| Session \| Source \| Last user message \| Thread name \| Flags \|/
  );
  assert.match(
    rendered,
    /\| 1 \| \/tmp\/project-a \| .* \| session-1 \| chat \| last message \| Review changes \| - \|/
  );
  assert.match(rendered, /2026-04-09T20:00:00\+08:00/);
  assert.doesNotMatch(rendered, /2026-04-09T18:00:00\+08:00/);
  assert.doesNotMatch(rendered, /2026-04-09T20:00:00\.000\+08:00/);
  assert.doesNotMatch(rendered, /Thread preview/);
});

test("footer includes cached thread name after session id when available", () => {
  const app = new App(makeConfig());

  (app as any).rememberSessionFooterState("session-1", {
    model: "gpt-5.4",
    reasoning: "medium",
    threadName: "# Review `changes`"
  });

  const footer = (app as any).buildCodexFooterSummaryFromState(
    "/tmp/project-a",
    "session-1",
    "session-1"
  );

  assert.equal(
    footer,
    "gpt-5.4 medium · `/tmp/project-a` · session-1 · \\# Review \\`changes\\`"
  );
});

test("footer truncates long cached thread names in the middle", () => {
  const config = makeConfig();
  const app = new App({
    ...config,
    feishu: {
      ...config.feishu,
      footerThreadNameMaxLength: 12
    }
  });
  const longName = "h".repeat(60) + "t".repeat(10);

  (app as any).rememberSessionFooterState("session-1", {
    threadName: longName
  });

  const footer = (app as any).buildCodexFooterSummaryFromState(
    "/tmp/project-a",
    "session-1",
    "session-1"
  );

  assert.equal(
    footer,
    "`/tmp/project-a` · session-1 · hhhhh...tttt"
  );
});

test("footer truncation respects small configured thread name limits", () => {
  const config = makeConfig();
  const app = new App({
    ...config,
    feishu: {
      ...config.feishu,
      footerThreadNameMaxLength: 4
    }
  });

  (app as any).rememberSessionFooterState("session-1", {
    threadName: "abcdefghijklmnopqrstuvwxyz"
  });

  const footer = (app as any).buildCodexFooterSummaryFromState(
    "/tmp/project-a",
    "session-1",
    "session-1"
  );

  assert.equal(footer, "`/tmp/project-a` · session-1 · a...");
});

test("local ISO footer timestamp omits fractional seconds", () => {
  const app = new App(makeConfig());
  const rendered = (app as any).formatLocalIsoTimestamp(new Date(2026, 3, 11, 10, 42, 4, 809));

  assert.match(rendered, /^2026-04-11T10:42:04[+-]\d{2}:\d{2}$/);
  assert.doesNotMatch(rendered, /\.809/);
});

test("session list accepts --all without treating it as a leftover list argument", async () => {
  const app = new App(makeConfig());

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
    text: "/session list --all"
  });

  assert.equal(typeof result, "string");
  assert.doesNotMatch(String(result), /unsupported session list argument/);
});
