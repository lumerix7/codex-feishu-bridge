import assert from "node:assert/strict";
import test from "node:test";
import { __testOnly } from "../src/adapters/feishu/feishu-gateway.js";

test("splitMessageText reopens and recloses oversized fenced code blocks on every page", () => {
  const body = Array.from({ length: 40 }, (_, index) => `line ${index} ${"x".repeat(40)}`).join("\n");
  const text = `\`\`\`text\n${body}\n\`\`\``;

  const pages = __testOnly.splitMessageText(text, 240);

  assert.ok(pages.length > 1);
  for (const page of pages) {
    assert.match(page, /^`{3,}text\n/);
    assert.match(page, /\n`{3,}$/);
  }
});

test("splitMessageText does not treat backtick-looking content lines as closing fences", () => {
  const body = [
    "before",
    "```not-a-closing-fence",
    ...Array.from({ length: 30 }, (_, index) => `line ${index} ${"y".repeat(30)}`),
    "after"
  ].join("\n");
  const text = `\`\`\`text\n${body}\n\`\`\``;

  const pages = __testOnly.splitMessageText(text, 220);

  assert.ok(pages.length > 1);
  for (const page of pages) {
    assert.match(page, /^`{4,}text\n/);
    assert.match(page, /\n`{4,}$/);
  }
  assert.ok(pages.some((page) => page.includes("```not-a-closing-fence")));
});

test("splitMessageText preserves valid fenced blocks whose content includes standalone triple backticks", () => {
  const body = [
    "before",
    "```",
    ...Array.from({ length: 30 }, (_, index) => `line ${index} ${"z".repeat(30)}`),
    "after"
  ].join("\n");
  const text = `\`\`\`\`text\n${body}\n\`\`\`\``;

  const pages = __testOnly.splitMessageText(text, 220);

  assert.ok(pages.length > 1);
  for (const page of pages) {
    assert.match(page, /^`{4,}text\n/);
    assert.match(page, /\n`{4,}$/);
  }
  assert.ok(pages.some((page) => page.includes("\n```\n")));
});

test("buildRenderPlan does not count a standalone preamble card as chunk 1", () => {
  const body = Array.from({ length: 40 }, (_, index) => `line ${index} ${"x".repeat(40)}`).join("\n");
  const text = [
    "# cat",
    "",
    "- **Project**: `/tmp/demo`",
    "- **Command**: `cat README.md`",
    "",
    `\`\`\`\`text\n${body}\n\`\`\`\``
  ].join("\n");

  const plan = __testOnly.buildRenderPlan(
    {
      chatId: "chat_test",
      text,
      footer: "footer"
    },
    240
  );

  assert.ok(plan.pages.length > 1);
  assert.equal(plan.pages[0]?.footer, "footer");
  assert.equal(plan.pages[1]?.footer, `footer  |  chunk 1/${plan.pages.length - 1}`);
});

test("buildRenderPlan does not treat tables inside a fenced command output block as top-level tables", () => {
  const body = [
    "# doc",
    "",
    "| Scope | Command |",
    "|---|---|",
    "| user | `systemctl --user restart foo.service` |",
    "| system | `systemctl restart foo.service` |",
    "",
    ...Array.from({ length: 80 }, (_, index) => `line ${index} ${"q".repeat(30)}`)
  ].join("\n");
  const text = [
    "# cat",
    "",
    "- **Project**: `/tmp/demo`",
    "- **Command**: `cat README.md`",
    "",
    `\`\`\`\`text\n${body}\n\`\`\`\``
  ].join("\n");

  const plan = __testOnly.buildRenderPlan(
    {
      chatId: "chat_test",
      text,
      footer: "footer"
    },
    900
  );

  assert.ok(plan.pages.length > 1);
  assert.ok(plan.pages.some((page) => /^`{4,}text\n/.test(page.text.trimStart())));
  assert.ok(
    !plan.pages.some((page) => {
      const trimmed = page.text.trimStart();
      return trimmed.startsWith("| Scope | Command |\n|---|---|");
    })
  );
});

test("buildRenderPlan still recognizes a real top-level table after a fenced block", () => {
  const preface = [
    "```text",
    "example output",
    "```",
    "",
    "| Name | Value |",
    "|---|---|",
    ...Array.from({ length: 40 }, (_, index) => `| row-${index} | ${"v".repeat(40)} |`)
  ].join("\n");

  const plan = __testOnly.buildRenderPlan(
    {
      chatId: "chat_test",
      text: preface,
      footer: "footer"
    },
    500
  );

  assert.ok(plan.pages.length > 1);
  assert.ok(
    plan.pages.some((page) => page.text.includes("| Name | Value |\n|---|---|"))
  );
});

test("renderOutgoingBody wraps raw markdown once in the gateway", () => {
  const rendered = __testOnly.renderOutgoingBody("# Help\n\n- `code`", "raw-markdown");

  assert.match(rendered, /^```markdown\n/);
  assert.match(rendered, /\n```$/);
  assert.ok(rendered.includes("# Help"));
});

test("renderOutgoingBody wraps raw text once in the gateway", () => {
  const rendered = __testOnly.renderOutgoingBody("plain output", "raw-text");

  assert.equal(rendered, "```text\nplain output\n```");
});

test("buildRenderPlan applies raw markdown body formatting before pagination", () => {
  const plan = __testOnly.buildRenderPlan(
    {
      chatId: "chat_test",
      text: "# Help\n\n- `code`",
      bodyFormat: "raw-markdown",
      footer: "footer"
    },
    400
  );

  assert.equal(plan.pages.length, 1);
  assert.match(plan.pages[0]!.text, /^```markdown\n/);
  assert.match(plan.pages[0]!.text, /\n```$/);
});
