import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { App } from "../src/core/app.js";

function makeConfig(projectDir: string, storePath: string) {
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
      allowedRoots: [path.dirname(projectDir)],
      defaultProject: projectDir,
      defaultSearchEnabled: true,
      listMaxCount: 100
    },
    commands: {
      map: {}
    },
    storePath
  } as const;
}

test("local commands use a running preamble card and raw-text final output", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-feishu-bridge-local-"));
  const projectDir = path.join(tempRoot, "project");
  const storePath = path.join(tempRoot, "store.json");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, "README.md"), "# hello\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: projectDir });

  const app = new App(makeConfig(projectDir, storePath));
  const updates: string[] = [];

  const catResult = await app.handleIncoming(
    {
      chatId: "chat_test",
      messageId: "msg_cat",
      chatType: "p2p",
      text: "/cat README.md"
    },
    async (update) => {
      updates.push(update);
    }
  );

  assert.equal(updates.length, 1);
  assert.equal(
    updates[0],
    "Running `cat`...\n\n```text\ncat README.md\n```"
  );
  assert.equal(typeof catResult, "object");
  assert.equal(catResult?.bodyFormat, "raw-text");
  assert.equal(catResult?.severity, undefined);
  assert.equal(catResult?.text, "# hello\n");

  updates.length = 0;
  const gitResult = await app.handleIncoming(
    {
      chatId: "chat_test",
      messageId: "msg_git",
      chatType: "p2p",
      text: "/git status --short"
    },
    async (update) => {
      updates.push(update);
    }
  );

  assert.equal(updates.length, 1);
  assert.equal(
    updates[0],
    "Running `git`...\n\n```text\ngit status --short\n```"
  );
  assert.equal(typeof gitResult, "object");
  assert.equal(gitResult?.bodyFormat, "raw-text");
  assert.equal(gitResult?.severity, undefined);
  assert.equal(gitResult?.text, "?? README.md\n");
});
