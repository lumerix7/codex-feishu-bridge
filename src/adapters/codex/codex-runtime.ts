import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import pty from "node-pty";
import xterm from "@xterm/headless";
import stripAnsi from "strip-ansi";
import { AppConfig } from "../../config/env.js";
import { IncomingMessage } from "../../types/domain.js";
import {
  CodexBackend,
  CodexRunHandle,
  CodexRunHooks,
  CodexTurnOptions,
  CodexTurnResult
} from "./backend.js";
import { AppServerSessionClient } from "./app-server-client.js";
import { findSessionFile } from "./session-files.js";
import {
  hasPrompt,
  normalizeTerminalDelta,
  renderTerminalForFeishu
} from "./terminal-normalizer.js";

interface ActiveProcess {
  child: ReturnType<typeof spawn>;
  cancelled: boolean;
  timeout?: NodeJS.Timeout;
  heartbeat?: NodeJS.Timeout;
}

const CREATE_SESSION_PROMPT =
  "Initialize a new bridge session. Reply with exactly: READY";
const STREAMED_OUTPUT_DEDUPE_WINDOW = 4;
const APP_SERVER_CLIENT_IDLE_SHUTDOWN_MS = 60_000;
const APP_SERVER_STREAM_UPDATE_INTERVAL_MS = 120;

function formatStatusWithProject(
  config: AppConfig["codex"],
  project: string,
  text: string
): string {
  if (!config.statusIncludeProject) {
    return text;
  }
  return `${text} (project: ${project})`;
}

export function createCodexBackend(config: AppConfig["codex"]): CodexBackend {
  const spawnBackend = new SpawnCodexBackend(config);
  if (config.backendMode === "app-server") {
    return new AppServerCodexBackend(config, spawnBackend);
  }
  if (config.backendMode === "terminal") {
    return new TerminalCodexBackend(config, spawnBackend);
  }
  return spawnBackend;
}

interface ActiveAppServerRun {
  client: AppServerSessionClient;
  sessionId: string;
  turnId?: string;
  cancelled: boolean;
  timeout?: NodeJS.Timeout;
  heartbeat?: NodeJS.Timeout;
}

