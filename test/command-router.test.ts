import assert from "node:assert/strict";
import test from "node:test";
import { parseCommand } from "../src/core/command-router.js";
import { IncomingMessage } from "../src/types/domain.js";

function makeMessage(text: string): IncomingMessage {
  return {
    chatId: "chat_test",
    messageId: "msg_test",
    text
  };
}

test("parseCommand trims outer whitespace before parsing slash commands", () => {
  const parsed = parseCommand(makeMessage("   /git status   "));
  assert.deepEqual(parsed, {
    name: "git",
    args: ["status"]
  });
});

test("parseCommand preserves single-quoted argument groups", () => {
  const parsed = parseCommand(makeMessage("/git commit -m 'add 2026-04-02 day log'"));
  assert.deepEqual(parsed, {
    name: "git",
    args: ["commit", "-m", "add 2026-04-02 day log"]
  });
});

test("parseCommand preserves double-quoted argument groups", () => {
  const parsed = parseCommand(makeMessage('/resume -C "/path with spaces/project"'));
  assert.deepEqual(parsed, {
    name: "resume",
    args: ["-C", "/path with spaces/project"]
  });
});

test("parseCommand preserves escaped spaces outside quotes", () => {
  const parsed = parseCommand(makeMessage("/project bind /path/with\\ spaces/project"));
  assert.deepEqual(parsed, {
    name: "project",
    args: ["bind", "/path/with spaces/project"]
  });
});

test("parseCommand preserves literal backslashes for non-special characters", () => {
  const parsed = parseCommand(makeMessage(String.raw`/rg \d+ foo\bar`));
  assert.deepEqual(parsed, {
    name: "rg",
    args: [String.raw`\d+`, String.raw`foo\bar`]
  });
});

test("parseCommand treats backslashes as literal inside single quotes", () => {
  const parsed = parseCommand(makeMessage(String.raw`/git commit -m 'foo\bar'`));
  assert.deepEqual(parsed, {
    name: "git",
    args: ["commit", "-m", String.raw`foo\bar`]
  });
});

test("parseCommand supports shell-style dollar escaping inside double quotes", () => {
  const parsed = parseCommand(makeMessage(String.raw`/git commit -m "cost \$5"`));
  assert.deepEqual(parsed, {
    name: "git",
    args: ["commit", "-m", "cost $5"]
  });
});

test("parseCommand reports unterminated quotes as a parse error", () => {
  const parsed = parseCommand(makeMessage(`/git commit -m "oops`));
  assert.deepEqual(parsed, {
    name: "git",
    parseError: "unterminated double quote"
  });
});

test("parseCommand strips Feishu markdown links in arguments back to plain text", () => {
  const parsed = parseCommand(makeMessage("/head -n 3 [README.md](http://readme.md/)"));
  assert.deepEqual(parsed, {
    name: "head",
    args: ["-n", "3", "README.md"]
  });
});

test("parseCommand recognizes configured extra slash command names", () => {
  const parsed = parseCommand(makeMessage("/todo today"), ["todo"]);
  assert.deepEqual(parsed, {
    name: "todo",
    args: ["today"]
  });
});

test("parseCommand recognizes rename slash commands", () => {
  const parsed = parseCommand(makeMessage('/rename "Bridge session title"'));
  assert.deepEqual(parsed, {
    name: "rename",
    args: ["Bridge session title"]
  });
});

test("parseCommand preserves rename end-of-options marker", () => {
  const parsed = parseCommand(makeMessage('/rename -- "-h"'));
  assert.deepEqual(parsed, {
    name: "rename",
    args: ["--", "-h"]
  });
});
