import { IncomingMessage } from "../types/domain.js";

export const BUILTIN_COMMAND_NAMES = [
  "help",
  "status",
  "thread",
  "compact",
  "rename",
  "summary",
  "diff",
  "skills",
  "config",
  "new",
  "fork",
  "resume",
  "session",
  "stop",
  "project",
  "git",
  "pwd",
  "ls",
  "cp",
  "ln",
  "mkdir",
  "mv",
  "readlink",
  "rmdir",
  "touch",
  "trash",
  "trash-list",
  "trash-restore",
  "cat",
  "head",
  "tail",
  "wc",
  "sha256sum",
  "tar",
  "tree",
  "find",
  "rg",
  "approvals",
  "feishu",
  "log",
  "search",
  "model",
  "profile",
  "plan"
] as const;

export type BuiltinCommandName =
  typeof BUILTIN_COMMAND_NAMES[number];

export type CommandName =
  | "help"
  | "status"
  | "thread"
  | "compact"
  | "rename"
  | "summary"
  | "diff"
  | "skills"
  | "config"
  | "new"
  | "fork"
  | "resume"
  | "session"
  | "stop"
  | "project"
  | "git"
  | "pwd"
  | "ls"
  | "cp"
  | "ln"
  | "mkdir"
  | "mv"
  | "readlink"
  | "rmdir"
  | "touch"
  | "trash"
  | "trash-list"
  | "trash-restore"
  | "cat"
  | "head"
  | "tail"
  | "wc"
  | "sha256sum"
  | "tar"
  | "tree"
  | "find"
  | "rg"
  | "approvals"
  | "feishu"
  | "log"
  | "search"
  | "model"
  | "profile"
  | "plan";

export interface ParsedCommand {
  name: CommandName;
  args: string[];
}

export interface ParsedCommandError {
  name?: CommandName;
  parseError: string;
}

function stripMarkdownLink(arg: string): string {
  const match = arg.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (!match) {
    return arg;
  }
  return match[1];
}

export function tokenizeCommandText(text: string): { tokens: string[]; parseError?: string } {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quote) {
      if (
        quote === '"' &&
        char === "\\" &&
        next &&
        (next === quote || next === "\\" || next === "$" || next === "`" || next === "\n")
      ) {
        if (next !== "\n") {
          current += next;
        }
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (
      char === "\\" &&
      next &&
      (/\s/.test(next) || next === "'" || next === '"' || next === "\\")
    ) {
      current += next;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    tokens.push(current);
  }
  if (quote) {
    return {
      tokens,
      parseError: `unterminated ${quote === '"' ? "double" : "single"} quote`
    };
  }
  return { tokens };
}

export function parseCommand(
  message: IncomingMessage,
  extraNames: string[] = []
): ParsedCommand | ParsedCommandError | undefined {
  const text = message.text.trim();
  if (!text.startsWith("/")) return undefined;
  const { tokens, parseError } = tokenizeCommandText(text.slice(1));
  const [head, ...args] = tokens;
  const knownNames = new Set<string>([...BUILTIN_COMMAND_NAMES, ...extraNames]);
  if (knownNames.has(head)) {
    if (parseError) {
      return { name: head as CommandName, parseError };
    }
    return { name: head as CommandName, args: args.map(stripMarkdownLink) };
  }
  return undefined;
}