class AppServerCodexBackend implements CodexBackend {
  readonly mode = "app-server" as const;
  private readonly clients = new Map<string, AppServerSessionClient>();
  private readonly activeRuns = new Map<string, ActiveAppServerRun>();
  private readonly idleShutdowns = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly config: AppConfig["codex"],
    private readonly bootstrapBackend: SpawnCodexBackend
  ) {}

  async createSession(project: string, options?: CodexTurnOptions): Promise<string> {
    return this.bootstrapBackend.createSession(project, this.bootstrapOptions(options));
  }

  async runTurn(
    input: IncomingMessage,
    sessionId: string | undefined,
    project: string,
    options?: CodexTurnOptions,
    hooks?: CodexRunHooks
  ): Promise<CodexRunHandle> {
    await ensureProject(project);
    const runId = randomUUID();
    const clientInfo = await this.getOrCreateClient(project, sessionId, options);
    if (this.hasActiveRunForClient(clientInfo.client)) {
      throw new Error(`Codex session ${clientInfo.sessionId} already has an active run.`);
    }
    const resolvedSessionId = clientInfo.sessionId;
    let lastActivityAt = Date.now();

    const sendStatus = (text: string): void => {
      lastActivityAt = Date.now();
      void hooks?.onStatus?.(text);
    };

    const sendUpdate = (text: string): void => {
      lastActivityAt = Date.now();
      void hooks?.onUpdate?.(text);
    };

    sendStatus(
      formatStatusWithProject(
        this.config,
        project,
        sessionId ? `resuming Codex session ${resolvedSessionId}...` : "starting a new Codex session..."
      )
    );

    const active: ActiveAppServerRun = {
      client: clientInfo.client,
      sessionId: resolvedSessionId,
      cancelled: false
    };
    if (this.config.runTimeoutMs > 0) {
      active.timeout = setTimeout(() => {
        void this.stop(runId);
      }, this.config.runTimeoutMs);
      active.timeout.unref();
    }
    if (this.config.spawnStatusIntervalMs > 0) {
      active.heartbeat = setInterval(() => {
        if (Date.now() - lastActivityAt >= this.config.spawnStatusIntervalMs) {
          sendStatus(
            `${formatStatusWithProject(this.config, project, "Codex is still working...")}\nrun=${runId}`
          );
        }
      }, this.config.spawnStatusIntervalMs);
      active.heartbeat.unref();
    }
    this.activeRuns.set(runId, active);

    const done = new Promise<CodexTurnResult>((resolve, reject) => {
      let settled = false;
      let finalOutput = "";
      const agentTextById = new Map<string, string>();
      const completedAgentTextById = new Map<string, string>();
      const completedAgentOrder: string[] = [];
      const completedOperationalBlocks: string[] = [];
      const streamedOutputs: string[] = [];
      let pendingStreamText = "";
      let lastStreamFlushAt = 0;
      let streamFlushTimer: NodeJS.Timeout | undefined;

      const buildVisibleTurnText = (activeItemId?: string): string => {
        const parts: string[] = [];
        for (const block of completedOperationalBlocks) {
          const text = block.trim();
          if (text) parts.push(text);
        }
        for (const itemId of completedAgentOrder) {
          const text = (completedAgentTextById.get(itemId) || "").trim();
          if (text) parts.push(text);
        }
        if (activeItemId) {
          const activeText = (agentTextById.get(activeItemId) || "").trim();
          if (activeText) {
            const completedText = completedAgentTextById.get(activeItemId);
            if (!completedText || completedText.trim() !== activeText) {
              parts.push(activeText);
            }
          }
        }
        return parts.join("\n\n").trim();
      };

      const pushOperationalBlock = (block: string): void => {
        const text = block.trim();
        if (!text) return;
        completedOperationalBlocks.push(text);
        pendingStreamText = buildVisibleTurnText();
        flushStreamText(true);
      };

      const renderOperationalBlock = (
        method: string,
        params: Record<string, unknown>
      ): string | undefined => {
        if (
          method === "item/commandExecution/requestApproval" ||
          method === "execCommandApproval"
        ) {
          const id =
            String(params.approvalId || "").trim() ||
            String(params.itemId || "").trim() ||
            String(params.callId || "").trim();
          const command = String(params.command || "").trim() ||
            (Array.isArray(params.command) ? params.command.map((item) => String(item)).join(" ") : "") ||
            "(unknown command)";
          const reason = String(params.reason || "").trim();
          const cwd = String(params.cwd || "").trim();
          const lines = ["```text", "Approval Required", "kind: command"];
          if (id) lines.push(`id: ${id}`);
          if (reason) lines.push(`reason: ${reason}`);
          if (cwd) lines.push(`cwd: ${cwd}`);
          lines.push(`command: ${command}`, "```");
          return lines.join("\n");
        }
        if (
          method === "item/fileChange/requestApproval" ||
          method === "applyPatchApproval"
        ) {
          const id =
            String(params.approvalId || "").trim() ||
            String(params.itemId || "").trim() ||
            String(params.callId || "").trim();
          const reason = String(params.reason || "").trim();
          const grantRoot = String(params.grantRoot || "").trim();
          const fileChanges = isRecord(params.fileChanges) ? params.fileChanges : {};
          const fileList = Object.keys(fileChanges).slice(0, 8);
          const lines = ["```text", "Approval Required", "kind: file change"];
          if (id) lines.push(`id: ${id}`);
          if (reason) lines.push(`reason: ${reason}`);
          if (grantRoot) lines.push(`grant root: ${grantRoot}`);
          if (fileList.length > 0) lines.push(`files: ${fileList.join(", ")}`);
          lines.push("```");
          return lines.join("\n");
        }
        if (method === "item/permissions/requestApproval") {
          const id =
            String(params.approvalId || "").trim() ||
            String(params.itemId || "").trim() ||
            String(params.callId || "").trim();
          const reason = String(params.reason || "").trim();
          const permissions = isRecord(params.permissions) ? params.permissions : {};
          const scopes = [
            permissions.network ? "network" : undefined,
            permissions.fileSystem ? "fileSystem" : undefined
          ].filter((item): item is string => Boolean(item));
          const lines = ["```text", "Approval Required", "kind: permissions"];
          if (id) lines.push(`id: ${id}`);
          if (reason) lines.push(`reason: ${reason}`);
          if (scopes.length > 0) lines.push(`scopes: ${scopes.join(", ")}`);
          lines.push("```");
          return lines.join("\n");
        }
        if (method === "item/tool/call") {
          const id =
            String(params.callId || "").trim() ||
            String(params.itemId || "").trim();
          const tool = String(params.tool || "").trim() || "(unknown)";
          const args = params.arguments;
          return [
            "```text",
            "Tool Call",
            ...(id ? [`id: ${id}`] : []),
            `tool: ${tool}`,
            "```",
            ...(args !== undefined
              ? [
                  "",
                  "```json",
                  safeJsonStringify(args),
                  "```"
                ]
              : [])
          ].join("\n");
        }
        if (method === "item/completed") {
          const item = isRecord(params.item) ? params.item : {};
          const type = String(item.type || "").trim();
          if (!type || type === "agentMessage") return undefined;
          const id = String(item.id || "").trim();
          const lines = ["```text", type === "commandExecution" ? "Command Completed" : "Codex Event"];
          if (id) lines.push(`id: ${id}`);
          lines.push(`type: ${type}`);
          const command = String(item.command || "").trim();
          const tool = String(item.tool || "").trim();
          const cwd = String(item.cwd || "").trim();
          if (command) lines.push(`command: ${command}`);
          if (tool) lines.push(`tool: ${tool}`);
          if (cwd) lines.push(`cwd: ${cwd}`);
          lines.push("```");
          return lines.join("\n");
        }
        if (method === "turn/diff/updated") {
          const turnId = String(params.turnId || "").trim();
          const diff = String(params.diff || "");
          const files = summarizeDiffFiles(diff);
          const lines = ["```text", "Diff Updated"];
          if (turnId) lines.push(`turn: ${turnId}`);
          if (files.length > 0) {
            lines.push(`files: ${files.join(", ")}`);
          } else {
            lines.push("files: (unknown)");
          }
          lines.push("```");
          return lines.join("\n");
        }
        return undefined;
      };

      const flushStreamText = (force = false): void => {
        const text = pendingStreamText.trim();
        if (!text) return;
        const now = Date.now();
        if (!force && now - lastStreamFlushAt < APP_SERVER_STREAM_UPDATE_INTERVAL_MS) {
          if (!streamFlushTimer) {
            streamFlushTimer = setTimeout(() => {
              streamFlushTimer = undefined;
              flushStreamText(true);
            }, APP_SERVER_STREAM_UPDATE_INTERVAL_MS - (now - lastStreamFlushAt));
            streamFlushTimer.unref();
          }
          return;
        }
        lastStreamFlushAt = now;
        pendingStreamText = text;
        sendUpdate(text);
      };

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (active.timeout) clearTimeout(active.timeout);
        if (active.heartbeat) clearInterval(active.heartbeat);
        if (streamFlushTimer) clearTimeout(streamFlushTimer);
        active.client.setServerRequestHandler(undefined);
        this.activeRuns.delete(runId);
        active.client.unsubscribe(handleNotification);
        this.scheduleClientShutdown(project, resolvedSessionId, active.client);
        fn();
      };

      active.client.setServerRequestHandler(async (request) => {
        const block = renderOperationalBlock(request.method, request.params);
        if (block) {
          pushOperationalBlock(block);
        }
        return hooks?.onServerRequest?.(request);
      });

      const handleNotification = (method: string, params: Record<string, unknown>): void => {
        void hooks?.onNotification?.({ method, params });
        if (String(params.threadId || "") !== resolvedSessionId) {
          return;
        }

        if (method === "turn/started") {
          const turn = isRecord(params.turn) ? params.turn : {};
          active.turnId = String(turn.id || "").trim();
          sendStatus(formatStatusWithProject(this.config, project, "Codex is thinking..."));
          if (active.cancelled && active.turnId) {
            void active.client.interruptTurn(resolvedSessionId, active.turnId).catch(() => undefined);
          }
          return;
        }

        if (method === "item/agentMessage/delta") {
          const itemId = String(params.itemId || "").trim();
          if (!itemId) return;
          const prior = agentTextById.get(itemId) || "";
          const delta = String(params.delta || "");
          const next = `${prior}${delta}`;
          agentTextById.set(itemId, next);
          const visibleText = buildVisibleTurnText(itemId) || next;
          console.log("Codex app-server agentMessage delta", {
            sessionId: resolvedSessionId,
            turnId: active.turnId,
            itemId,
            deltaPreview: previewText(delta),
            snapshotPreview: previewText(next),
            visiblePreview: previewText(visibleText)
          });
          pendingStreamText = visibleText;
          flushStreamText();
          return;
        }

        if (method === "item/completed") {
          const operationalBlock = renderOperationalBlock(method, params);
          if (operationalBlock) {
            pushOperationalBlock(operationalBlock);
          }
          const item = isRecord(params.item) ? params.item : {};
          if (String(item.type || "") !== "agentMessage") return;
          const itemId = String(item.id || "").trim();
          const text = String(item.text || agentTextById.get(itemId) || "").trim();
          if (!text) return;
          finalOutput = text;
          if (itemId && !completedAgentTextById.has(itemId)) {
            completedAgentOrder.push(itemId);
          }
          if (itemId) {
            completedAgentTextById.set(itemId, text);
          }
          pendingStreamText = buildVisibleTurnText() || text;
          flushStreamText(true);
          if (!streamedOutputs.includes(text)) {
            streamedOutputs.push(text);
            if (streamedOutputs.length > STREAMED_OUTPUT_DEDUPE_WINDOW) {
              streamedOutputs.shift();
            }
          }
          return;
        }

        if (method === "turn/interrupted") {
          finish(() =>
            resolve({
              runId,
              sessionId: resolvedSessionId,
              output: finalOutput || "Run cancelled or timed out.",
              status: "cancelled"
            })
          );
          return;
        }

        if (method === "turn/failed") {
          const turn = isRecord(params.turn) ? params.turn : {};
          const error = isRecord(turn.error) ? turn.error : {};
          const message = String(error.message || turn.error || "Codex app-server turn failed.").trim();
          finish(() => reject(new Error(message)));
          return;
        }

        if (method === "turn/completed") {
          flushStreamText(true);
          const output =
            finalOutput ||
            Array.from(agentTextById.values())
              .join("\n")
              .trim() ||
            "Codex completed without a final message.";
          finish(() =>
            resolve({
              runId,
              sessionId: resolvedSessionId,
              output: active.cancelled ? finalOutput || "Run cancelled or timed out." : output,
              status: active.cancelled ? "cancelled" : "completed"
            })
          );
        }
      };

      active.client.subscribe(handleNotification);

      void active.client
        .startTurn(resolvedSessionId, input.text, options)
        .then((turnId) => {
          active.turnId = turnId || active.turnId;
          if (active.cancelled && active.turnId) {
            return active.client.interruptTurn(resolvedSessionId, active.turnId);
          }
          return undefined;
        })
        .catch((error) => {
          if (active.cancelled) {
            finish(() =>
              resolve({
                runId,
                sessionId: resolvedSessionId,
                output: finalOutput || "Run cancelled or timed out.",
                status: "cancelled"
              })
            );
            return;
          }
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        });
    });

    return { runId, done };
  }

  async stop(runId: string): Promise<boolean> {
    const active = this.activeRuns.get(runId);
    if (!active) return false;
    active.cancelled = true;
    if (active.timeout) clearTimeout(active.timeout);
    if (active.heartbeat) clearInterval(active.heartbeat);
    if (active.turnId) {
      await active.client.interruptTurn(active.sessionId, active.turnId).catch(() => undefined);
    } else {
      this.clearIdleShutdown(this.clientKey(active.client.project, active.sessionId));
      this.evictClient(active.client);
      await active.client.shutdown().catch(() => undefined);
    }
    return true;
  }

  async getSession(sessionId: string): Promise<boolean> {
    const filePath = await findSessionFile(this.config.sessionsDir, sessionId);
    return filePath !== undefined;
  }

  async readThread(
    sessionId: string,
    project: string,
    includeTurns = false
  ): Promise<Record<string, unknown> | undefined> {
    const clientInfo = await this.getOrCreateClient(project, sessionId);
    return clientInfo.client.readThread(sessionId, includeTurns);
  }

  async compactSession(
    sessionId: string,
    project: string
  ): Promise<Record<string, unknown> | undefined> {
    const clientInfo = await this.getOrCreateClient(project, sessionId);
    if (this.hasActiveRunForClient(clientInfo.client)) {
      throw new Error(`Codex session ${sessionId} already has an active run.`);
    }
    try {
      const compact = await clientInfo.client.compactSession(sessionId);
      const summary = await clientInfo.client.getConversationSummary(sessionId).catch(() => undefined);
      return {
        ...(compact || {}),
        ...(summary || {})
      };
    } finally {
      this.scheduleClientShutdown(project, sessionId, clientInfo.client);
    }
  }

  async getConversationSummary(
    sessionId: string,
    project: string
  ): Promise<Record<string, unknown> | undefined> {
    const clientInfo = await this.getOrCreateClient(project, sessionId);
    try {
      return await clientInfo.client.getConversationSummary(sessionId);
    } finally {
      this.scheduleClientShutdown(project, sessionId, clientInfo.client);
    }
  }

  async readAccountRateLimits(project: string): Promise<Record<string, unknown> | undefined> {
    const client = new AppServerSessionClient(this.config, project);
    try {
      return await client.readAccountRateLimits();
    } finally {
      await client.shutdown().catch(() => undefined);
    }
  }

  async readAccount(project: string): Promise<Record<string, unknown> | undefined> {
    const client = new AppServerSessionClient(this.config, project);
    try {
      return await client.readAccount();
    } finally {
      await client.shutdown().catch(() => undefined);
    }
  }

  async listModels(
    project: string,
    options?: { includeHidden?: boolean; limit?: number }
  ): Promise<Record<string, unknown> | undefined> {
    const client = new AppServerSessionClient(this.config, project);
    try {
      return await client.listModels(options);
    } finally {
      await client.shutdown().catch(() => undefined);
    }
  }

  async listSkills(
    project: string,
    options?: { forceReload?: boolean }
  ): Promise<Record<string, unknown> | undefined> {
    const client = new AppServerSessionClient(this.config, project);
    try {
      return await client.listSkills(options);
    } finally {
      await client.shutdown().catch(() => undefined);
    }
  }

  async readConfig(
    project: string,
    options?: { includeLayers?: boolean }
  ): Promise<Record<string, unknown> | undefined> {
    const client = new AppServerSessionClient(this.config, project);
    try {
      return await client.readConfig(options);
    } finally {
      await client.shutdown().catch(() => undefined);
    }
  }

  private async getOrCreateClient(
    project: string,
    sessionId: string | undefined,
    options?: CodexTurnOptions
  ): Promise<{ client: AppServerSessionClient; sessionId: string }> {
    if (sessionId) {
      const key = this.clientKey(project, sessionId);
      this.clearIdleShutdown(key);
      const existing = this.clients.get(key);
      if (existing?.isAlive()) {
        await existing.resumeSession(sessionId, options);
        return { client: existing, sessionId };
      }
      const client = new AppServerSessionClient(this.config, project);
      await client.resumeSession(sessionId, options);
      this.clients.set(key, client);
      return { client, sessionId };
    }

    const createdSessionId = await this.bootstrapBackend.createSession(
      project,
      this.bootstrapOptions(options)
    );
    this.clearIdleShutdown(this.clientKey(project, createdSessionId));
    const client = new AppServerSessionClient(this.config, project);
    await client.resumeSession(createdSessionId, options);
    this.clients.set(this.clientKey(project, createdSessionId), client);
    return { client, sessionId: createdSessionId };
  }

  private clientKey(project: string, sessionId: string): string {
    return `${project}::${sessionId}`;
  }

  private evictClient(client: AppServerSessionClient): void {
    for (const [key, value] of this.clients.entries()) {
      if (value === client) {
        this.clearIdleShutdown(key);
        this.clients.delete(key);
      }
    }
  }

  private scheduleClientShutdown(
    project: string,
    sessionId: string,
    client: AppServerSessionClient
  ): void {
    if (this.hasActiveRunForClient(client)) return;

    const key = this.clientKey(project, sessionId);
    this.clearIdleShutdown(key);

    const timer = setTimeout(() => {
      this.idleShutdowns.delete(key);
      if (this.clients.get(key) !== client) return;
      if (this.hasActiveRunForClient(client)) return;
      this.clients.delete(key);
      void client.shutdown().catch(() => undefined);
    }, APP_SERVER_CLIENT_IDLE_SHUTDOWN_MS);
    timer.unref();
    this.idleShutdowns.set(key, timer);
  }

  private clearIdleShutdown(key: string): void {
    const timer = this.idleShutdowns.get(key);
    if (timer) {
      clearTimeout(timer);
      this.idleShutdowns.delete(key);
    }
  }

  private hasActiveRunForClient(client: AppServerSessionClient): boolean {
    for (const active of this.activeRuns.values()) {
      if (active.client === client) {
        return true;
      }
    }
    return false;
  }

  private bootstrapOptions(options?: CodexTurnOptions): CodexTurnOptions | undefined {
    if (!options) return undefined;
    return {
      ...options,
      searchEnabled: false
    };
  }
}

