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

test("severity templates normalize warning to orange and error to red", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-feishu-bridge-local-"));
  const projectDir = path.join(tempRoot, "project");
  const storePath = path.join(tempRoot, "store.json");
  await fs.mkdir(projectDir, { recursive: true });

  const app = new App(makeConfig(projectDir, storePath));

  assert.equal((app as any).templateForSeverity("wathet", "warning"), "orange");
  assert.equal((app as any).templateForSeverity("wathet", "error"), "red");
  assert.equal((app as any).templateForSeverity("wathet", undefined), "wathet");
});

test("local command execution failures are errors while usage issues remain warnings", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-feishu-bridge-local-"));
  const projectDir = path.join(tempRoot, "project");
  const storePath = path.join(tempRoot, "store.json");
  await fs.mkdir(projectDir, { recursive: true });

  const app = new App(makeConfig(projectDir, storePath));

  const runtimeFailure = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_cat_missing",
    chatType: "p2p",
    text: "/cat missing-file.txt"
  });

  assert.equal(typeof runtimeFailure, "object");
  assert.equal(runtimeFailure?.severity, "error");
  assert.equal(runtimeFailure?.bodyFormat, "raw-text");
  assert.match(runtimeFailure?.text || "", /^Code: /);
  assert.match(runtimeFailure?.text || "", /No such file or directory|cannot open/i);

  const usageFailure = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_log_invalid",
    chatType: "p2p",
    text: "/log --limit nope"
  });

  assert.equal(typeof usageFailure, "object");
  assert.equal(usageFailure?.severity, "warning");
  assert.equal(usageFailure?.bodyFormat, undefined);
});

test("wrapped commands prepend code for non-zero exits and mark them as errors", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-feishu-bridge-local-"));
  const projectDir = path.join(tempRoot, "project");
  const storePath = path.join(tempRoot, "store.json");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, "README.md"), "# hello\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: projectDir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: projectDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: projectDir });
  execFileSync("git", ["add", "README.md"], { cwd: projectDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir });

  const app = new App(makeConfig(projectDir, storePath));

  assert.equal((app as any).renderWrappedCommandOutput("(no output)", 1), "Code: 1\n\n(no output)");

  await fs.writeFile(path.join(projectDir, "README.md"), "# changed\n");
  const gitDiffResult = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_git_diff_exit",
    chatType: "p2p",
    text: "/git diff --exit-code"
  });

  assert.equal(typeof gitDiffResult, "object");
  assert.equal(gitDiffResult?.severity, "error");
  assert.equal(gitDiffResult?.bodyFormat, "raw-text");
  assert.match(gitDiffResult?.text || "", /^Code: 1\n\n/);
  assert.match(gitDiffResult?.text || "", /diff --git /);
});

test("log runtime failures are errors", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-feishu-bridge-local-"));
  const projectDir = path.join(tempRoot, "project");
  const storePath = path.join(tempRoot, "store.json");
  await fs.mkdir(projectDir, { recursive: true });

  const app = new App(makeConfig(projectDir, storePath));
  const originalPath = process.env.PATH;

  try {
    process.env.PATH = "";
    const result = await app.handleIncoming({
      chatId: "chat_test",
      messageId: "msg_log_missing_journalctl",
      chatType: "p2p",
      text: "/log -n 5"
    });

    assert.equal(typeof result, "object");
    assert.equal(result?.severity, "error");
    assert.match(result?.text || "", /journalctl|ENOENT|not found/i);
  } finally {
    process.env.PATH = originalPath;
  }
});
