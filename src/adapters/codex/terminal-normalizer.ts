import stripAnsi from "strip-ansi";

export type TerminalEvent =
  | { type: "prompt.ready" }
  | { type: "assistant.output"; text: string }
  | { type: "status"; text: string }
  | { type: "input.echo"; text: string }
  | { type: "raw"; text: string };

export interface TerminalSnapshot {
  cleaned: string;
  events: TerminalEvent[];
  hasPrompt: boolean;
}

export function normalizeTerminalDelta(raw: string, prompt: string): TerminalSnapshot {
  const simplified = simplifyTerminalText(raw);
  const lines = simplified.split("\n").map((line) => line.trimEnd());
  const events: TerminalEvent[] = [];
  const assistantLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (isPromptLine(trimmed, prompt)) {
      events.push({ type: "input.echo", text: trimmed });
      continue;
    }

    if (isStatusLine(trimmed)) {
      events.push({ type: "status", text: trimmed });
      continue;
    }

    if (isChromeLine(trimmed)) {
      continue;
    }

    assistantLines.push(trimmed);
    events.push({ type: "assistant.output", text: trimmed });
  }

  const cleaned = collapseLines(assistantLines);
  const promptReady = hasPrompt(simplified);
  if (promptReady) {
    events.push({ type: "prompt.ready" });
  }

  if (!cleaned && simplified.trim()) {
    events.push({ type: "raw", text: simplified.trim() });
  }

  return {
    cleaned,
    events,
    hasPrompt: promptReady
  };
}

export function renderTerminalForFeishu(
  snapshot: TerminalSnapshot,
  mode: "markdown" | "plain"
): string {
  const body = snapshot.cleaned || fallbackBody(snapshot.events);
  if (mode === "plain") {
    return body || "(no clean terminal output)";
  }
  return ["**Codex terminal**", "```text", body || "(no clean terminal output)", "```"].join("\n");
}

export function hasPrompt(text: string): boolean {
  const tail = text.split("\n").slice(-8).join("\n");
  return /(?:^|\n)›(?:\s|$)/.test(tail);
}

function simplifyTerminalText(raw: string): string {
  return stripAnsi(raw)
    .replace(/\r/g, "\n")
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

function collapseLines(lines: string[]): string {
  const collapsed: string[] = [];
  for (const line of lines) {
    if (!line && collapsed[collapsed.length - 1] === "") continue;
    if (line === collapsed[collapsed.length - 1]) continue;
    collapsed.push(line);
  }
  while (collapsed[0] === "") collapsed.shift();
  while (collapsed[collapsed.length - 1] === "") collapsed.pop();
  return collapsed.join("\n").trim();
}

function isPromptLine(line: string, prompt: string): boolean {
  return line === prompt || line === `› ${prompt}` || line === "›";
}

function isStatusLine(line: string): boolean {
  return line.startsWith("Tip:");
}

function isChromeLine(line: string): boolean {
  if (line.startsWith("OpenAI Codex")) return true;
  if (line.startsWith(">_ OpenAI Codex")) return true;
  if (line.startsWith("model:")) return true;
  if (line.startsWith("directory:")) return true;
  if (/^[╭╰│─]+$/.test(line)) return true;
  return false;
}

function fallbackBody(events: TerminalEvent[]): string {
  const interesting = events
    .filter((event) => event.type === "assistant.output" || event.type === "status")
    .map((event) => event.text);
  return collapseLines(interesting);
}