class SpawnCodexBackend implements CodexBackend {
  readonly mode = "spawn" as const;
  private readonly activeRuns = new Map<string, ActiveProcess>();

  constructor(private readonly config: AppConfig["codex"]) {}

  async createSession(project: string, options?: CodexTurnOptions): Promise<string> {
    const handle = await this.executeTurn({
      prompt: CREATE_SESSION_PROMPT,
      project,
      options
    });
    const result = await handle.done;
    return result.sessionId;
  }

  async runTurn(
    input: IncomingMessage,
    sessionId: string | undefined,
    project: string,
    options?: CodexTurnOptions,
    hooks?: CodexRunHooks
  ): Promise<CodexRunHandle> {
    return this.executeTurn({
      prompt: input.text,
      project,
      sessionId,
      options,
      hooks
    });
  }

  async stop(runId: string): Promise<boolean> {
    const active = this.activeRuns.get(runId);
    if (!active) return false;
    active.cancelled = true;
    if (active.timeout) clearTimeout(active.timeout);
    active.child.kill("SIGTERM");
    setTimeout(() => {
      if (!active.child.killed) {
        active.child.kill("SIGKILL");
      }
    }, 2_000).unref();
    return true;
  }

  async getSession(sessionId: string): Promise<boolean> {
    const filePath = await findSessionFile(this.config.sessionsDir, sessionId);
    return filePath !== undefined;
  }

