import test from "node:test";
import assert from "node:assert/strict";
import {
  appendEventBlock,
  applyAgentDelta,
  buildVisibleTimelineText,
  completeAgentText,
  createAppServerTimelineState
} from "../src/adapters/codex/app-server-timeline.js";

test("interleaves agent text and event blocks in chronological order", () => {
  const state = createAppServerTimelineState();

  applyAgentDelta(state, "agent-1", "First line.");
  appendEventBlock(state, "```text\nCommand Completed\nid: call_1\n```");
  applyAgentDelta(state, "agent-2", "Second line.");

  assert.equal(
    buildVisibleTimelineText(state),
    [
      "First line.",
      "```text\nCommand Completed\nid: call_1\n```",
      "Second line."
    ].join("\n\n")
  );
});

test("completing an agent item updates the existing timeline entry in place", () => {
  const state = createAppServerTimelineState();

  applyAgentDelta(state, "agent-1", "Part");
  appendEventBlock(state, "```text\nReasoning\nid: item_r1\n```");
  applyAgentDelta(state, "agent-1", "ial");
  completeAgentText(state, "agent-1", "Partial answer.");

  assert.equal(
    buildVisibleTimelineText(state),
    [
      "Partial answer.",
      "```text\nReasoning\nid: item_r1\n```"
    ].join("\n\n")
  );
});
