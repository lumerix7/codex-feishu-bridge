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
  assert.doesNotMatch(rendered, /Thread preview/);
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