  private async executeTurn(params: {
    prompt: string;
    project: string;
    sessionId?: string;
    options?: CodexTurnOptions;
    hooks?: CodexRunHooks;
  }): Promise<CodexRunHandle> {
    const runId = randomUUID();
    await ensureProject(params.project);
    let lastActivityAt = Date.now();

    const sendStatus = (text: string): void => {
      lastActivityAt = Date.now();
      void params.hooks?.onStatus?.(text);
    };

    const sendUpdate = (text: string): void => {
      lastActivityAt = Date.now();
      void params.hooks?.onUpdate?.(text);
    };

    const args = ["exec", "--json", "--skip-git-repo-check", "--cd", params.project];

    if (params.options?.searchEnabled !== undefined) {
      args.push("-c", `web_search="${params.options.searchEnabled ? "live" : "disabled"}"`);
    }
    if (params.options?.model) {
      args.push("-m", params.options.model);
    }
    if (params.options?.profile) {
      args.push("-p", params.options.profile);
    }

    if (this.config.sandboxMode === "danger-full-access") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      args.push("--full-auto");
    }

    if (params.sessionId) {
      args.push("resume", params.sessionId, params.prompt);
    } else {
      args.push(params.prompt);
    }

    const child = spawn(this.config.bin, args, {
      cwd: params.project,
      env: {
        ...process.env,
        CODEX_HOME: this.config.home,
        HOME: process.env.HOME || path.dirname(this.config.home)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const active: ActiveProcess = { child, cancelled: false };
    sendStatus(
      formatStatusWithProject(
        this.config,
        params.project,
        params.sessionId
          ? `resuming Codex session ${params.sessionId}...`
          : "starting a new Codex session..."
      )
    );
    if (this.config.runTimeoutMs > 0) {
      active.timeout = setTimeout(() => {
        active.cancelled = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
        }, 2_000).unref();
      }, this.config.runTimeoutMs);
      active.timeout.unref();
    }
    if (this.config.spawnStatusIntervalMs > 0) {
      active.heartbeat = setInterval(() => {
        if (Date.now() - lastActivityAt >= this.config.spawnStatusIntervalMs) {
          sendStatus(
            `${formatStatusWithProject(this.config, params.project, "Codex is still working...")}\nrun=${runId}`
          );
        }
      }, this.config.spawnStatusIntervalMs);
      active.heartbeat.unref();
    }
    this.activeRuns.set(runId, active);

    const done = new Promise<CodexTurnResult>((resolve, reject) => {
      let sessionId = params.sessionId;
      let finalOutput = "";
      let stderr = "";
      let settled = false;
      let lastStreamedOutput = "";
      const streamedOutputs: string[] = [];

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (active.timeout) clearTimeout(active.timeout);
        if (active.heartbeat) clearInterval(active.heartbeat);
        this.activeRuns.delete(runId);
        fn();
      };

      const stdoutLines = readline.createInterface({ input: child.stdout as Readable });
      stdoutLines.on("line", (line) => {
        const event = parseJsonLine(line);
        if (!event) return;

        if (typeof event.thread_id === "string" && !sessionId) {
          sessionId = event.thread_id;
          return;
        }

        if (event.type === "turn.started") {
          sendStatus(formatStatusWithProject(this.config, params.project, "Codex is thinking..."));
          return;
        }

        if (event.type === "item.completed" && event.item?.type === "agent_message") {
          if (typeof event.item.text === "string") {
            finalOutput = event.item.text;
            const normalized = event.item.text.trim();
            if (
              normalized &&
              event.item.text !== lastStreamedOutput &&
              !streamedOutputs.includes(normalized)
            ) {
              lastStreamedOutput = event.item.text;
              streamedOutputs.push(normalized);
              if (streamedOutputs.length > STREAMED_OUTPUT_DEDUPE_WINDOW) {
                streamedOutputs.shift();
              }
              sendUpdate(event.item.text);
            }
          }
        }
      });

      const stderrLines = readline.createInterface({ input: child.stderr as Readable });
      stderrLines.on("line", (line) => {
        stderr += `${line}\n`;
        if (line.includes("failed to connect to websocket")) {
          sendStatus("Codex upstream websocket failed, retrying...");
        }
      });

      child.on("error", (error) => {
        finish(() => reject(error));
      });

      child.on("close", (code, signal) => {
        stdoutLines.close();
        stderrLines.close();

        if (!sessionId) {
          finish(() => reject(new Error("Codex did not emit a session id.")));
          return;
        }
        const resolvedSessionId = sessionId;

        if (active.cancelled || signal === "SIGTERM" || signal === "SIGKILL") {
          finish(() =>
            resolve({
              runId,
              sessionId: resolvedSessionId,
              output: finalOutput || "Run cancelled or timed out.",
              status: "cancelled"
            })
          );
          return;
        }

        if (code !== 0) {
          finish(() =>
            reject(
              new Error(
                stderr.trim() ||
                  `Codex exited with code ${code ?? "unknown"} for session ${resolvedSessionId}`
              )
            )
          );
          return;
        }

        finish(() =>
          resolve({
            runId,
            sessionId: resolvedSessionId,
            output: finalOutput || "Codex completed without a final message.",
            status: "completed"
          })
        );
      });
    });

