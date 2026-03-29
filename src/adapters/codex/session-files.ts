import fs from "node:fs/promises";
import path from "node:path";

export async function findSessionFile(
  sessionsDir: string,
  sessionId: string
): Promise<string | undefined> {
  const yearDirs = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  for (const yearDir of yearDirs) {
    if (!yearDir.isDirectory()) continue;
    const yearPath = path.join(sessionsDir, yearDir.name);
    const monthDirs = await fs.readdir(yearPath, { withFileTypes: true }).catch(() => []);
    for (const monthDir of monthDirs) {
      if (!monthDir.isDirectory()) continue;
      const monthPath = path.join(yearPath, monthDir.name);
      const dayDirs = await fs.readdir(monthPath, { withFileTypes: true }).catch(() => []);
      for (const dayDir of dayDirs) {
        if (!dayDir.isDirectory()) continue;
        const dayPath = path.join(monthPath, dayDir.name);
        const files = await fs.readdir(dayPath, { withFileTypes: true }).catch(() => []);
        const match = files.find((file) => file.isFile() && file.name.includes(sessionId));
        if (match) {
          return path.join(dayPath, match.name);
        }
      }
    }
  }
  return undefined;
}

export interface SessionSummary {
  sessionId: string;
  filePath: string;
  createdAt?: string;
  cwd?: string;
  preview?: string;
}

export interface SessionMessage {
  role: "user" | "assistant";
  text: string;
}

export interface SessionListOptions {
  cwd?: string;
  includeUnknownCwd?: boolean;
}

export async function listRecentSessions(
  sessionsDir: string,
  limit: number,
  options?: SessionListOptions
): Promise<SessionSummary[]> {
  const filePaths = await collectSessionFiles(sessionsDir);
  const summaries = await Promise.all(
    filePaths.map(async (filePath) => {
      const summary = await readSessionSummary(filePath);
      return summary;
    })
  );

  return summaries
    .filter((item): item is SessionSummary => Boolean(item))
    .filter((item) => {
      if (!options?.cwd) return true;
      if (item.cwd === options.cwd) return true;
      return options.includeUnknownCwd === true && !item.cwd;
    })
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
    .slice(0, Math.max(1, limit));
}

export async function getSessionSummary(
  sessionsDir: string,
  sessionId: string
): Promise<SessionSummary | undefined> {
  const filePath = await findSessionFile(sessionsDir, sessionId);
  if (!filePath) return undefined;
  return readSessionSummary(filePath);
}

export async function getRecentSessionMessages(
  sessionsDir: string,
  sessionId: string,
  limit: number
): Promise<SessionMessage[]> {
  if (limit <= 0) return [];
  const filePath = await findSessionFile(sessionsDir, sessionId);
  if (!filePath) return [];
  const raw = await fs.readFile(filePath, "utf8").catch(() => undefined);
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const messages: SessionMessage[] = [];
  for (const line of lines) {
    const message = parseSessionMessage(line);
    if (!message) continue;
    const previous = messages[messages.length - 1];
    if (previous && previous.role === message.role && previous.text === message.text) {
      continue;
    }
    messages.push(message);
  }
  return messages.slice(-limit);
}

async function collectSessionFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectSessionFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      results.push(fullPath);
    }
  }
  return results;
}

async function readSessionSummary(filePath: string): Promise<SessionSummary | undefined> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => undefined);
  if (!raw) return undefined;
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const firstLine = lines[0];
  if (!firstLine) return undefined;

  try {
    const parsed = JSON.parse(firstLine) as {
      payload?: { id?: string; timestamp?: string; cwd?: string };
    };
    const sessionId = parsed.payload?.id || sessionIdFromFilePath(filePath);
    if (!sessionId) return undefined;
    return {
      sessionId,
      filePath,
      createdAt: parsed.payload?.timestamp,
      cwd: parsed.payload?.cwd,
      preview: extractSessionPreview(lines)
    };
  } catch {
    const sessionId = sessionIdFromFilePath(filePath);
    if (!sessionId) return undefined;
    return { sessionId, filePath };
  }
}

function sessionIdFromFilePath(filePath: string): string | undefined {
  const match = path.basename(filePath).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  );
  return match?.[1];
}

function extractSessionPreview(lines: string[]): string | undefined {
  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    try {
      const parsed = JSON.parse(lines[idx]) as {
        type?: string;
        payload?: {
          type?: string;
          message?: string;
          role?: string;
          content?: Array<{ type?: string; text?: string }>;
        };
      };
      if (parsed.type === "event_msg" && parsed.payload?.type === "user_message") {
        return compactPreview(parsed.payload.message);
      }
      if (parsed.type === "response_item" && parsed.payload?.type === "message" && parsed.payload.role === "user") {
        const text = parsed.payload.content?.find((item) => item.type === "input_text")?.text;
        const preview = compactPreview(text);
        if (preview) return preview;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function parseSessionMessage(line: string): SessionMessage | undefined {
  try {
    const parsed = JSON.parse(line) as {
      type?: string;
      payload?: {
        type?: string;
        message?: string;
        role?: string;
        content?: Array<{ type?: string; text?: string }>;
      };
    };
    if (parsed.type === "event_msg" && parsed.payload?.type === "user_message") {
      const text = normalizeMessageText(parsed.payload.message);
      return text ? { role: "user", text } : undefined;
    }
    if (parsed.type === "event_msg" && parsed.payload?.type === "agent_message") {
      const text = normalizeMessageText(parsed.payload.message);
      return text ? { role: "assistant", text } : undefined;
    }
    if (parsed.type === "response_item" && parsed.payload?.type === "message") {
      const role =
        parsed.payload.role === "user"
          ? "user"
          : parsed.payload.role === "assistant"
            ? "assistant"
            : undefined;
      if (!role) return undefined;
      const text = normalizeMessageText(
        parsed.payload.content?.find((item) => item.type === "input_text" || item.type === "output_text")?.text
      );
      return text ? { role, text } : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function compactPreview(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  if (compact.length <= 72) return compact;
  return `${compact.slice(0, 69).trimEnd()}...`;
}

function normalizeMessageText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const normalized = text.replace(/\r\n/g, "\n").trim();
  return normalized || undefined;
}
