import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { AppConfig } from "../../config/env.js";
import { CodexServerRequest, CodexTurnOptions } from "./backend.js";

type NotificationHandler = (method: string, params: Record<string, unknown>) => void | Promise<void>;
type ServerRequestHandler = (
  request: CodexServerRequest
) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
}

class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message);
    this.name = "RpcError";
  }
}

const ALL_THREAD_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown"
] as const;

const INTERACTIVE_THREAD_SOURCE_KINDS = ["cli", "vscode"] as const;
const APP_SERVER_RETRYABLE_OVERLOAD_CODE = -32001;
const APP_SERVER_REQUEST_MAX_ATTEMPTS = 4;
const APP_SERVER_REQUEST_BASE_DELAY_MS = 250;
const APP_SERVER_REQUEST_MAX_DELAY_MS = 2_000;

export class AppServerSessionClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readyPromise?: Promise<void>;
  private startupError?: Error;
  private stderrText = "";
  private stdoutLines?: readline.Interface;
  private stderrLines?: readline.Interface;
  private serverRequestHandler?: ServerRequestHandler;

  constructor(
    private readonly config: AppConfig["codex"],
    readonly project: string
  ) {}

  async startSession(options?: CodexTurnOptions): Promise<string> {
    await this.ensureStarted();
    const result = await this.request("thread/start", this.buildThreadParams(this.project, options));
    const threadId = readThreadId(result);
    if (!threadId) {
      throw new Error("Codex app-server returned no thread id.");
    }
    return threadId;
  }

  async resumeSession(sessionId: string, options?: CodexTurnOptions): Promise<void> {
    await this.ensureStarted();
    await this.request("thread/resume", {
      ...this.buildThreadParams(this.project, options),
      threadId: sessionId
    });
  }

  async forkSession(sessionId: string, options?: CodexTurnOptions): Promise<Record<string, unknown> | undefined> {
    await this.ensureStarted();
    const result = await this.request("thread/fork", {
      ...this.buildThreadParams(this.project, options),
      threadId: sessionId
    });
    return isRecord(result) ? result : undefined;
  }

  async startTurn(sessionId: string, prompt: string, options?: CodexTurnOptions): Promise<string> {
    await this.ensureStarted();
    const collaborationMode = await this.buildCollaborationMode(options);
    const config = buildSessionConfig(options, { skipReasoningEffort: Boolean(collaborationMode) });
    const result = await this.request("turn/start", {
      threadId: sessionId,
      cwd: this.project,
      approvalPolicy: this.appServerApprovalPolicy(),
      ...(options?.model ? { model: options.model } : {}),
      ...(config ? { config } : {}),
      ...(collaborationMode ? { collaborationMode } : {}),
      input: [
        {
          type: "text",
          text: prompt
        }
      ]
    });
    return String(
      (isRecord(result) && isRecord(result.turn) ? result.turn.id : "") || ""
    ).trim();
  }

  async interruptTurn(sessionId: string, turnId: string): Promise<void> {
    await this.ensureStarted();
    await this.request("turn/interrupt", {
      threadId: sessionId,
      turnId
    });
  }

  async readThread(sessionId: string, includeTurns = false): Promise<Record<string, unknown> | undefined> {
    await this.ensureStarted();
    const result = await this.request("thread/read", {
      threadId: sessionId,
      includeTurns
    });
    return isRecord(result) ? result : undefined;
  }

  async compactSession(
    sessionId: string,
    hooks?: { onNotification?: (notification: { method: string; params: Record<string, unknown> }) => Promise<void> | void }
  ): Promise<Record<string, unknown> | undefined> {
    await this.ensureStarted();
    let cleanup = (): void => undefined;
    const completion = new Promise<Record<string, unknown>>((resolve, reject) => {
      cleanup = (): void => {
        if (timer) clearTimeout(timer);
        this.unsubscribe(handler);
      };
      const handler: NotificationHandler = async (method, params) => {
        if (this.readString(params.threadId) !== sessionId) return;
        await hooks?.onNotification?.({
          method,
          params
        });
        if (method === "thread/compacted") {
          cleanup();
          resolve({
            threadId: sessionId,
            turnId: this.readString(params.turnId),
            status: "completed"
          });
          return;
        }
        if (method === "thread/status/changed") {
          const status = asRecord(params.status);
          if (this.readString(status.type) === "systemError") {
            cleanup();
            reject(new Error(`Codex app-server compact failed for session ${sessionId}.`));
          }
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Codex app-server compact timed out for session ${sessionId}.`));
      }, this.config.compactTimeoutMs);
      timer.unref();
      this.subscribe(handler);
    });

    try {
      await this.request("thread/compact/start", { threadId: sessionId });
      const result = await completion;
      return isRecord(result) ? result : undefined;
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  async setThreadName(sessionId: string, name: string): Promise<Record<string, unknown> | undefined> {
    await this.ensureStarted();
    const result = await this.request("thread/name/set", {
      threadId: sessionId,
      name
    });
    return isRecord(result) ? result : undefined;
  }

  async getConversationSummary(sessionId: string): Promise<Record<string, unknown> | undefined> {
    await this.ensureStarted();
    const result = await this.request("getConversationSummary", {
      conversationId: sessionId
    });
    return isRecord(result) ? result : undefined;
  }

  async listSkills(options?: {
    forceReload?: boolean;
  }): Promise<Record<string, unknown> | undefined> {
    await this.ensureStarted();
    const result = await this.request("skills/list", {
      cwds: [this.project],
      ...(options?.forceReload !== undefined ? { forceReload: options.forceReload } : {})
    });
    return isRecord(result) ? result : undefined;
  }

  async listThreads(options?: {
    limit?: number;
    cwd?: string;
    allSources?: boolean;
    nonInteractiveOnly?: boolean;
    sourceKinds?: string[];
    archived?: boolean;
  }): Promise<Record<string, unknown> | undefined> {
    await this.ensureStarted();
    const sourceKinds =
      options?.sourceKinds && options.sourceKinds.length > 0
        ? options.sourceKinds
        : options?.allSources
          ? [...ALL_THREAD_SOURCE_KINDS]
          : options?.nonInteractiveOnly
            ? ALL_THREAD_SOURCE_KINDS.filter((kind) => !INTERACTIVE_THREAD_SOURCE_KINDS.includes(kind as typeof INTERACTIVE_THREAD_SOURCE_KINDS[number]))
            : undefined;
    const maxCount = Math.max(1, options?.limit || 20);
    const data: Record<string, unknown>[] = [];
    const seenIds = new Set<string>();
    let cursor: string | undefined;

    while (data.length < maxCount) {
      const page = await this.request("thread/list", {
        limit: Math.max(1, maxCount - data.length),
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.archived !== undefined ? { archived: options.archived } : {}),
        ...(sourceKinds ? { sourceKinds } : {}),
        ...(cursor ? { cursor } : {})
      });
      if (!isRecord(page)) {
        return data.length > 0 ? { data, nextCursor: null } : undefined;
      }
      const entries = Array.isArray(page.data)
        ? page.data.filter((item): item is Record<string, unknown> => isRecord(item))
        : [];
      for (const entry of entries) {
        const id = readThreadId({ thread: entry }) || String(entry.id || "").trim();
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        data.push(entry);
        if (data.length >= maxCount) break;
      }
      const nextCursor = readStringValue(page.nextCursor);
      if (!nextCursor || nextCursor === cursor || entries.length === 0) {
        return { ...page, data, nextCursor: null };
      }
      cursor = nextCursor;
    }

    return { data, nextCursor: null };
  }

  async readConfig(options?: {
    includeLayers?: boolean;
  }): Promise<Record<string, unknown> | undefined> {
    await this.ensureStarted();
    const result = await this.request("config/read", {
      includeLayers: options?.includeLayers ?? false,
      cwd: this.project
    });
    return isRecord(result) ? result : undefined;
  }

  async updateSessionOptions(
    sessionId: string,
    options: Pick<CodexTurnOptions, "model" | "reasoningEffort">
  ): Promise<Record<string, unknown> | undefined> {
    await this.ensureStarted();
    const result = await this.request("thread/resume", {
      ...this.buildThreadParams(this.project, options),
      threadId: sessionId
    });
    return isRecord(result) ? result : undefined;
  }

  async readAccountRateLimits(): Promise<Record<string, unknown> | undefined> {
    await this.ensureStarted();
    const result = await this.request("account/rateLimits/read", {});
    return isRecord(result) ? result : undefined;
  }

  async readAccount(): Promise<Record<string, unknown> | undefined> {
    await this.ensureStarted();
    const result = await this.request("account/read", { refreshToken: false });
    return isRecord(result) ? result : undefined;
  }

  async listModels(options?: {
    includeHidden?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<Record<string, unknown> | undefined> {
    await this.ensureStarted();
    const result = await this.request("model/list", {
      ...(options?.includeHidden !== undefined ? { includeHidden: options.includeHidden } : {}),
      ...(options?.limit ? { limit: options.limit } : {}),
      ...(options?.cursor ? { cursor: options.cursor } : {})
    });
    return isRecord(result) ? result : undefined;
  }

  async listCollaborationModes(): Promise<Record<string, unknown> | undefined> {
    await this.ensureStarted();
    const result = await this.request("collaborationMode/list", {});
    return isRecord(result) ? result : undefined;
  }

  subscribe(handler: NotificationHandler): void {
    this.notificationHandlers.add(handler);
  }

  unsubscribe(handler: NotificationHandler): void {
    this.notificationHandlers.delete(handler);
  }

  setServerRequestHandler(handler: ServerRequestHandler | undefined): void {
    this.serverRequestHandler = handler;
  }

  isAlive(): boolean {
    return !!this.child && !this.child.killed && this.child.exitCode === null;
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.readyPromise = undefined;

    for (const pending of this.pendingRequests.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(new Error("Codex app-server shutdown."));
    }
    this.pendingRequests.clear();

    this.stdoutLines?.close();
    this.stderrLines?.close();

    if (!child) return;
    child.stdin.end();
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
        resolve();
      }, 1_000);
      timer.unref();
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async ensureStarted(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.start();
    }
    return this.readyPromise;
  }

  private async start(): Promise<void> {
    this.stderrText = "";
    this.startupError = undefined;
    this.child = spawn(this.config.bin, ["app-server"], {
      cwd: this.project,
      env: {
        ...process.env,
        CODEX_HOME: this.config.home,
        HOME: process.env.HOME || path.dirname(this.config.home)
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.stdoutLines = readline.createInterface({ input: this.child.stdout });
    this.stderrLines = readline.createInterface({ input: this.child.stderr });

    this.stdoutLines.on("line", (line) => {
      void this.handleStdoutLine(line);
    });
    this.stderrLines.on("line", (line) => {
      this.stderrText += `${line}\n`;
    });
    this.child.once("error", (error) => {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    });
    this.child.once("close", (code) => {
      this.failAll(
        new Error(this.stderrText.trim() || `codex app-server exited with code ${code ?? "unknown"}`)
      );
    });

    await this.request("initialize", {
      clientInfo: { name: "codex-feishu-bridge", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
    this.notify("initialized", {});
  }

  private async buildCollaborationMode(
    options?: CodexTurnOptions
  ): Promise<Record<string, unknown> | undefined> {
    const mode = options?.planMode;
    if (!mode || mode === "default") return undefined;
    const preset = await this.getCollaborationModePreset(mode);
    if (!preset) {
      throw new Error(`Codex app-server collaboration mode preset \`${mode}\` is unavailable.`);
    }
    const model = readStringValue(preset.model) || options?.model;
    if (!model) {
      throw new Error(`Codex app-server collaboration mode \`${mode}\` returned no model.`);
    }
    return {
      mode,
      settings: {
        model,
        reasoning_effort: options?.reasoningEffort || readStringValue(preset.reasoning_effort) || null,
        developer_instructions: null
      }
    };
  }

  private async getCollaborationModePreset(
    mode: "default" | "plan"
  ): Promise<Record<string, unknown> | undefined> {
    const result = await this.listCollaborationModes();
    const collaborationModeMasks = Array.isArray(result?.data)
      ? result.data.filter((item): item is Record<string, unknown> => isRecord(item))
      : [];
    return collaborationModeMasks.find((item) => readStringValue(item.mode) === mode);
  }

  private async request(method: string, params: Record<string, unknown>): Promise<any> {
    for (let attempt = 1; attempt <= APP_SERVER_REQUEST_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.requestOnce(method, params);
      } catch (error) {
        if (!isRetryableAppServerError(error) || attempt >= APP_SERVER_REQUEST_MAX_ATTEMPTS) {
          throw error;
        }
        await sleep(withJitter(backoffDelay(attempt)));
      }
    }
    throw new Error(`Codex app-server request failed unexpectedly: ${method}`);
  }

  private async requestOnce(method: string, params: Record<string, unknown>): Promise<any> {
    if (!this.child?.stdin) {
      throw this.startupError || new Error("Codex app-server is not running.");
    }

    const id = this.nextRequestId++;
    const payload = JSON.stringify({ id, method, params });
    const promise = new Promise<any>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject
      };
      pending.timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, 30_000);
      pending.timeout.unref();
      this.pendingRequests.set(id, pending);
    });

    this.child.stdin.write(`${payload}\n`);
    return promise;
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.child?.stdin) return;
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private async handleStdoutLine(line: string): Promise<void> {
    const message = parseJsonLine(line);
    if (!message) return;

    if ("id" in message && !("method" in message)) {
      const id = Number(message.id);
      const pending = this.pendingRequests.get(id);
      if (!pending) return;
      this.pendingRequests.delete(id);
      if (pending.timeout) clearTimeout(pending.timeout);
      if (isRecord(message.error)) {
        pending.reject(toRpcError(message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if ("id" in message && typeof message.method === "string") {
      await this.handleServerRequest(Number(message.id), message.method, asRecord(message.params));
      return;
    }

    if (typeof message.method === "string") {
      const params = asRecord(message.params);
      for (const handler of this.notificationHandlers) {
        await handler(message.method, params);
      }
    }
  }

  private async handleServerRequest(
    id: number,
    method: string,
    params: Record<string, unknown>
  ): Promise<void> {
    if (!this.child?.stdin) return;

    const handled = await this.serverRequestHandler?.({ method, params });
    if (handled) {
      this.child.stdin.write(`${JSON.stringify({ id, result: handled })}\n`);
      return;
    }

    let result: Record<string, unknown>;
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        result = { decision: "decline" };
        break;
      case "item/permissions/requestApproval":
        result = { permissions: {} };
        break;
      case "item/tool/requestUserInput":
        result = { answers: {} };
        break;
      case "mcpServer/elicitation/request":
        result = { action: "decline" };
        break;
      case "item/tool/call":
        result = {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: `codex-feishu-bridge does not support dynamic tool calls (${String(params.tool || "unknown")})`
            }
          ]
        };
        break;
      default:
        result = {
          error: {
            code: -32601,
            message: `Unsupported Codex app-server request: ${method}`
          }
        };
        this.child.stdin.write(`${JSON.stringify({ id, ...result })}\n`);
        return;
    }

    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private buildThreadParams(project: string, options?: CodexTurnOptions): Record<string, unknown> {
    const config = buildSessionConfig(options);
    return {
      cwd: project,
      ...(options?.model ? { model: options.model } : {}),
      ...(config ? { config } : {}),
      sandbox: this.appServerSandboxMode(),
      approvalPolicy: this.appServerApprovalPolicy()
    };
  }

  private appServerSandboxMode(): "workspace-write" | "danger-full-access" {
    return this.config.sandboxMode === "danger-full-access"
      ? "danger-full-access"
      : "workspace-write";
  }

  private appServerApprovalPolicy(): "on-request" | "never" {
    return this.config.sandboxMode === "danger-full-access" ? "never" : "on-request";
  }

  private readString(value: unknown): string | undefined {
    const trimmed = String(value || "").trim();
    return trimmed || undefined;
  }

  private failAll(error: Error): void {
    this.startupError = error;
    for (const pending of this.pendingRequests.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.readyPromise = undefined;
  }
}

function parseJsonLine(line: string): Record<string, any> | undefined {
  try {
    return JSON.parse(line) as Record<string, any>;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object";
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readThreadId(result: unknown): string {
  if (!isRecord(result)) return "";
  const thread = isRecord(result.thread) ? result.thread : {};
  return String(thread.id || "").trim();
}

function readStringValue(value: unknown): string | undefined {
  const trimmed = String(value || "").trim();
  return trimmed || undefined;
}

function toRpcError(error: Record<string, unknown>): RpcError {
  const message = String(error.message || "Codex app-server request failed");
  const code = typeof error.code === "number" ? error.code : undefined;
  return new RpcError(code !== undefined ? `${message} (code ${code})` : message, code);
}

function isRetryableAppServerError(error: unknown): boolean {
  return error instanceof RpcError && error.code === APP_SERVER_RETRYABLE_OVERLOAD_CODE;
}

function backoffDelay(attempt: number): number {
  return Math.min(APP_SERVER_REQUEST_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1)), APP_SERVER_REQUEST_MAX_DELAY_MS);
}

function withJitter(delayMs: number): number {
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(delayMs / 2)));
  return delayMs + jitter;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref();
  });
}

function buildSessionConfig(
  options?: CodexTurnOptions,
  behavior?: { skipReasoningEffort?: boolean }
): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {};
  if (options?.searchEnabled !== undefined) {
    config.web_search = options.searchEnabled ? "live" : "disabled";
  }
  if (options?.reasoningEffort !== undefined && !behavior?.skipReasoningEffort) {
    config.model_reasoning_effort = options.reasoningEffort;
  }
  return Object.keys(config).length > 0 ? config : undefined;
}