    return { runId, done };
  }
}

class TerminalCodexBackend implements CodexBackend {
  readonly mode = "terminal" as const;
  private readonly terminals = new Map<string, TerminalSession>();

  constructor(
    private readonly config: AppConfig["codex"],
    private readonly spawnBackend: SpawnCodexBackend
  ) {}

  async createSession(project: string, options?: CodexTurnOptions): Promise<string> {
    return this.spawnBackend.createSession(project, options);
  }

  async runTurn(
    input: IncomingMessage,
    sessionId: string | undefined,
    project: string,
    options?: CodexTurnOptions,
    hooks?: CodexRunHooks
  ): Promise<CodexRunHandle> {
    const resolvedSessionId = sessionId || (await this.createSession(project, options));
    const runId = randomUUID();
    const done = (async () => {
      await hooks?.onStatus?.("starting terminal session...");
      const terminal = await this.getOrCreateTerminal(resolvedSessionId, project);
      const handle = terminal.runTurn(input.text, runId, hooks);
      return handle.done;
    })();
    return { runId, done };
  }

  async stop(runId: string): Promise<boolean> {
    for (const terminal of this.terminals.values()) {
      if (terminal.currentRunId === runId) {
        await terminal.stop();
        return true;
      }
    }
    return false;
  }

  async getSession(sessionId: string): Promise<boolean> {
    const filePath = await findSessionFile(this.config.sessionsDir, sessionId);
    return filePath !== undefined;
  }

