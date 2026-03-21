import { IncomingMessage } from "../types/domain.js";

export type CommandName =
  | "help"
  | "status"
  | "usage"
  | "thread"
  | "account"
  | "new"
  | "resume"
  | "session"
  | "stop"
  | "project"
  | "git"
  | "pwd"
  | "ls"
  | "cat"
  | "tree"
  | "find"
  | "rg"
  | "approvals"
  | "feishu"
  | "log"
  | "search"
  | "model"
  | "profile";

export interface ParsedCommand {
  name: CommandName;
  args: string[];
}

export function parseCommand(message: IncomingMessage): ParsedCommand | undefined {
  const text = message.text.trim();
  if (!text.startsWith("/")) return undefined;
  const [head, ...args] = text.slice(1).split(/\s+/);
  if (
    [
      "help",
      "status",
      "usage",
      "thread",
      "account",
      "new",
      "resume",
      "session",
      "stop",
      "project",
      "git",
      "pwd",
      "ls",
      "cat",
      "tree",
      "find",
      "rg",
      "approvals",
      "feishu",
      "log",
      "search",
      "model",
      "profile"
    ].includes(head)
  ) {
    return { name: head as CommandName, args };
  }
  return undefined;
}
