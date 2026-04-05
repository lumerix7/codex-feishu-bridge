import assert from "node:assert/strict";
import test from "node:test";
import { App } from "../src/core/app.js";

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

test("rename accepts one parsed positional argument without -- and escapes markdown in output", async () => {
  const app = new App(makeConfig());
  const store = (app as any).store;
  await store.put({
    conversationKey: "p2p:chat_test",
    codexSessionId: "session-1",
    project: "/tmp/project-a",
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z"
  });

  let seenName = "";
  const renamed = "# Review `changes`";
  (app as any).codex = {
    mode: "app-server",
    createSession: async () => "session-1",
    runTurn: async () => {
      throw new Error("not used");
    },
    stop: async () => false,
    getSession: async () => true,
    setSessionName: async (_sessionId: string, _project: string, name: string) => {
      seenName = name;
      return { thread: { id: "session-1", name } };
    }
  };

  const result = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: `/rename '${renamed}'`
  });

  assert.equal(seenName, renamed);
  assert.equal(typeof result, "string");
  assert.match(String(result), /- \*\*Name\*\*: \\# Review \\`changes\\`/);
});