  private async getOrCreateTerminal(sessionId: string, project: string): Promise<TerminalSession> {
    const existing = this.terminals.get(sessionId);
    if (existing && existing.isAlive()) {
      await existing.ready();
      return existing;
    }
    if (existing) {
      this.terminals.delete(sessionId);
    }

    const terminal = new TerminalSession({
      codex: this.config,
      sessionId,
      project
    });
    this.terminals.set(sessionId, terminal);
    try {
      await terminal.ready();
      return terminal;
    } catch (error) {
      this.terminals.delete(sessionId);
      throw error;
    }
  }
}

interface TerminalSessionOptions {
  codex: AppConfig["codex"];
  sessionId: string;
  project: string;
}

class TerminalSession {
  readonly sessionId: string;
  readonly project: string;
  currentRunId?: string;

  private readonly ptyProcess: pty.IPty;
  private readonly emulator: InstanceType<typeof xterm.Terminal>;
  private rawBuffer = "";
  private alive = true;
  private startupDone = false;
  private startupPromise: Promise<void>;
  private startupResolve!: () => void;
  private startupReject!: (error: Error) => void;
  private pending?: PendingTerminalRun;
  private startupChunkCount = 0;

  constructor(private readonly options: TerminalSessionOptions) {
    this.sessionId = options.sessionId;
    this.project = options.project;

    this.startupPromise = new Promise<void>((resolve, reject) => {
      this.startupResolve = resolve;
      this.startupReject = reject;
    });

    const args = ["--no-alt-screen", "--cd", this.project];
    if (this.options.codex.sandboxMode === "danger-full-access") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      args.push("--full-auto");
    }
    args.push("resume", this.sessionId);

