import { IncomingMessage } from "../../types/domain.js";

export interface CodexTurnResult {
  runId: string;
  sessionId: string;
  output: string;
  status: "completed" | "cancelled";
}

export interface CodexRunHandle {
  runId: string;
  done: Promise<CodexTurnResult>;
}

export interface CodexRunHooks {
  onStatus?: (text: string) => Promise<void> | void;
  onUpdate?: (update: string) => Promise<void> | void;
  onNotification?: (notification: CodexNotification) => Promise<void> | void;
  onServerRequest?: (
    request: CodexServerRequest
  ) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
}

export interface CodexTurnOptions {
  searchEnabled?: boolean;
  model?: string;
  reasoningEffort?: string;
  profile?: string;
  planMode?: "default" | "plan";
}

export interface CodexServerRequest {
  method: string;
  params: Record<string, unknown>;
}

export interface CodexNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface CodexBackend {
  readonly mode: "spawn" | "terminal" | "app-server";
  createSession(project: string, options?: CodexTurnOptions): Promise<string>;
  runTurn(
    input: IncomingMessage,
    sessionId: string | undefined,
    project: string,
    options?: CodexTurnOptions,
    hooks?: CodexRunHooks
  ): Promise<CodexRunHandle>;
  stop(runId: string): Promise<boolean>;
  getSession(sessionId: string): Promise<boolean>;
  forkSession?(
    sessionId: string,
    project: string,
    options?: CodexTurnOptions
  ): Promise<Record<string, unknown> | undefined>;
  compactSession?(
    sessionId: string,
    project: string,
    hooks?: Pick<CodexRunHooks, "onNotification">
  ): Promise<Record<string, unknown> | undefined>;
  getConversationSummary?(
    sessionId: string,
    project: string
  ): Promise<Record<string, unknown> | undefined>;
  readThread?(
    sessionId: string,
    project: string,
    includeTurns?: boolean
  ): Promise<Record<string, unknown> | undefined>;
  readAccount?(project: string): Promise<Record<string, unknown> | undefined>;
  readAccountRateLimits?(project: string): Promise<Record<string, unknown> | undefined>;
  listModels?(
    project: string,
    options?: { includeHidden?: boolean; limit?: number; cursor?: string }
  ): Promise<Record<string, unknown> | undefined>;
  listCollaborationModes?(project: string): Promise<Record<string, unknown> | undefined>;
  listSkills?(
    project: string,
    options?: { forceReload?: boolean }
  ): Promise<Record<string, unknown> | undefined>;
  listThreads?(
    project: string,
    options?: {
      limit?: number;
      cwd?: string;
      allSources?: boolean;
      nonInteractiveOnly?: boolean;
      sourceKinds?: string[];
      archived?: boolean;
    }
  ): Promise<Record<string, unknown> | undefined>;
  readConfig?(
    project: string,
    options?: { includeLayers?: boolean }
  ): Promise<Record<string, unknown> | undefined>;
}