    this.ptyProcess = pty.spawn(this.options.codex.bin, args, {
      name: "xterm-256color",
      cols: 100,
      rows: 28,
      cwd: this.project,
      env: {
        ...process.env,
        CODEX_HOME: this.options.codex.home,
        HOME: process.env.HOME || path.dirname(this.options.codex.home)
      }
    });
    this.emulator = new xterm.Terminal({
      cols: 100,
      rows: 28,
      allowProposedApi: true
    });
    this.emulator.onData((data) => {
      this.ptyProcess.write(data);
    });

    this.ptyProcess.onData((chunk) => {
      this.emulator.write(chunk);
      this.rawBuffer += chunk;
      this.startupChunkCount += 1;

      if (!this.startupDone && this.promptVisible()) {
        this.startupDone = true;
        this.logStartupDebug("ready");
        this.startupResolve();
      }

      if (this.pending) {
        if (this.pending.idleTimer) clearTimeout(this.pending.idleTimer);
        this.pending.idleTimer = setTimeout(
          () => this.tryResolvePending(),
          this.options.codex.terminalFlushIdleMs
        );
      }
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this.alive = false;
      const error = new Error(
        `Terminal Codex session exited (code=${exitCode}, signal=${signal}) for session ${this.sessionId}`
      );
      if (!this.startupDone) {
        this.startupReject(error);
      }
      if (this.pending) {
        const pending = this.pending;
        this.pending = undefined;
        if (pending.idleTimer) clearTimeout(pending.idleTimer);
        pending.reject(error);
      }
    });

    setTimeout(() => {
      if (!this.startupDone) {
        this.logStartupDebug("timeout");
        this.startupReject(
          new Error(`Timed out waiting for interactive Codex terminal startup: ${this.sessionId}`)
        );
      }
    }, this.options.codex.terminalStartupTimeoutMs).unref();
  }

  isAlive(): boolean {
    return this.alive;
  }

  async ready(): Promise<void> {
    await this.startupPromise;
  }

  runTurn(prompt: string, runId: string, hooks?: CodexRunHooks): CodexRunHandle {
    if (this.pending) {
      throw new Error(`Terminal session ${this.sessionId} is already busy.`);
    }

    this.currentRunId = runId;
    const marker = this.rawBuffer.length;
    const baselineScreen = this.visibleScreenText();

    const done = new Promise<CodexTurnResult>((resolve, reject) => {
      this.pending = {
        runId,
        prompt,
        marker,
        baselineScreen,
        hooks,
        lastOutput: "",
        resolve: (result) => {
          this.currentRunId = undefined;
          resolve(result);
        },
        reject: (error) => {
          this.currentRunId = undefined;
          reject(error);
        }
      };
      // Clear any draft text or suggested slash command left in the input line.
      this.ptyProcess.write("\u0015");
      this.ptyProcess.write(prompt);
      this.ptyProcess.write("\r\n");
    });

    return { runId, done };
  }

  async stop(): Promise<void> {
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      if (pending.idleTimer) clearTimeout(pending.idleTimer);
      this.ptyProcess.write("\u0003");
      pending.resolve({
        runId: pending.runId,
        sessionId: this.sessionId,
        output: formatTerminalOutput("Run cancelled.", this.options.codex.terminalRenderMode),
        status: "cancelled"
      });
    }
    this.ptyProcess.kill();
    this.emulator.dispose();
    this.alive = false;
  }

  private tryResolvePending(): void {
    if (!this.pending) return;
    const pending = this.pending;
    const rawDelta = this.rawBuffer.slice(pending.marker);
    const deltaSnapshot = normalizeTerminalDelta(rawDelta, pending.prompt);
    const screenDelta = stripScreenPrefix(this.visibleScreenText(), pending.baselineScreen);
    const screenSnapshot = normalizeTerminalDelta(screenDelta, pending.prompt);
    const snapshot = deltaSnapshot.cleaned ? deltaSnapshot : screenSnapshot.cleaned ? screenSnapshot : deltaSnapshot;
    if (!snapshot.cleaned) return;
    const rendered = limitTerminalOutput(
      renderTerminalForFeishu(snapshot, this.options.codex.terminalRenderMode),
      this.options.codex.terminalFlushMaxChars
    );

    if (rendered !== pending.lastOutput) {
      pending.lastOutput = rendered;
      void pending.hooks?.onUpdate?.(rendered);
    }

    if (!snapshot.hasPrompt && !this.promptVisible()) return;

    this.pending = undefined;
    if (pending.idleTimer) clearTimeout(pending.idleTimer);
    pending.resolve({
      runId: pending.runId,
      sessionId: this.sessionId,
      output: rendered,
      status: "completed"
    });
  }

  private cleanedTail(): string {
    return simplifyTerminalBytes(this.rawBuffer.slice(-8000));
  }

  private visibleScreenText(): string {
    const lines: string[] = [];
    const buffer = this.emulator.buffer.active;
    const total = Math.min(this.emulator.rows + 20, buffer.length);
    const start = Math.max(0, buffer.length - total);
    for (let y = start; y < buffer.length; y++) {
      lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  }

  private promptVisible(): boolean {
    return hasPrompt(this.visibleScreenText()) || hasPrompt(this.cleanedTail());
  }

  private logStartupDebug(reason: "ready" | "timeout"): void {
    const visible = this.visibleScreenText().trim();
    const cleanedTail = normalizeWhitespaceForLog(this.cleanedTail());
    const rawTail = escapeControlForLog(this.rawBuffer.slice(-4000));
    const rawHead = escapeControlForLog(this.rawBuffer.slice(0, 1200));

    console.warn("terminal startup debug", {
      reason,
      sessionId: this.sessionId,
      project: this.project,
      startupDone: this.startupDone,
      startupChunkCount: this.startupChunkCount,
      rawBytes: this.rawBuffer.length,
      hasPromptInCleanedTail: hasPrompt(this.cleanedTail()),
      hasPromptInVisibleScreen: hasPrompt(this.visibleScreenText()),
      cleanedTail,
      visibleScreen: visible || "(empty)",
      rawHead,
      rawTail
    });
  }
}

interface PendingTerminalRun {
  runId: string;
  prompt: string;
  marker: number;
  baselineScreen: string;
  idleTimer?: NodeJS.Timeout;
  hooks?: CodexRunHooks;
  lastOutput: string;
  resolve: (result: CodexTurnResult) => void;
  reject: (error: Error) => void;
}

async function ensureProject(project: string): Promise<void> {
  const stats = await fs.stat(project).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new Error(`Project does not exist: ${project}`);
  }
}

function parseJsonLine(line: string): Record<string, any> | undefined {
  try {
    return JSON.parse(line) as Record<string, any>;
  } catch {
    return undefined;
  }
}

function formatTerminalOutput(text: string, mode: "markdown" | "plain"): string {
  if (mode === "plain") return text || "(no clean terminal output)";
  return ["**Codex Terminal**", "```text", text || "(no clean terminal output)", "```"].join("\n");
}

function limitTerminalOutput(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const suffix = "\n\n[terminal output truncated]";
  const budget = Math.max(0, maxChars - suffix.length);
  return `${text.slice(0, budget).trimEnd()}${suffix}`;
}

function normalizeWhitespaceForLog(text: string): string {
  return text.replace(/\r/g, "\\r").replace(/\n/g, "\\n\n").trim();
}

function escapeControlForLog(text: string): string {
  return text
    .replace(/\u001b/g, "\\u001b")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n\n");
}

function simplifyTerminalBytes(text: string): string {
  return stripAnsi(text)
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "")
    .replace(/\r/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

function stripScreenPrefix(current: string, baseline: string): string {
  const currentLines = current.split("\n");
  const baselineLines = baseline.split("\n");
  let idx = 0;
  while (idx < currentLines.length && idx < baselineLines.length && currentLines[idx] === baselineLines[idx]) {
    idx += 1;
  }
  return currentLines.slice(idx).join("\n");
}

function previewText(value: string, maxLength = 120): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3)}...`;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeDiffFiles(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split(/\r?\n/)) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (!match) continue;
    const file = match[2] || match[1];
    if (file && !files.includes(file)) {
      files.push(file);
    }
    if (files.length >= 8) break;
  }
  return files;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object";
}
