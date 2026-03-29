import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CodexBackend, CodexServerRequest } from "../adapters/codex/backend.js";
import { createCodexBackend } from "../adapters/codex/codex-runtime.js";
import { FeishuGateway } from "../adapters/feishu/feishu-gateway.js";
import { AppConfig } from "../config/env.js";
import { conversationKeyFor } from "./conversation-key.js";
import { parseCommand } from "./command-router.js";
import { BindingStore } from "../store/binding-store.js";
import { ActiveRun, IncomingMessage, OutgoingMessage, SessionBinding } from "../types/domain.js";
import { getSessionSummary, listRecentSessions } from "../adapters/codex/session-files.js";
import { listTrustedProjects } from "../adapters/codex/project-files.js";
import { getCodexRuntimeMeta } from "../adapters/codex/runtime-meta.js";

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 30_000;
const GIT_OUTPUT_SOFT_LIMIT = 12_000;

type SessionListEntry = {
  sessionId: string;
  createdAt?: string;
  cwd?: string;
  preview?: string;
  source?: string;
};

type AppResponse = {
  text: string;
  severity?: "warning" | "error";
};

class ArgCursor {
  private readonly args: string[];

  constructor(args: string[]) {
    this.args = [...args];
  }

  peek(): string | undefined {
    return this.args[0];
  }

  shift(): string | undefined {
    return this.args.shift();
  }

  isEmpty(): boolean {
    return this.args.length === 0;
  }

  remaining(): string[] {
    return [...this.args];
  }

  remainingText(): string {
    return this.args.join(" ").trim();
  }

  takeFlag(...names: string[]): boolean {
    const index = this.args.findIndex((arg) => names.includes(arg));
    if (index < 0) return false;
    this.args.splice(index, 1);
    return true;
  }

  takeOption(...names: string[]): string | undefined {
    const index = this.args.findIndex((arg) => names.includes(arg));
    if (index < 0) return undefined;
    const value = this.args[index + 1];
    this.args.splice(index, value ? 2 : 1);
    if (!value || value.startsWith("-")) {
      return "";
    }
    return value;
  }
}

const SESSION_SOURCE_KINDS = [
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

export class App {
  private readonly store: BindingStore;
  private readonly codex: CodexBackend;
  private feishu?: FeishuGateway;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly latestTokenUsage = new Map<string, Record<string, unknown>>();
  private readonly latestPlan = new Map<string, { explanation?: string; plan: Array<Record<string, unknown>> }>();
  private readonly latestModelReroute = new Map<string, { fromModel: string; toModel: string; reason?: string }>();
  private readonly latestTurnDiff = new Map<string, { turnId: string; diff: string }>();
  private latestAccountUpdate?: Record<string, unknown>;
  private latestRateLimits?: Record<string, unknown>;

  constructor(private readonly config: AppConfig) {
    this.store = new BindingStore(path.resolve(this.config.storePath));
    this.codex = createCodexBackend(this.config.codex);
  }

  async start(): Promise<void> {
    console.log("codex-feishu-bridge starting", {
      nodeEnv: this.config.nodeEnv,
      configPath: this.config.configPath,
      projectAllowedRoots: this.config.project.allowedRoots,
      defaultProject: this.config.project.defaultProject,
      codexBin: this.config.codex.bin,
      codexHome: this.config.codex.home,
      codexProfileMode: this.config.codex.profileMode,
      codexBackendMode: this.codex.mode,
      codexSandboxMode: this.config.codex.sandboxMode
    });
    if (this.config.codex.profileMode === "personal" && this.codex.mode === "spawn") {
      console.warn(
        "Using CODEX_PROFILE_MODE=personal with spawn backend. This shares ~/.codex with your interactive Codex and may cause instability."
      );
    }
    this.feishu = new FeishuGateway(this.config.feishu);
    await this.feishu.start(
      async (message) => {
        const command = parseCommand(message);
        const currentBinding = await this.store.get(conversationKeyFor(message));
        const messageTitle = this.titleForCommand(command?.name, message.text);
        const messageTemplate = this.templateForCommand(command?.name);
        const messageFooter = this.footerForMessage(command?.name, currentBinding);
        const formatForFeishu = (text: string): string =>
          command?.name ? this.stripLeadingMarkdownHeading(text) : text;
        try {
          let streamed = false;
          let lastUpdateText: string | undefined;
          let accumulatedStreamText = "";
          let statusChain = Promise.resolve();
          let streamingSendInFlight = false;
          let queuedStreamingSnapshot: string | undefined;
          let streamDrain = Promise.resolve();
          const streamKey = `${message.chatId}:${message.threadId || "root"}:${message.messageId}:${command?.name || "codex"}`;
          const sendStatusSafely = async (update: string): Promise<void> => {
            statusChain = statusChain.then(async () => {
              try {
                const latestBinding =
                  (await this.store.get(conversationKeyFor(message))) || currentBinding;
                const formattedUpdate = formatForFeishu(update);
                const codexStatusHeading = !command?.name
                  ? this.extractLeadingMarkdownHeading(formattedUpdate)
                  : undefined;
                const statusTitle = codexStatusHeading
                  ? this.composeTitle("Codex", "🤖", codexStatusHeading.heading)
                  : messageTitle;
                const statusText = codexStatusHeading
                  ? codexStatusHeading.body
                  : formattedUpdate;
                console.log("Bridge app-server status route", {
                  messageId: message.messageId,
                  chatId: message.chatId,
                  threadId: message.threadId,
                  command: command?.name || "codex",
                  route: "status-card",
                  title: statusTitle,
                  textPreview: this.previewText(statusText)
                });
                await this.feishu?.send({
                  chatId: message.chatId,
                  title: statusTitle,
                  template: messageTemplate,
                  footer: command?.name
                    ? this.footerForMessage(command?.name, latestBinding)
                    : this.footerForCodexReply(latestBinding),
                  text: statusText,
                  replyToMessageId: message.messageId,
                  threadId: message.threadId,
                  streaming: false,
                  includeRawMarkdown: false
                });
              } catch (error) {
                console.error("failed to send Feishu update", {
                  messageId: message.messageId,
                  chatId: message.chatId,
                  threadId: message.threadId,
                textPreview: this.previewText(update),
                error
                });
              }
            });
            await statusChain;
          };
          const sendStreamSnapshot = async (snapshot: string): Promise<void> => {
            try {
              const latestBinding =
                (await this.store.get(conversationKeyFor(message))) || currentBinding;
              console.log("Bridge app-server content route", {
                messageId: message.messageId,
                chatId: message.chatId,
                threadId: message.threadId,
                streamKey,
                route: "stream-card",
                final: false,
                textPreview: this.previewText(snapshot)
              });
              await this.feishu?.send({
                chatId: message.chatId,
                title: messageTitle,
                template: messageTemplate,
                footer: this.footerForCodexReply(latestBinding),
                text: snapshot,
                replyToMessageId: message.messageId,
                threadId: message.threadId,
                streaming: true,
                streamKey,
                suppressChunkFooter: true,
                preserveStreamingPages: true
              });
              streamed = true;
              lastUpdateText = snapshot;
              accumulatedStreamText = snapshot;
            } catch (error) {
              console.error("failed to send Feishu streaming update", {
                messageId: message.messageId,
                chatId: message.chatId,
                threadId: message.threadId,
                textPreview: this.previewText(snapshot),
                error
              });
            }
          };
          const sendUpdateSafely = async (update: string): Promise<void> => {
            if (command?.name) {
              await sendStatusSafely(update);
              return;
            }
            const formattedUpdate = formatForFeishu(update);
            const outgoingText = formattedUpdate;
            queuedStreamingSnapshot = outgoingText;
            console.log("Bridge app-server content queue", {
              messageId: message.messageId,
              chatId: message.chatId,
              threadId: message.threadId,
              streamKey,
              inFlight: streamingSendInFlight,
              queuedPreview: this.previewText(outgoingText)
            });
            if (streamingSendInFlight) {
              await streamDrain;
              return;
            }
            streamingSendInFlight = true;
            streamDrain = (async () => {
              while (queuedStreamingSnapshot !== undefined) {
                const snapshot = queuedStreamingSnapshot;
                queuedStreamingSnapshot = undefined;
                await sendStreamSnapshot(snapshot);
              }
              streamingSendInFlight = false;
            })();
            await streamDrain;
          };

          const result = await this.handleIncoming(message, sendUpdateSafely, sendStatusSafely);
          const text = typeof result === "string" ? result : result.text;
          const responseSeverity = typeof result === "string" ? undefined : result.severity;
          await statusChain;
          await streamDrain;
          const formattedText = command?.name
            ? formatForFeishu(text)
            : accumulatedStreamText || formatForFeishu(text);
          const shouldFinalizeLiveStream = !command?.name && streamed;
          if ((formattedText && formattedText !== lastUpdateText) || !streamed || shouldFinalizeLiveStream) {
            const latestBinding =
              (await this.store.get(conversationKeyFor(message))) || currentBinding;
            const finalFooter = command?.name
              ? this.footerForMessage(command?.name, latestBinding)
              : this.footerForCodexReply(latestBinding);
            const finalTemplate =
              command?.name
                ? this.templateForSeverity(messageTemplate, responseSeverity)
                : messageTemplate;
            console.log("Bridge final outbound route", {
              messageId: message.messageId,
              chatId: message.chatId,
              threadId: message.threadId,
              command: command?.name || "codex",
              streamed,
              shouldFinalizeLiveStream,
              route: command?.name ? "status-card" : "stream-card-finalize",
              streamKey: command?.name ? undefined : streamKey,
              textPreview: this.previewText(formattedText)
            });
            await this.feishu?.send({
              chatId: message.chatId,
              title: messageTitle,
              template: finalTemplate,
              footer: finalFooter,
              text: formattedText,
              replyToMessageId: message.messageId,
              threadId: message.threadId,
              streaming: true,
              includeRawMarkdown: false,
              ...(command?.name ? {} : { streamKey, finalizeStreaming: true, suppressChunkFooter: true, preserveStreamingPages: true })
            });
          }
          console.log("bridge handled message", {
            messageId: message.messageId,
            chatId: message.chatId,
            threadId: message.threadId,
            streamed,
            finalPreview: this.previewText(text)
          });
        } catch (error) {
          const text = error instanceof Error ? error.message : "Unknown bridge error.";
          try {
            await this.feishu?.send({
              chatId: message.chatId,
              title: messageTitle || "Bridge Error",
              template: "red",
              footer: this.buildIsoFooter(),
              text: `bridge error: ${text}`,
              replyToMessageId: message.messageId,
              threadId: message.threadId
            });
          } catch (sendError) {
            console.error("failed to send bridge error to Feishu", sendError);
          }
        }
      },
      async () => {
        await this.sendStartupReadyNotification("Reconnected", "Feishu reconnect ready notification sent");
      }
    );
    await this.sendStartupReadyNotification("Bridge Ready", "Feishu startup ready notification sent");
  }

  async handleIncoming(
    message: IncomingMessage,
    onUpdate?: (text: string) => Promise<void>,
    onStatus?: (text: string) => Promise<void>
  ): Promise<string | AppResponse> {
    if (message.chatType !== "p2p") {
      return "Only direct messages are supported right now.";
    }

    const command = parseCommand(message);
    if (command?.name === "help") {
      return [
        "# Bridge Help",
        "",
        "## Core",
        "",
        "- `/help [-h|--help]` show commands",
        "- `/status [check-update] [-h|--help]` show current session and run state",
        "- `/new [-C|--cd <dir>] [-h|--help]` create and bind a fresh Codex session",
        "- `/fork [<session-id>|options] [-h|--help]` fork a Codex session and bind the new fork",
        "- `/session [list [options]] [-h|--help]` show the current session or browse recent sessions",
        "- `/resume [<session-id>|options] [-h|--help]` bind a session, optionally switching project",
        "- `/stop [-h|--help]` stop the current active run",
        "",
        "## Codex",
        "",
        "- `/compact [-h|--help]` compact the current bound Codex session",
        "- `/summary [-h|--help]` show the current bound Codex conversation summary",
        "- `/diff [-h|--help]` show the latest app-server turn diff for the current bound session",
        "- `/skills [--reload] [-h|--help]` show Codex skills visible for the current project",
        "- `/config [codex-toml] [--layers] [-h|--help]` show key Codex config values for the current project",
        "- `/approvals [mode] [-h|--help]` show or change Codex approvals for future runs",
        "- `/search [on|off] [-h|--help]` show or change live web search for this conversation",
        "- `/model [--list|name|clear] [-h|--help]` show, list, or change the Codex model for this conversation",
        "- `/profile [name|clear] [-h|--help]` show or change the Codex profile for this conversation",
        "",
        "## Project",
        "",
        "- `/project [list [options]|bind [options]|unbind <path>] [-h|--help]` show the current project or manage project bindings",
        "- `/git [args...]` run `git` directly in the current bound project",
        "- `/cat`, `/find`, `/head`, `/ls`, `/pwd`, `/rg`, `/sha256sum`, `/tail`, `/tree`, `/wc` run local project commands",
        "",
        "## Diagnostics",
        "",
        "- `/thread [--turns] [-h|--help]` show app-server thread metadata for the current bound session",
        "- `/feishu [ws|send|doctor] [-h|--help]` show Feishu websocket and outbound send diagnostics",
        "- `/log [-n <count>] [--since <expr>] [--grep <text>] [-h|--help]` show recent bridge service logs from systemd journal"
      ].join("\n");
    }

    const key = conversationKeyFor(message);
    const existing = await this.store.get(key);
    const activeRun = this.activeRuns.get(key);
    let sentEarlyUpdate = false;
    const sendEarlyUpdate = async (text: string): Promise<void> => {
      const target = onStatus || onUpdate;
      if (!target || sentEarlyUpdate) return;
      sentEarlyUpdate = true;
      await target(text);
    };

    if (command?.name === "status") {
      const statusArgs = new ArgCursor(command.args);
      if (statusArgs.peek() === "-h" || statusArgs.peek() === "--help") {
        return this.statusHelpText();
      }
      const checkUpdates = this.statusRequestsUpdateCheck(statusArgs);
      if (!statusArgs.isEmpty()) {
        return this.renderCommandError(
          "Status",
          `unsupported status argument \`${statusArgs.peek()}\``,
          "`/status [check-update] [-h|--help]`"
        );
      }
      await sendEarlyUpdate(
        checkUpdates
          ? "collecting status and checking npm registry for Codex and Feishu SDK updates..."
          : "collecting current Codex, bridge, and Feishu status..."
      );
      const project = existing?.project || this.config.project.defaultProject;
      const runtimeMeta = await getCodexRuntimeMeta(this.config.codex.home);
      const feishuSdkVersion = await this.readInstalledPackageVersion("@larksuiteoapi/node-sdk");
      const feishuSdkRange = await this.readDeclaredPackageRange("@larksuiteoapi/node-sdk");
      if (checkUpdates) {
        const updateStatus = await this.readStatusUpdates(runtimeMeta.version, feishuSdkVersion, feishuSdkRange);
        return [
          "# Bridge Status",
          "",
          "## Codex",
          "",
          `- **status**: ${this.formatUpdateStatusBadge(updateStatus.codex.status)}`,
          `- **package**: \`${updateStatus.codex.packageName}\``,
          `- **current**: \`${updateStatus.codex.current || "(unknown)"}\``,
          `- **latest**: \`${updateStatus.codex.latest || "(unavailable)"}\``,
          `- **note**: ${updateStatus.codex.detail}`,
          "",
          "## Feishu",
          "",
          `- **status**: ${this.formatUpdateStatusBadge(updateStatus.feishu.status)}`,
          `- **package**: \`${updateStatus.feishu.packageName}\``,
          ...(updateStatus.feishu.declared ? [`- **declared**: \`${updateStatus.feishu.declared}\``] : []),
          `- **installed**: \`${updateStatus.feishu.current || "(unknown)"}\``,
          `- **latest**: \`${updateStatus.feishu.latest || "(unavailable)"}\``,
          `- **note**: ${updateStatus.feishu.detail}`
        ].join("\n");
      }
      const sessionId = existing?.codexSessionId || "(none)";
      const session =
        existing?.codexSessionId
          ? await getSessionSummary(this.config.codex.sessionsDir, existing.codexSessionId)
          : undefined;
      const trustedProjects = await this.listTrustedProjects();
      const accountInfo =
        this.codex.readAccount
          ? await this.codex.readAccount(project).catch(() => undefined)
          : undefined;
      const account = asObjectRecord(accountInfo?.account);
      const rateLimits =
        this.codex.readAccountRateLimits
          ? await this.codex.readAccountRateLimits(project).catch(() => this.latestRateLimits)
          : this.latestRateLimits;
      const accountUpdate = this.latestAccountUpdate || {};
      const threadInfo =
        existing?.codexSessionId && this.codex.readThread
          ? await this.codex.readThread(existing.codexSessionId, project, false).catch(() => undefined)
          : undefined;
      const thread = isRecord(threadInfo?.thread) ? threadInfo.thread : undefined;
      const usage = existing?.codexSessionId ? this.latestTokenUsage.get(existing.codexSessionId) : undefined;
      const reroute = existing?.codexSessionId ? this.latestModelReroute.get(existing.codexSessionId) : undefined;
      const plan = existing?.codexSessionId ? this.latestPlan.get(existing.codexSessionId) : undefined;
      const agentsPath = path.join(project, "AGENTS.md");
      const hasAgents = await fs
        .stat(agentsPath)
        .then((stats) => stats.isFile())
        .catch(() => false);
      const effectiveModel =
        reroute?.toModel ||
        existing?.model ||
        this.readString(threadInfo?.model) ||
        this.readString(thread?.model) ||
        "(default)";
      const planType =
        this.readString(account.planType) || this.readString(accountUpdate.planType) || "(unknown)";
      const accountSummary = this.formatAccountSummary(account, planType);
      const feishuDiagnostics = this.feishu?.diagnostics();
      return [
        "# Bridge Status",
        "",
        "## Codex",
        "",
        ...(runtimeMeta.version ? [`- **codex**: \`${runtimeMeta.version}\``] : []),
        `- **model**: \`${effectiveModel}\`${reroute?.reason ? ` (${reroute.reason})` : ""}`,
        `- **directory**: \`${project}\``,
        `- **permissions**: \`${this.formatSandboxLabel(this.config.codex.sandboxMode)}\``,
        `- **agents.md**: \`${hasAgents ? agentsPath : "<none>"}\``,
        ...(accountSummary ? [`- **account**: ${accountSummary}`] : []),
        `- **session**: \`${sessionId}\``,
        ...(usage ? [this.formatContextWindowStatusLine(usage)] : []),
        ...(rateLimits ? this.formatRateLimitStatusLines(rateLimits) : []),
        "",
        "## Bridge",
        "",
        `- **conversation**: \`${key}\``,
        `- **backend**: \`${this.codex.mode}\``,
        `- **project trusted**: \`${trustedProjects.includes(project) ? "yes" : "no"}\``,
        `- **auth**: \`${runtimeMeta.authMode || "(unknown)"}\``,
        `- **search**: \`${existing?.searchEnabled ? "on" : "off"}\``,
        `- **profile**: \`${existing?.profile || "(default)"}\``,
        `- **run**: \`${activeRun ? `${activeRun.status}:${activeRun.runId}` : "idle"}\``,
        `- **session time**: ${this.formatAnyTimestamp(session?.createdAt)}`,
        `- **session cwd**: \`${session?.cwd || "(unknown)"}\``,
        `- **session about**: ${session?.preview || "(no preview)"}`,
        ...(thread
          ? [
              `- **thread name**: ${this.readString(thread.name) || "(none)"}`,
              `- **thread status**: \`${this.readString(thread.status) || "(unknown)"}\``,
              `- **thread source**: \`${this.readString(thread.source) || "(unknown)"}\``
            ]
          : []),
        ...(reroute
          ? [`- **model reroute**: \`${reroute.fromModel}\` -> \`${reroute.toModel}\`${reroute.reason ? ` (${reroute.reason})` : ""}`]
          : []),
        ...(plan?.plan.length
          ? [`- **plan**: ${plan.plan.map((step) => `${this.readString(step.status) || "pending"}:${this.readString(step.step) || "(step)"}`).join(" | ")}`]
          : []),
        "",
        "## Feishu",
        "",
        `- **sdk**: \`${feishuSdkVersion || "(unknown)"}\``,
        ...(feishuDiagnostics ? [`- **status**: ${this.formatFeishuDoctorVerdict(feishuDiagnostics)}`] : []),
        ...(feishuDiagnostics ? [`- **ws**: ${this.formatFeishuWsSummary(feishuDiagnostics)}`] : []),
        ...(feishuDiagnostics ? [`- **send**: ${this.formatFeishuSendSummary(feishuDiagnostics)}`] : [])
      ].join("\n");
    }

    if (command?.name === "thread") {
      if (command.args[0] === "-h" || command.args[0] === "--help") {
        return this.threadHelpText();
      }
      const project = existing?.project || this.config.project.defaultProject;
      const sessionId = existing?.codexSessionId;
      if (!sessionId) {
        return "# Thread\n\n- **error**: no session is currently bound.";
      }
      const includeTurns = command.args.includes("--turns");
      const threadInfo =
        this.codex.readThread
          ? await this.codex.readThread(sessionId, project, includeTurns).catch(() => undefined)
          : undefined;
      const thread = isRecord(threadInfo?.thread) ? threadInfo.thread : undefined;
      if (!thread) {
        return "# Thread\n\n- **error**: app-server thread details are unavailable for the current backend/session.";
      }
      const turns = Array.isArray(thread.turns)
        ? thread.turns.filter((item): item is Record<string, unknown> => isRecord(item))
        : [];
      const gitInfo = asObjectRecord(thread.gitInfo);
      return [
        "# Thread",
        "",
        `- **session**: \`${sessionId}\``,
        `- **thread id**: \`${this.readString(thread.id) || sessionId}\``,
        `- **name**: ${this.readString(thread.name) || "(none)"}`,
        `- **status**: \`${this.formatThreadStatus(thread.status)}\``,
        `- **source**: \`${this.formatSessionSource(thread.source)}\``,
        `- **cwd**: \`${this.readString(thread.cwd) || project}\``,
        `- **path**: \`${this.readString(thread.path) || "(none)"}\``,
        `- **preview**: ${this.readString(thread.preview) || "(none)"}`,
        `- **created**: ${this.formatUnixTimestamp(thread.createdAt)}`,
        `- **updated**: ${this.formatUnixTimestamp(thread.updatedAt)}`,
        `- **model provider**: \`${this.readString(thread.modelProvider) || "(unknown)"}\``,
        `- **ephemeral**: \`${thread.ephemeral ? "yes" : "no"}\``,
        ...(gitInfo.branch || gitInfo.sha || gitInfo.originUrl
          ? [
              `- **git**: branch=\`${this.readString(gitInfo.branch) || "(unknown)"}\` sha=\`${this.readString(gitInfo.sha) || "(unknown)"}\`${this.readString(gitInfo.originUrl) ? ` origin=${this.readString(gitInfo.originUrl)}` : ""}`
            ]
          : []),
        ...(includeTurns
          ? [
              `- **turn count**: \`${turns.length}\``,
              ...turns.slice(0, 10).map((turn, index) => {
                const items = Array.isArray(turn.items) ? turn.items.length : 0;
                return `- **turn ${index + 1}**: \`${this.readString(turn.id) || "(unknown)"}\` status=\`${this.formatThreadStatus(turn.status)}\` items=\`${items}\``;
              }),
              ...(turns.length > 10 ? [`- **more turns**: \`${turns.length - 10}\` not shown`] : [])
            ]
          : [`- **turns**: \`${turns.length || 0}\`${turns.length === 0 ? " (use `--turns` to fetch them)" : ""}`])
      ].join("\n");
    }

    if (command?.name === "compact") {
      if (command.args[0] === "-h" || command.args[0] === "--help") {
        return this.compactHelpText();
      }
      if (command.args.length > 0) {
        return "Usage: `/compact [-h|--help]`";
      }
      if (activeRun) {
        return `Cannot compact while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      if (!existing?.codexSessionId) {
        return "No session is currently bound. Use `/new`, `/resume`, or `/session list` first.";
      }
      if (!this.codex.compactSession) {
        return [
          "# Compact",
          "",
          `- **backend**: \`${this.codex.mode}\``,
          "- **status**: `unsupported`",
          "- Native session compaction is currently available only in `app-server` mode."
        ].join("\n");
      }
      const project = existing.project || this.config.project.defaultProject;
      await sendEarlyUpdate(`compacting Codex session \`${existing.codexSessionId}\`...`);
      const compactResult = await this.codex.compactSession(existing.codexSessionId, project);
      const nextBinding = { ...existing, updatedAt: new Date().toISOString() };
      await this.store.put(nextBinding);
      const summary = asObjectRecord(compactResult?.summary);
      return [
        "# Compact",
        "",
        `- **session**: \`${existing.codexSessionId}\``,
        `- **project**: \`${project}\``,
        `- **status**: \`${this.readString(compactResult?.status) || "completed"}\``,
        ...(this.readString(compactResult?.turnId)
          ? [`- **turn**: \`${this.readString(compactResult?.turnId)}\``]
          : []),
        ...(this.readString(summary.preview)
          ? [`- **summary**: ${this.readString(summary.preview)}`]
          : []),
        ...(this.readString(summary.updatedAt)
          ? [`- **updated**: ${this.formatAnyTimestamp(summary.updatedAt)}`]
          : []),
        ...(this.readString(summary.cwd)
          ? [`- **cwd**: \`${this.readString(summary.cwd)}\``]
          : [])
      ].join("\n");
    }

    if (command?.name === "summary") {
      if (command.args[0] === "-h" || command.args[0] === "--help") {
        return this.summaryHelpText();
      }
      if (command.args.length > 0) {
        return "Usage: `/summary [-h|--help]`";
      }
      if (!existing?.codexSessionId) {
        return "No session is currently bound. Use `/new`, `/resume`, or `/session list` first.";
      }
      if (!this.codex.getConversationSummary) {
        return "# Summary\n\n- **status**: `unsupported`\n- Native conversation summary is currently available only in `app-server` mode.";
      }
      const project = existing.project || this.config.project.defaultProject;
      await sendEarlyUpdate(`reading conversation summary for session \`${existing.codexSessionId}\`...`);
      const summaryResult = await this.codex.getConversationSummary(existing.codexSessionId, project);
      const summary = asObjectRecord(summaryResult?.summary);
      return [
        "# Summary",
        "",
        `- **session**: \`${existing.codexSessionId}\``,
        `- **project**: \`${project}\``,
        `- **conversation**: \`${this.readString(summary.conversationId) || existing.codexSessionId}\``,
        `- **source**: \`${this.formatSessionSource(summary.source)}\``,
        `- **updated**: ${this.formatAnyTimestamp(summary.updatedAt)}`,
        `- **cwd**: \`${this.readString(summary.cwd) || project}\``,
        `- **preview**: ${this.readString(summary.preview) || "(none)"}`,
        ...(this.readString(summary.path) ? [`- **path**: \`${this.readString(summary.path)}\``] : []),
        ...(this.readString(summary.cliVersion) ? [`- **cli**: \`${this.readString(summary.cliVersion)}\``] : [])
      ].join("\n");
    }

    if (command?.name === "diff") {
      if (command.args[0] === "-h" || command.args[0] === "--help") {
        return this.diffHelpText();
      }
      if (command.args.length > 0) {
        return "Usage: `/diff [-h|--help]`";
      }
      if (!existing?.codexSessionId) {
        return "No session is currently bound. Use `/new`, `/resume`, or `/session list` first.";
      }
      const latestDiff = this.latestTurnDiff.get(existing.codexSessionId);
      if (!latestDiff?.diff.trim()) {
        return "# Diff\n\n- **status**: `(no cached turn diff)`";
      }
      return [
        "# Diff",
        "",
        `- **session**: \`${existing.codexSessionId}\``,
        `- **turn**: \`${latestDiff.turnId}\``,
        "",
        "```diff",
        latestDiff.diff.trim(),
        "```"
      ].join("\n");
    }

    if (command?.name === "skills") {
      const skillArgs = new ArgCursor(command.args);
      if (skillArgs.peek() === "-h" || skillArgs.peek() === "--help") {
        return this.skillsHelpText();
      }
      const forceReload = skillArgs.takeFlag("--reload");
      if (!skillArgs.isEmpty()) {
        return "Usage: `/skills [--reload] [-h|--help]`";
      }
      if (!this.codex.listSkills) {
        return "# Skills\n\n- **status**: `unsupported`\n- Native skills listing is currently available only in `app-server` mode.";
      }
      const project = existing?.project || this.config.project.defaultProject;
      await sendEarlyUpdate(`reading Codex skills for project \`${project}\`${forceReload ? " with reload" : ""}...`);
      const skillResult = await this.codex.listSkills(project, { forceReload });
      const entries = Array.isArray(skillResult?.data)
        ? skillResult.data.filter((item): item is Record<string, unknown> => isRecord(item))
        : [];
      const skills = entries.flatMap((entry) => {
        const cwd = this.readString(entry.cwd) || project;
        const list = Array.isArray(entry.skills)
          ? entry.skills.filter((item): item is Record<string, unknown> => isRecord(item))
          : [];
        return list.map((skill) => ({ cwd, skill }));
      });
      if (skills.length === 0) {
        return "# Skills\n\n- **status**: `(no skills found)`";
      }
      const lines = [
        "# Skills",
        "",
        `- **project**: \`${project}\``,
        `- **count**: \`${skills.length}\``,
        "",
        "| # | name | scope | enabled | cwd | path | description |",
        "| --- | --- | --- | --- | --- | --- | --- |"
      ];
      for (const [index, item] of skills.entries()) {
        lines.push(
          `| ${index + 1} | ${escapeMarkdownCell(this.readString(item.skill.name) || "(unknown)")} | ${escapeMarkdownCell(this.readString(item.skill.scope) || "-")} | ${escapeMarkdownCell(item.skill.enabled ? "yes" : "no")} | ${escapeMarkdownCell(item.cwd)} | ${escapeMarkdownCell(this.readString(item.skill.path) || "-")} | ${escapeMarkdownCell(this.readString(item.skill.shortDescription) || this.readString(item.skill.description) || "-")} |`
        );
      }
      return lines.join("\n");
    }

    if (command?.name === "config") {
      const configArgs = new ArgCursor(command.args);
      if (configArgs.peek() === "-h" || configArgs.peek() === "--help") {
        return this.configHelpText();
      }
      const showCodexToml = configArgs.peek() === "codex-toml";
      if (showCodexToml) {
        configArgs.shift();
      }
      const includeLayers = configArgs.takeFlag("--layers");
      if (!configArgs.isEmpty()) {
        return "Usage: `/config [codex-toml] [--layers] [-h|--help]`";
      }
      const project = existing?.project || this.config.project.defaultProject;
      if (showCodexToml) {
        const configTomlPath = path.join(this.config.codex.home, "config.toml");
        await sendEarlyUpdate(`reading redacted Codex config from \`${configTomlPath}\`...`);
        const raw = await fs.readFile(configTomlPath, "utf8").catch(() => "");
        if (!raw) {
          return [
            "# Config",
            "",
            `- **path**: \`${configTomlPath}\``,
            "- **status**: `(not found)`"
          ].join("\n");
        }
        return [
          "# Config",
          "",
          `- **project**: \`${project}\``,
          `- **path**: \`${configTomlPath}\``,
          "- **mode**: `redacted raw toml`",
          "",
          "```toml",
          this.redactToml(raw),
          "```"
        ].join("\n");
      }
      if (!this.codex.readConfig) {
        return "# Config\n\n- **status**: `unsupported`\n- Native config read is currently available only in `app-server` mode.";
      }
      await sendEarlyUpdate(`reading Codex config for project \`${project}\`${includeLayers ? " with layers" : ""}...`);
      const configResult = await this.codex.readConfig(project, { includeLayers });
      const codexConfig = asObjectRecord(configResult?.config);
      const layers = Array.isArray(configResult?.layers)
        ? configResult.layers.filter((item): item is Record<string, unknown> => isRecord(item))
        : [];
      const lines = [
        "# Config",
        "",
        `- **project**: \`${project}\``,
        `- **model**: \`${this.readString(codexConfig.model) || "(default)"}\``,
        `- **profile**: \`${this.readString(codexConfig.profile) || "(default)"}\``,
        `- **model provider**: \`${this.readString(codexConfig.model_provider) || "(unknown)"}\``,
        `- **sandbox**: \`${this.readString(codexConfig.sandbox_mode) || "(unknown)"}\``,
        `- **approval policy**: \`${this.readString(codexConfig.approval_policy) || "(unknown)"}\``,
        `- **web search**: \`${this.readString(codexConfig.web_search) || "(unknown)"}\``,
        `- **reasoning effort**: \`${this.readString(codexConfig.model_reasoning_effort) || "(default)"}\``,
        `- **reasoning summary**: \`${this.readString(codexConfig.model_reasoning_summary) || "(default)"}\``,
        `- **verbosity**: \`${this.readString(codexConfig.model_verbosity) || "(default)"}\``,
        ...(includeLayers ? [
          "",
          "## Layers",
          "",
          ...layers.map((layer, index) => `- **layer ${index + 1}**: \`${this.readString(layer.name) || this.readString(layer.path) || "(unknown)"}\``)
        ] : [])
      ];
      return lines.join("\n");
    }

    if (command?.name === "feishu") {
      const feishuArgs = new ArgCursor(command.args);
      const feishuMode = feishuArgs.shift();
      if (feishuMode === "-h" || feishuMode === "--help") {
        return this.feishuHelpText();
      }
      const diagnostics = this.feishu?.diagnostics();
      if (!diagnostics) {
        return "# Feishu\n\n- **status**: `(gateway unavailable)`";
      }
      if (!feishuMode) {
        return this.renderFeishuSummary(diagnostics);
      }
      if (feishuMode === "ws") {
        if (!feishuArgs.isEmpty()) {
          return this.renderCommandError(
            "Feishu",
            `unsupported feishu ws argument \`${feishuArgs.peek()}\``,
            "`/feishu ws [-h|--help]`"
          );
        }
        return this.renderFeishuWs(diagnostics);
      }
      if (feishuMode === "send") {
        if (!feishuArgs.isEmpty()) {
          return this.renderCommandError(
            "Feishu",
            `unsupported feishu send argument \`${feishuArgs.peek()}\``,
            "`/feishu send [-h|--help]`"
          );
        }
        return this.renderFeishuSend(diagnostics);
      }
      if (feishuMode === "doctor") {
        if (!feishuArgs.isEmpty()) {
          return this.renderCommandError(
            "Feishu",
            `unsupported feishu doctor argument \`${feishuArgs.peek()}\``,
            "`/feishu doctor [-h|--help]`"
          );
        }
        return this.renderFeishuDoctor(diagnostics);
      }
      return this.renderCommandError(
        "Feishu",
        `unknown subcommand \`${feishuMode}\``,
        "`/feishu [ws|send|doctor] [-h|--help]`",
        ["- **choices**: `ws`, `send`, `doctor`"]
      );
    }

    const pendingApproval = this.pendingApprovals.get(key);
    if (pendingApproval) {
      if (!command) {
        return this.handleApprovalReply(key, pendingApproval, message.text);
      }
      if (!["help", "status", "stop"].includes(command.name)) {
        return [
          "# Approval Pending",
          "",
          `- **kind**: \`${pendingApproval.label}\``,
          "- Reply in chat with one of the requested answers, or use `/stop` to cancel the active run."
        ].join("\n");
      }
    }

    if (command?.name === "resume") {
      if (activeRun) {
        return `Cannot resume while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      const resumeArgs = new ArgCursor(command.args);
      let resumeProject = existing?.project || this.config.project.defaultProject;
      let projectExplicitlySelected = false;
      const cdProjectArg = resumeArgs.takeOption("-C", "--cd");
      if (cdProjectArg === "") {
        return this.renderCommandError(
          "Resume",
          "missing value for `-C|--cd <dir>`",
          "`/resume [<session-id>|--last|-n <index>|--list] [--all-projects] [--project <path>] [-C|--cd <dir>]`"
        );
      }
      if (cdProjectArg) {
        resumeProject = await this.resolveProject(
          cdProjectArg,
          existing?.project || this.config.project.defaultProject
        );
        projectExplicitlySelected = true;
      }

      const allProjects = resumeArgs.takeFlag("--all-projects");
      const projectScopeArg = resumeArgs.takeOption("--project");
      if (projectScopeArg === "") {
        return this.renderCommandError(
          "Resume",
          "missing value for `--project <path>`",
          "`/resume --list [--all-projects] [--project <path>]`"
        );
      }
      const wantsList = resumeArgs.peek() === "--list";
      if (projectScopeArg && !wantsList) {
        return this.renderCommandError(
          "Resume",
          "use `--project <path>` with `/resume --list`, or use `-C|--cd <dir>` to switch project while resuming",
          "`/resume --list [--project <path>]`"
        );
      }
      if (projectScopeArg) {
        const scopedProject = await this.resolveProject(projectScopeArg, resumeProject);
        if (projectExplicitlySelected && scopedProject !== resumeProject) {
          return this.renderCommandError(
            "Resume",
            "cannot use different project paths for `--project <path>` and `-C|--cd <dir>`",
            "`/resume --list [--project <path>]` or `/resume -C <dir>`"
          );
        }
        resumeProject = scopedProject;
        projectExplicitlySelected = true;
      }
      if (resumeArgs.peek() === "-h" || resumeArgs.peek() === "--help") {
        return this.resumeHelpText();
      }
      if (resumeArgs.peek() === "--last") {
        resumeArgs.shift();
      }
      if (allProjects && resumeArgs.peek() !== "--list") {
        return this.renderCommandError(
          "Resume",
          "use `--all-projects` with `/resume --list` to browse across projects, then resume by session id",
          "`/resume --list --all-projects`"
        );
      }
      if (resumeArgs.peek() === "--list") {
        resumeArgs.shift();
        if (!resumeArgs.isEmpty()) {
          return this.renderCommandError(
            "Resume",
            `unsupported resume list argument \`${resumeArgs.peek()}\``,
            "`/resume --list [--all-projects] [--project <path>]`"
          );
        }
        const sessions = await this.listSessionsForCommand(
          this.config.codex.sessionAllDefaultCount,
          resumeProject,
          {
            allProjects,
            allSources: this.codex.mode === "app-server"
          }
        );
        if (sessions.length === 0) {
          return this.noSessionsText(resumeProject, allProjects, projectExplicitlySelected);
        }
        return this.renderSessionList(
          projectExplicitlySelected
            ? "Resume Project Sessions"
            : allProjects
              ? "Resume All Projects"
              : "Resume Current Project",
          sessions,
          existing?.codexSessionId,
          resumeProject
        );
      }
      if ((resumeArgs.peek() || "").startsWith("-") && resumeArgs.peek() !== "-n") {
        return this.renderCommandError(
          "Resume",
          `unsupported bridge option \`${resumeArgs.peek()}\``,
          "`/resume [<session-id>|--last|-n <index>|--list] [--all-projects] [--project <path>] [-C|--cd <dir>]`",
          ["- **note**: Use a normal follow-up message after `/resume ...` if you want to continue the bound session."]
        );
      }

      let targetSessionId =
        resumeArgs.peek() ||
        (await this.findMostRecentSessionId(
          resumeProject,
          projectExplicitlySelected ? false : allProjects
        )) ||
        existing?.codexSessionId;
      let resumeSource = resumeArgs.peek() ? "explicit" : "latest";
      let resumeWarning: string | undefined;
      let resumeIndex: number | undefined;

      if (resumeArgs.peek() === "-n") {
        resumeArgs.shift();
        const rawIndex = resumeArgs.shift();
        if (!resumeArgs.isEmpty()) {
          return this.renderCommandError(
            "Resume",
            `unsupported resume argument \`${resumeArgs.peek()}\``,
            "`/resume -n <index>`"
          );
        }
        const index = Number(rawIndex || "");
        if (!Number.isInteger(index) || index < 1) {
          return this.renderCommandError(
            "Resume",
            "invalid resume index",
            "`/resume -n <index>`"
          );
        }
        const sessions = this.sortSessionEntries(
          await this.listSessionsForCommand(
            Math.min(index, this.config.codex.sessionAllDefaultCount),
            resumeProject,
            {
              allProjects,
              allSources: this.codex.mode === "app-server"
            }
          ),
          resumeProject
        );
        const selected = sessions[index - 1];
        if (!selected) {
          return this.renderCommandError(
            "Resume",
            `session index out of range: ${index}`,
            `\`/session list${allProjects ? " --all-projects" : ""}${projectExplicitlySelected ? ` --project ${resumeProject}` : ""} --all\``
          );
        }
        targetSessionId = selected.sessionId;
        resumeSource = "indexed";
        resumeIndex = index;
        resumeWarning =
          "Index-based resume depends on the current recent-session ordering and may change as new sessions are created.";
      }

      if (!targetSessionId) {
        return this.noSessionsText(resumeProject, allProjects, projectExplicitlySelected);
      }
      let resolvedProject = resumeProject;
      const session = await getSessionSummary(this.config.codex.sessionsDir, targetSessionId);
      if (
        !projectExplicitlySelected &&
        resumeSource === "explicit" &&
        session?.cwd
      ) {
        resolvedProject = await this.resolveProject(
          session.cwd,
          existing?.project || this.config.project.defaultProject
        );
      }
      await sendEarlyUpdate(`resolving session ${targetSessionId} for project \`${resolvedProject}\`...`);
      const sessionExists = await this.codex.getSession(targetSessionId);
      if (!sessionExists) {
        return this.renderCommandError(
          "Resume",
          `session not found: ${targetSessionId}`
        );
      }
      const binding = this.makeBinding(
        key,
        targetSessionId,
        resolvedProject,
        existing
      );
      await this.store.put(binding);
      return [
        "# Resume Session",
        "",
        `- **source**: \`${resumeSource}\``,
        ...(resumeIndex ? [`- **index**: \`${resumeIndex}\``] : []),
        `- **session**: \`${binding.codexSessionId}\``,
        `- **project**: \`${binding.project}\``,
        `- **time**: ${this.formatAnyTimestamp(session?.createdAt)}`,
        `- **cwd**: \`${session?.cwd || "(unknown)"}\``,
        `- **about**: ${session?.preview || "(no preview)"}`,
        ...(resumeWarning ? [`- **warning**: ${resumeWarning}`] : [])
      ].join("\n");
    }

    if (command?.name === "fork") {
      if (activeRun) {
        return `Cannot fork while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      if (this.codex.mode !== "app-server" || !this.codex.forkSession) {
        return [
          "# Fork",
          "",
          "- Native session forking is currently available only in `app-server` mode."
        ].join("\n");
      }
      const forkArgs = new ArgCursor(command.args);
      const allProjects = forkArgs.takeFlag("--all-projects");
      const currentProject = existing?.project || this.config.project.defaultProject;
      let forkProject = currentProject;
      let projectExplicitlySelected = false;
      const projectScopeArg = forkArgs.takeOption("--project");
      if (projectScopeArg === "") {
        return this.renderCommandError(
          "Fork",
          "missing value for `--project <path>`",
          "`/fork [<session-id>|--last|-n <index>|--list] [--all-projects] [--project <path>]`"
        );
      }
      if (projectScopeArg) {
        forkProject = await this.resolveProject(projectScopeArg, currentProject);
        projectExplicitlySelected = true;
      }
      if (forkArgs.peek() === "-h" || forkArgs.peek() === "--help") {
        return this.forkHelpText();
      }
      if (forkArgs.peek() === "--last") {
        forkArgs.shift();
      }
      if (forkArgs.peek() === "--list") {
        forkArgs.shift();
        if (!forkArgs.isEmpty()) {
          return this.renderCommandError(
            "Fork",
            `unsupported fork list argument \`${forkArgs.peek()}\``,
            "`/fork --list [--all-projects] [--project <path>]`"
          );
        }
        const sessions = await this.listSessionsForCommand(
          this.config.codex.sessionAllDefaultCount,
          forkProject,
          {
            allProjects,
            allSources: this.codex.mode === "app-server"
          }
        );
        if (sessions.length === 0) {
          return this.noSessionsText(forkProject, allProjects, projectExplicitlySelected);
        }
        return this.renderSessionList(
          projectExplicitlySelected
            ? "Fork Project Sessions"
            : allProjects
              ? "Fork All Projects"
              : "Fork Current Project",
          sessions,
          existing?.codexSessionId,
          forkProject
        );
      }
      if ((forkArgs.peek() || "").startsWith("-") && forkArgs.peek() !== "-n") {
        return this.renderCommandError(
          "Fork",
          `unsupported bridge option \`${forkArgs.peek()}\``,
          "`/fork [<session-id>|--last|-n <index>|--list] [--all-projects] [--project <path>]`"
        );
      }

      let targetSessionId =
        forkArgs.peek() ||
        existing?.codexSessionId ||
        (await this.findMostRecentSessionId(
          forkProject,
          projectExplicitlySelected ? false : allProjects
        ));
      let forkSource = forkArgs.peek() ? "explicit" : existing?.codexSessionId ? "current" : "latest";
      let forkWarning: string | undefined;
      let forkIndex: number | undefined;

      if (forkArgs.peek() === "-n") {
        forkArgs.shift();
        const rawIndex = forkArgs.shift();
        if (!forkArgs.isEmpty()) {
          return this.renderCommandError(
            "Fork",
            `unsupported fork argument \`${forkArgs.peek()}\``,
            "`/fork -n <index>`"
          );
        }
        const index = Number(rawIndex || "");
        if (!Number.isInteger(index) || index < 1) {
          return this.renderCommandError(
            "Fork",
            "invalid fork index",
            "`/fork -n <index>`"
          );
        }
        const sessions = this.sortSessionEntries(
          await this.listSessionsForCommand(
            Math.min(index, this.config.codex.sessionAllDefaultCount),
            forkProject,
            { allProjects, allSources: this.codex.mode === "app-server" }
          ),
          forkProject
        );
        const selected = sessions[index - 1];
        if (!selected) {
          return this.renderCommandError(
            "Fork",
            `session index out of range: ${index}`,
            `\`/session list${allProjects ? " --all-projects" : ""}${projectExplicitlySelected ? ` --project ${forkProject}` : ""} --all\``
          );
        }
        targetSessionId = selected.sessionId;
        forkSource = "indexed";
        forkIndex = index;
        forkWarning =
          "Index-based fork depends on the current recent-session ordering and may change as new sessions are created.";
      }

      if (!targetSessionId) {
        return this.renderCommandError(
          "Fork",
          "no session is currently bound",
          "`/new`, `/resume`, or `/session list`"
        );
      }
      await sendEarlyUpdate(`forking session \`${targetSessionId}\` for project \`${forkProject}\`...`);
      const sessionExists = await this.codex.getSession(targetSessionId);
      if (!sessionExists) {
        return this.renderCommandError(
          "Fork",
          `session not found: ${targetSessionId}`
        );
      }
      const forkResult = await this.codex.forkSession(targetSessionId, forkProject, this.resolveTurnOptions(existing));
      const forkedThread = isRecord(forkResult?.thread) ? forkResult.thread : undefined;
      const forkedSessionId = this.readString(forkedThread?.id);
      if (!forkedSessionId) {
        return this.renderCommandError(
          "Fork",
          "fork failed: Codex returned no forked session id"
        );
      }
      const binding = this.makeBinding(key, forkedSessionId, forkProject, existing);
      await this.store.put(binding);
      return [
        "# Fork Session",
        "",
        `- **source**: \`${forkSource}\``,
        ...(forkIndex ? [`- **index**: \`${forkIndex}\``] : []),
        `- **from**: \`${targetSessionId}\``,
        `- **session**: \`${forkedSessionId}\``,
        `- **project**: \`${binding.project}\``,
        ...(this.readString(forkedThread?.preview) ? [`- **about**: ${this.readString(forkedThread?.preview)}`] : []),
        ...(forkWarning ? [`- **warning**: ${forkWarning}`] : [])
      ].join("\n");
    }

    if (command?.name === "session") {
      const sessionArgs = new ArgCursor(command.args);
      const allProjects = sessionArgs.takeFlag("--all-projects");
      const currentProject = existing?.project || this.config.project.defaultProject;
      const projectScopeArg = sessionArgs.takeOption("--project");
      if (projectScopeArg === "") {
        return this.renderCommandError(
          "Session",
          "missing value for `--project <path>`",
          "`/session [list [options]] [-h|--help]`"
        );
      }
      if (sessionArgs.peek() === "-h" || sessionArgs.peek() === "--help") {
        return this.sessionsHelpText();
      }
      const remainingSessionArgs = sessionArgs.remaining();
      const isLegacyNumericList = remainingSessionArgs.length === 1 && /^\d+$/.test(remainingSessionArgs[0] || "");
      const isList = sessionArgs.peek() === "list" || isLegacyNumericList;
      if (isList) {
        const listArgs = new ArgCursor(isLegacyNumericList ? remainingSessionArgs : remainingSessionArgs.slice(1));
        const interactiveOnly = listArgs.takeFlag("--interactive-only");
        const nonInteractiveOnly = listArgs.takeFlag("--non-interactive-only");
        const allSources = listArgs.takeFlag("--all-sources");
        const sourceKind = listArgs.takeOption("--source");
        if (sourceKind === "") {
          return this.renderCommandError(
            "Session",
            "missing value for `--source <source>`",
            "`/session list [--all|-n <count>] [--all-projects] [--project <path>] [--interactive-only|--non-interactive-only|--all-sources|--source <source>]`"
          );
        }
        const sourceFilters = [interactiveOnly, nonInteractiveOnly, allSources, Boolean(sourceKind)].filter(Boolean).length;
        if (sourceFilters > 1) {
          return this.renderCommandError(
            "Session",
            "use only one of `--interactive-only`, `--non-interactive-only`, `--all-sources`, or `--source <source>`",
            "`/session list [--all|-n <count>] [--all-projects] [--project <path>] [--interactive-only|--non-interactive-only|--all-sources|--source <source>]`"
          );
        }
        if (sourceKind && !SESSION_SOURCE_KINDS.includes(sourceKind as typeof SESSION_SOURCE_KINDS[number])) {
          return this.renderCommandError(
            "Session",
            `unknown source \`${sourceKind}\``,
            "`/session list [--source <source>]`",
            [`- **available**: ${SESSION_SOURCE_KINDS.map((item) => `\`${item}\``).join(", ")}`]
          );
        }
        const limit = this.parseSessionsListLimit(listArgs);
        if (limit === undefined) {
          return this.renderCommandError(
            "Session",
            "invalid session list count",
            "`/session list [--all|-n <count>] [--all-projects] [--project <path>] [--interactive-only|--non-interactive-only|--all-sources|--source <source>]`"
          );
        }
        const leftoverListArgs = listArgs.remaining();
        if (leftoverListArgs.length > 0) {
          return leftoverListArgs[0].startsWith("/")
            ? this.renderCommandError(
                "Session",
                "use `--project <path>` to filter sessions by project path",
                "`/session list --project <path> [--all|-n <count>] [--interactive-only|--non-interactive-only|--all-sources|--source <source>]`"
              )
            : this.renderCommandError(
                "Session",
                `unsupported session list argument \`${leftoverListArgs[0]}\``,
                "`/session list [--all|-n <count>] [--all-projects] [--project <path>] [--interactive-only|--non-interactive-only|--all-sources|--source <source>]`"
              );
        }
        const scopedProject = projectScopeArg
          ? await this.resolveProject(projectScopeArg, currentProject)
          : currentProject;
        const sessions = await this.listSessionsForCommand(limit, scopedProject, {
          allProjects,
          allSources: this.codex.mode === "app-server" ? allSources || (!interactiveOnly && !nonInteractiveOnly && !sourceKind) : true,
          nonInteractiveOnly,
          sourceKinds: sourceKind ? [sourceKind] : undefined
        });
        if (sessions.length === 0) {
          return this.noSessionsText(scopedProject, allProjects, Boolean(projectScopeArg));
        }
        return this.renderSessionList(
          projectScopeArg
            ? "Project Sessions"
            : allProjects
              ? "All Project Sessions"
              : "Current Project Sessions",
          sessions,
          existing?.codexSessionId,
          scopedProject
        );
      }

      if (!sessionArgs.isEmpty()) {
        return this.renderCommandError(
          "Session",
          `unsupported session subcommand \`${sessionArgs.peek()}\``,
          "`/session [list [options]] [-h|--help]`"
        );
      }

      if (!existing?.codexSessionId) {
        return "No session is currently bound. Use `/new`, `/resume`, or `/session list`.";
      }
      const session = await getSessionSummary(this.config.codex.sessionsDir, existing.codexSessionId);
      const project = existing.project || this.config.project.defaultProject;
      const threadInfo =
        this.codex.readThread
          ? await this.codex.readThread(existing.codexSessionId, project, false).catch(() => undefined)
          : undefined;
      const thread = isRecord(threadInfo?.thread) ? threadInfo.thread : undefined;
      const reroute = this.latestModelReroute.get(existing.codexSessionId);
      const effectiveModel =
        reroute?.toModel ||
        existing.model ||
        this.readString(threadInfo?.model) ||
        this.readString(thread?.model);
      const effectiveSource = this.formatThreadSource(threadInfo?.source ?? thread?.source);
      return [
        "# Current Session",
        "",
        `- **session**: \`${existing.codexSessionId}\``,
        `- **project**: \`${project}\``,
        ...(effectiveSource ? [`- **source**: \`${effectiveSource}\``] : []),
        ...(effectiveModel ? [`- **model**: \`${effectiveModel}\`${reroute?.reason ? ` (${reroute.reason})` : ""}`] : []),
        `- **time**: ${this.formatAnyTimestamp(session?.createdAt)}`,
        `- **cwd**: \`${session?.cwd || "(unknown)"}\``,
        `- **about**: ${session?.preview || "(no preview)"}`
      ].join("\n");
    }

    const binding = existing;
    if (command?.name === "new") {
      const newArgs = new ArgCursor(command.args);
      if (newArgs.peek() === "-h" || newArgs.peek() === "--help") {
        return this.newHelpText();
      }
      if (activeRun) {
        return `Cannot create a new session while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      let project = binding?.project || this.config.project.defaultProject;
      const newProjectArg = newArgs.takeOption("-C", "--cd");
      if (newProjectArg === "") {
          return "Usage: `/new [-C|--cd <dir>]`";
      }
      if (newProjectArg) {
        project = await this.resolveProject(newProjectArg, project);
      }
      if (!newArgs.isEmpty()) {
        return "Usage: `/new [-C|--cd <dir>]`";
      }
      await sendEarlyUpdate(`creating a new Codex session for project \`${project}\`...`);
      const sessionId = await this.codex.createSession(project, this.resolveTurnOptions(binding));
      const nextBinding = this.makeBinding(key, sessionId, project, binding);
      await this.store.put(nextBinding);
      return [
        "# New Session",
        "",
        `- **session**: \`${sessionId}\``,
        `- **project**: \`${nextBinding.project}\``,
        `- **search**: \`${nextBinding.searchEnabled ? "on" : "off"}\``,
        `- **model**: \`${nextBinding.model || "(default)"}\``,
        `- **profile**: \`${nextBinding.profile || "(default)"}\``
      ].join("\n");
    }

    if (command?.name === "stop") {
      if (command.args[0] === "-h" || command.args[0] === "--help") {
        return this.stopHelpText();
      }
      if (!activeRun) {
        return "No active run for this conversation.";
      }
      this.cancelPendingApproval(key, "cancelled by /stop");
      await sendEarlyUpdate(`stopping run \`${activeRun.runId}\`...`);
      this.activeRuns.set(key, { ...activeRun, status: "stopping" });
      const stopped = await this.codex.stop(activeRun.runId);
      return stopped
        ? `# Stop Run\n\n- **run**: \`${activeRun.runId}\`\n- **status**: \`stop requested\``
        : "Run already finished before stop completed.";
    }

    if (command?.name === "project") {
      const projectArgs = new ArgCursor(command.args);
      const currentProject = binding?.project || this.config.project.defaultProject;
      const trustedProjects = await this.listTrustedProjects();
      if (projectArgs.peek() === "-h" || projectArgs.peek() === "--help") {
        return this.projectHelpText();
      }
      if (projectArgs.isEmpty()) {
        return [
          "# Project",
          "",
          `- **project**: \`${currentProject}\``,
          `- **trusted**: \`${trustedProjects.includes(currentProject) ? "yes" : "no"}\``,
          `- **allowed roots**: ${this.config.project.allowedRoots.map((root) => `\`${root}\``).join(", ")}`
        ].join("\n");
      }

      const projectSubcommand = projectArgs.shift();

      if (projectSubcommand === "list") {
        const listArgs = new ArgCursor(projectArgs.remaining());
        const mode = listArgs.takeFlag("--trusted")
          ? "trusted"
          : listArgs.takeFlag("--all")
            ? "all"
            : "default";
        if (!listArgs.isEmpty()) {
          return this.renderCommandError(
            "Project",
            `unsupported project list argument \`${listArgs.peek()}\``,
            "`/project list [--all|--trusted]`"
          );
        }
        const projects = await this.listProjects(mode, currentProject, trustedProjects);
        if (projects.length === 0) {
          return "# Projects\n\n- No projects found.";
        }
        return this.renderProjectList("Projects", projects, currentProject);
      }

      if (projectSubcommand === "unbind") {
        if (activeRun) {
          return `Cannot change project while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
        }
        const requested = projectArgs.remainingText();
        if (!requested) {
          return this.renderCommandError(
            "Project",
            "missing project path for `unbind`",
            "`/project unbind <path>`"
          );
        }
        const project = await this.resolveProject(requested, currentProject, false, false);
        if (project === currentProject) {
          return [
            "# Project",
            "",
            `- **error**: refusing to unbind the current conversation project \`${project}\``,
            "- Bind this conversation to another project first if you want to remove stored bindings for this project."
          ].join("\n");
        }
        await sendEarlyUpdate(`removing stored bindings for project \`${project}\`...`);
        const removed = await this.store.deleteProject(project);
        return [
          "# Project",
          "",
          `- **project**: \`${project}\``,
          `- **removed bindings**: \`${removed}\``
        ].join("\n");
      }

      if (projectSubcommand !== "bind") {
        return this.renderCommandError(
          "Project",
          `unsupported project subcommand \`${projectSubcommand}\``,
          "`/project [list [options]|bind [options]|unbind <path>] [-h|--help]`"
        );
      }
      if (activeRun) {
        return `Cannot change project while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }

      const bindArgs = new ArgCursor(projectArgs.remaining());
      const createMissing = bindArgs.takeFlag("-m", "--mkdir");

      let project: string | undefined;
      let bindWarning: string | undefined;
      if (bindArgs.peek() === "-n") {
        bindArgs.shift();
        const rawIndex = bindArgs.shift();
        if (!bindArgs.isEmpty()) {
          return this.renderCommandError(
            "Project",
            `unsupported project bind argument \`${bindArgs.peek()}\``,
            "`/project bind -n <index>`"
          );
        }
        const index = Number(rawIndex || "");
        if (!Number.isInteger(index) || index < 1) {
          return "Usage: `/project bind -n <index>` where `<index>` is an integer >= 1.";
        }
        const projects = await this.listProjects("default", currentProject, trustedProjects);
        const selected = projects[index - 1];
        if (!selected) {
          return `project index out of range: ${index}. Use \`/project list\` first.`;
        }
        project = selected.project;
        bindWarning =
          "Index-based bind uses the current `/project list` ordering and may change as projects are added or updated.";
      } else {
        const requested = bindArgs.remainingText();
        if (!requested) {
          return this.renderCommandError(
            "Project",
            "missing project path for `bind`",
            "`/project bind <path>`"
          );
        }
        project = await this.resolveProject(requested, currentProject, createMissing);
      }

      const nextBinding = binding
        ? { ...binding, project, updatedAt: new Date().toISOString() }
        : this.makeBinding(key, undefined, project);
      await sendEarlyUpdate(`binding project \`${project}\`...`);
      await this.store.put(nextBinding);
      return [
        "# Project",
        "",
        `- **project**: \`${project}\``,
        `- **trusted**: \`${trustedProjects.includes(project) ? "yes" : "no"}\``,
        ...(bindWarning ? [`- **warning**: ${bindWarning}`] : [])
      ].join("\n");
    }

    if (command?.name === "log") {
      const logArgs = new ArgCursor(command.args);
      if (logArgs.peek() === "-h" || logArgs.peek() === "--help") {
        return this.logHelpText();
      }
      const query = this.parseLogQuery(logArgs.remaining());
      if (query instanceof Error) {
        return this.renderCommandError(
          "Log",
          query.message,
          "`/log [-n <count>] [--since <expr>] [--grep <text>] [-h|--help]`"
        );
      }
      const filters = [
        `last ${query.limit} lines`,
        ...(query.since ? [`since \`${query.since}\``] : []),
        ...(query.grep ? [`grep \`${query.grep}\``] : [])
      ];
      await sendEarlyUpdate(`reading ${filters.join(", ")} for \`codex-feishu-bridge.service\`...`);
      return this.readBridgeLogs(query);
    }

    if (command?.name === "git") {
      const project = binding?.project || this.config.project.defaultProject;
      await sendEarlyUpdate(`running git in project \`${project}\`...`);
      return this.runGitCommand(project, command.args);
    }

    if (
      command?.name === "cat" ||
      command?.name === "find" ||
      command?.name === "head" ||
      command?.name === "ls" ||
      command?.name === "pwd" ||
      command?.name === "rg" ||
      command?.name === "sha256sum" ||
      command?.name === "tail" ||
      command?.name === "tree" ||
      command?.name === "wc"
    ) {
      const localCommandName = command.name;
      const project = binding?.project || this.config.project.defaultProject;
      await sendEarlyUpdate(`running ${localCommandName} in project \`${project}\`...`);
      return this.runLocalCommand(localCommandName, project, command.args);
    }

    if (command?.name === "approvals") {
      const approvalArgs = new ArgCursor(command.args);
      if (approvalArgs.peek() === "-h" || approvalArgs.peek() === "--help") {
        return this.approvalsHelpText();
      }
      if (approvalArgs.isEmpty()) {
        return [
          "# Approvals",
          "",
          `- **mode**: \`${this.config.codex.sandboxMode}\``,
          `- **choices**: ${this.approvalChoicesText()}`
        ].join("\n");
      }
      if (activeRun) {
        return `Cannot change approvals while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      const nextMode = this.parseApprovalMode(approvalArgs.remainingText());
      if (!nextMode) {
        return this.renderCommandError(
          "Approvals",
          `unknown mode \`${approvalArgs.remainingText()}\``,
          "`/approvals [mode] [-h|--help]`",
          [`- **choices**: ${this.approvalChoicesText()}`]
        );
      }
      await sendEarlyUpdate(`switching approvals to \`${nextMode}\`...`);
      this.config.codex.sandboxMode = nextMode;
      await this.persistJsonSetting(["codex", "sandboxMode"], nextMode);
      return [
        "# Approvals",
        "",
        `- **mode**: \`${nextMode}\``,
        `- ${this.describeApprovalMode(nextMode)}`
      ].join("\n");
    }

    if (command?.name === "search") {
      const searchArgs = new ArgCursor(command.args);
      if (searchArgs.peek() === "-h" || searchArgs.peek() === "--help") {
        return this.searchHelpText();
      }
      const enabled = binding?.searchEnabled ?? this.config.project.defaultSearchEnabled;
      if (searchArgs.isEmpty()) {
        return `# Search\n\n- **mode**: \`${enabled ? "on" : "off"}\``;
      }
      if (activeRun) {
        return `Cannot change search while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      const normalized = searchArgs.shift()?.toLowerCase();
      if (!["on", "off"].includes(normalized || "") || !searchArgs.isEmpty()) {
        return this.renderCommandError(
          "Search",
          "invalid search mode",
          "`/search [on|off]`"
        );
      }
      const nextBinding = binding
        ? { ...binding, searchEnabled: normalized === "on", updatedAt: new Date().toISOString() }
        : this.makeBinding(
            key,
            undefined,
            this.config.project.defaultProject,
            { searchEnabled: normalized === "on" }
          );
      await sendEarlyUpdate(`switching search ${normalized}...`);
      await this.store.put(nextBinding);
      return `# Search\n\n- **mode**: \`${nextBinding.searchEnabled ? "on" : "off"}\``;
    }

    if (command?.name === "model") {
      const modelArgs = new ArgCursor(command.args);
      if (modelArgs.peek() === "-h" || modelArgs.peek() === "--help") {
        return this.modelHelpText();
      }
      if (modelArgs.peek() === "--list" || modelArgs.peek() === "list") {
        const project = binding?.project || this.config.project.defaultProject;
        const liveModels = this.codex.listModels
          ? await this.codex.listModels(project, { includeHidden: false, limit: 100 }).catch(() => undefined)
          : undefined;
        return this.modelListText(liveModels);
      }
      const current = binding?.model || "(default)";
      if (modelArgs.isEmpty()) {
        return `# Model\n\n- **model**: \`${current}\``;
      }
      if (activeRun) {
        return `Cannot change model while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      const nextValue = modelArgs.remainingText();
      const nextBinding = binding
        ? {
            ...binding,
            model: ["clear", "default", "reset"].includes(nextValue.toLowerCase()) ? undefined : nextValue,
            updatedAt: new Date().toISOString()
          }
        : this.makeBinding(
            key,
            undefined,
            this.config.project.defaultProject,
            {
              model: ["clear", "default", "reset"].includes(nextValue.toLowerCase()) ? undefined : nextValue
            }
          );
      await sendEarlyUpdate(
        `switching model to \`${nextBinding.model || "(default)"}\`...`
      );
      await this.store.put(nextBinding);
      return `# Model\n\n- **model**: \`${nextBinding.model || "(default)"}\``;
    }

    if (command?.name === "profile") {
      const profileArgs = new ArgCursor(command.args);
      if (profileArgs.peek() === "-h" || profileArgs.peek() === "--help") {
        return this.profileHelpText();
      }
      const current = binding?.profile || "(default)";
      if (profileArgs.isEmpty()) {
        return `# Profile\n\n- **profile**: \`${current}\``;
      }
      if (activeRun) {
        return `Cannot change profile while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      const nextValue = profileArgs.remainingText();
      const nextBinding = binding
        ? {
            ...binding,
            profile: ["clear", "default", "reset"].includes(nextValue.toLowerCase()) ? undefined : nextValue,
            updatedAt: new Date().toISOString()
          }
        : this.makeBinding(
            key,
            undefined,
            this.config.project.defaultProject,
            {
              profile: ["clear", "default", "reset"].includes(nextValue.toLowerCase()) ? undefined : nextValue
            }
          );
      await sendEarlyUpdate(
        `switching profile to \`${nextBinding.profile || "(default)"}\`...`
      );
      await this.store.put(nextBinding);
      return `# Profile\n\n- **profile**: \`${nextBinding.profile || "(default)"}\``;
    }

    if (activeRun) {
      return [
        "# Active Run",
        "",
        `- **run**: \`${activeRun.runId}\``,
        `- **status**: \`${activeRun.status}\``
      ].join("\n");
    }

    const project = binding?.project || this.config.project.defaultProject;
    await sendEarlyUpdate("handing off to Codex...");
    const provisionalRunId = `pending:${randomUUID()}`;
    this.activeRuns.set(key, {
      conversationKey: key,
      codexSessionId: binding?.codexSessionId || "(pending)",
      runId: provisionalRunId,
      startedAt: new Date().toISOString(),
      status: "starting"
    });

    try {
      const handle = await this.codex.runTurn(
        message,
        binding?.codexSessionId,
        project,
        this.resolveTurnOptions(binding),
        {
          onStatus: onStatus || onUpdate,
          onUpdate,
          onNotification: async (notification) => {
            this.recordCodexNotification(key, notification);
            const maybeUpdate = this.config.codex.appServerSidebandCards
              ? this.renderCodexNotificationUpdate(notification)
              : undefined;
            if (maybeUpdate) {
              if (onStatus) {
                await onStatus(maybeUpdate);
              } else if (onUpdate) {
                await onUpdate(maybeUpdate);
              }
            }
          },
          onServerRequest: async (request) => {
            const maybeUpdate = this.config.codex.appServerSidebandCards
              ? this.renderCodexServerRequestUpdate(request, project)
              : undefined;
            if (maybeUpdate) {
              if (onStatus) {
                await onStatus(maybeUpdate);
              } else if (onUpdate) {
                await onUpdate(maybeUpdate);
              }
            }
            return this.requestApprovalFromFeishu(
              key,
              message,
              project,
              request,
              onStatus || onUpdate
            );
          }
        }
      );
      this.activeRuns.set(key, {
        conversationKey: key,
        codexSessionId: binding?.codexSessionId || "(pending)",
        runId: handle.runId,
        startedAt: new Date().toISOString(),
        status: "running"
      });
      const result = await handle.done;

      const nextBinding =
        binding && binding.codexSessionId === result.sessionId
          ? { ...binding, updatedAt: new Date().toISOString() }
          : this.makeBinding(key, result.sessionId, project, binding);
      await this.store.put(nextBinding);
      return this.codex.mode === "terminal" && onUpdate ? "" : result.output;
    } finally {
      this.cancelPendingApproval(key, "run finished");
      this.activeRuns.delete(key);
    }
  }

  private async sendStartupReadyNotification(title: string, logLabel: string): Promise<void> {
    if (!this.config.feishu.startupNotifyChatId) return;
    try {
      const binding = await this.store.get(`p2p:${this.config.feishu.startupNotifyChatId}`);
      await this.feishu?.sendStartupReady(
        this.buildStartupReadyMessage(title, binding?.project),
        this.buildIsoFooter(),
        title
      );
      console.log(logLabel, {
        chatId: this.config.feishu.startupNotifyChatId,
        currentProject: binding?.project
      });
    } catch (error) {
      console.error(`failed to send ${title.toLowerCase()} notification`, error);
    }
  }

  private buildStartupReadyMessage(title = "Bridge Ready", currentProject?: string): string {
    const feishuDiagnostics = this.feishu?.diagnostics();
    return [
      `- **backend**: \`${this.codex.mode}\``,
      `- **profile**: \`${this.config.codex.profileMode}\``,
      `- **default project**: \`${this.config.project.defaultProject}\``,
      ...(currentProject ? [`- **current project**: \`${currentProject}\``] : []),
      `- **sandbox**: \`${this.config.codex.sandboxMode}\``,
      `- **search default**: \`${this.config.project.defaultSearchEnabled ? "on" : "off"}\``,
      ...(feishuDiagnostics ? [`- **feishu**: ${this.formatFeishuStatusSummary(feishuDiagnostics)}`] : [])
    ].join("\n");
  }

  private titleForCommand(commandName?: string, rawInput?: string): string {
    if (!commandName) {
      return this.composeTitle("Codex", "🤖", rawInput || "reply");
    }
    const base = this.commandBaseTitle(commandName);
    const emoji = this.commandTitleEmoji(commandName);
    return this.composeTitle(base, emoji, rawInput || `/${commandName}`);
  }

  private composeTitle(base: string, emoji: string | undefined, detail: string): string {
    const maxLength = this.config.feishu.titleMaxLength;
    const prefix = `${base} | ${emoji ? `${emoji} ` : ""}`;
    if (prefix.length >= maxLength) {
      return this.shortenTitleInput(`${prefix}${detail}`, maxLength);
    }
    return `${prefix}${this.shortenTitleInput(detail, maxLength - prefix.length)}`;
  }

  private commandBaseTitle(commandName: string): string {
    switch (commandName) {
      case "help":
        return "Help";
      case "status":
        return "Status";
      case "thread":
        return "Thread";
      case "compact":
        return "Compact";
      case "summary":
        return "Summary";
      case "diff":
        return "Diff";
      case "skills":
        return "Skills";
      case "config":
        return "Config";
      case "new":
        return "New Session";
      case "fork":
        return "Fork";
      case "session":
        return "Session";
      case "resume":
        return "Resume Session";
      case "stop":
        return "Stop";
      case "project":
        return "Project";
      case "log":
        return "Log";
      case "git":
        return "Git";
      case "feishu":
        return "Feishu";
      case "pwd":
        return "PWD";
      case "ls":
        return "LS";
      case "cat":
        return "Cat";
      case "tree":
        return "Tree";
      case "find":
        return "Find";
      case "rg":
        return "RG";
      case "approvals":
        return "Approvals";
      case "search":
        return "Search";
      case "model":
        return "Model";
      case "profile":
        return "Profile";
      default:
        return "Codex";
    }
  }

  private commandTitleEmoji(commandName: string): string | undefined {
    switch (commandName) {
      case "help":
        return "❓";
      case "status":
        return "📊";
      case "thread":
        return "🧵";
      case "compact":
        return "🗜️";
      case "summary":
        return "📝";
      case "diff":
        return "🧩";
      case "skills":
        return "🧠";
      case "config":
        return "⚙️";
      case "new":
        return "✨";
      case "fork":
        return "🌱";
      case "session":
        return "🧭";
      case "resume":
        return "↩️";
      case "stop":
        return "⏹️";
      case "project":
        return "📁";
      case "log":
        return "📜";
      case "git":
        return "🌿";
      case "feishu":
        return "🪶";
      case "pwd":
      case "ls":
      case "cat":
      case "tree":
      case "find":
      case "rg":
        return "📂";
      case "approvals":
        return "🔐";
      case "search":
        return "🔎";
      case "model":
        return "🤖";
      case "profile":
        return "👤";
      default:
        return undefined;
    }
  }

  private shortenTitleInput(input: string, maxLength = this.config.feishu.titleMaxLength): string {
    const normalized = input.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }
    const edge = Math.max(8, Math.floor((maxLength - 3) / 2));
    return `${normalized.slice(0, edge)}...${normalized.slice(-edge)}`;
  }

  private templateForCommand(commandName?: string): OutgoingMessage["template"] {
    if (!commandName) {
      return "blue";
    }
    switch (commandName) {
      case "help":
      case "status":
      case "thread":
      case "compact":
      case "summary":
      case "diff":
      case "skills":
      case "config":
      case "session":
      case "project":
      case "approvals":
      case "feishu":
      case "log":
      case "search":
      case "model":
      case "profile":
        return "indigo";
      case "new":
      case "fork":
      case "resume":
      case "stop":
      case "git":
      case "pwd":
      case "ls":
      case "cat":
      case "tree":
      case "find":
      case "rg":
        return "wathet";
      default:
        return "blue";
    }
  }

  private templateForSeverity(
    baseTemplate: OutgoingMessage["template"],
    severity?: AppResponse["severity"]
  ): OutgoingMessage["template"] {
    if (severity === "warning") {
      return "orange";
    }
    if (severity === "error") {
      return "red";
    }
    return baseTemplate;
  }

  private renderCommandError(
    title: string,
    error: string,
    usage?: string,
    extraLines: string[] = []
  ): AppResponse {
    return {
      severity: "warning",
      text: [
      `# ${title}`,
      "",
      `- **error**: ${error}`,
      ...(usage ? [`- **usage**: ${usage}`] : []),
      ...extraLines
      ].join("\n")
    };
  }

  private stripLeadingMarkdownHeading(text: string): string {
    const normalized = text.replace(/\r\n/g, "\n");
    if (!normalized.startsWith("# ")) {
      return text;
    }
    const firstNewline = normalized.indexOf("\n");
    if (firstNewline < 0) {
      return "";
    }
    return normalized.slice(firstNewline + 1).replace(/^\n+/, "");
  }

  private extractLeadingMarkdownHeading(text: string): { heading: string; body: string } | undefined {
    const normalized = text.replace(/\r\n/g, "\n");
    if (!normalized.startsWith("# ")) {
      return undefined;
    }
    const firstNewline = normalized.indexOf("\n");
    const heading = normalized.slice(2, firstNewline < 0 ? undefined : firstNewline).trim();
    if (!heading) {
      return undefined;
    }
    const body = firstNewline < 0 ? "" : normalized.slice(firstNewline + 1).replace(/^\n+/, "");
    return { heading, body };
  }

  private mergeStreamingText(existing: string, next: string): string {
    const normalizedExisting = existing.trim();
    const normalizedNext = next.trim();
    if (!normalizedNext) {
      return normalizedExisting;
    }
    if (!normalizedExisting) {
      return normalizedNext;
    }
    if (
      normalizedExisting === normalizedNext ||
      normalizedExisting.endsWith(`\n\n${normalizedNext}`) ||
      normalizedExisting.endsWith(normalizedNext)
    ) {
      return normalizedExisting;
    }
    if (normalizedNext.startsWith(normalizedExisting)) {
      return normalizedNext;
    }
    return `${normalizedExisting}\n\n${normalizedNext}`;
  }

  private footerForMessage(commandName: string | undefined, binding?: SessionBinding): string | undefined {
    if (!commandName) return undefined;
    if (this.commandUsesCodexFooter(commandName)) {
      return `${this.buildIsoFooter()}  |  ${this.buildCodexFooterSummary(binding, true)}`;
    }
    const project = binding?.project || this.config.project.defaultProject;
    return `${this.buildIsoFooter()}  |  ${project}`;
  }

  private footerForCodexReply(binding?: SessionBinding): string {
    return `${this.buildIsoFooter()}  |  ${this.buildCodexFooterSummary(binding, true)}`;
  }

  private buildCodexFooterSummary(binding?: SessionBinding, includeSession = false): string {
    const project = binding?.project || this.config.project.defaultProject;
    const model =
      (binding?.codexSessionId ? this.latestModelReroute.get(binding.codexSessionId)?.toModel : undefined) ||
      binding?.model;
    const session = includeSession ? binding?.codexSessionId : undefined;
    const mode = this.codexFooterModeLabel();
    return [session, model, mode, project].filter((item): item is string => Boolean(item)).join(" · ");
  }

  private commandUsesCodexFooter(commandName: string): boolean {
    return [
      "status",
      "thread",
      "compact",
      "summary",
      "diff",
      "skills",
      "config",
      "session",
      "new",
      "fork",
      "resume"
    ].includes(commandName);
  }

  private codexFooterModeLabel(): string | undefined {
    return this.config.codex.sandboxMode === "danger-full-access"
      ? "full-access"
      : this.config.codex.sandboxMode === "default"
        ? "default"
        : undefined;
  }

  private buildIsoFooter(): string {
    return this.formatLocalIsoTimestamp(new Date());
  }

  private formatLocalIsoTimestamp(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    const millis = String(date.getMilliseconds()).padStart(3, "0");
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const absoluteOffset = Math.abs(offsetMinutes);
    const offsetHours = String(Math.floor(absoluteOffset / 60)).padStart(2, "0");
    const offsetMins = String(absoluteOffset % 60).padStart(2, "0");
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${millis}${sign}${offsetHours}:${offsetMins}`;
  }

  private makeBinding(
    conversationKey: string,
    codexSessionId: string | undefined,
    project: string,
    defaults?: Partial<SessionBinding>
  ): SessionBinding {
    const now = new Date().toISOString();
    return {
      conversationKey,
      codexSessionId,
      project,
      searchEnabled: defaults?.searchEnabled ?? this.config.project.defaultSearchEnabled,
      model: defaults?.model,
      profile: defaults?.profile,
      createdAt: defaults?.createdAt || now,
      updatedAt: now
    };
  }

  private resolveTurnOptions(binding?: Partial<SessionBinding>) {
    return {
      searchEnabled: binding?.searchEnabled ?? this.config.project.defaultSearchEnabled,
      model: binding?.model,
      profile: binding?.profile
    };
  }

  private async resolveProject(
    requested: string,
    currentProject: string,
    createMissing = false,
    requireExists = true
  ): Promise<string> {
    const resolved = path.resolve(
      requested.startsWith("/")
        ? requested
        : path.resolve(currentProject || this.config.project.defaultProject, requested)
    );
    const allowed = this.config.project.allowedRoots.some((root) => {
      const relative = path.relative(root, resolved);
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    });
    if (!allowed) {
      throw new Error(
        `Project must stay under one of: ${this.config.project.allowedRoots.join(", ")}`
      );
    }

    let stats = requireExists ? await fs.stat(resolved).catch(() => null) : null;
    if (!stats && createMissing) {
      await fs.mkdir(resolved, { recursive: true });
      stats = await fs.stat(resolved).catch(() => null);
    }
    if (requireExists && !stats?.isDirectory()) {
      throw new Error(`Project does not exist: ${resolved}`);
    }
    return resolved;
  }

  private parseApprovalMode(value: string): AppConfig["codex"]["sandboxMode"] | undefined {
    const normalized = value.trim().toLowerCase();
    if (["full-access", "danger-full-access", "danger", "bypass"].includes(normalized)) {
      return "danger-full-access";
    }
    if (this.codex.mode === "app-server") {
      if (["auto", "default", "ask", "on-request"].includes(normalized)) {
        return "default";
      }
      return undefined;
    }
    if (["auto", "workspace-write", "workspace", "safe"].includes(normalized)) {
      return "workspace-write";
    }
    if (normalized === "default") {
      return "workspace-write";
    }
    return undefined;
  }

  private approvalChoicesText(): string {
    return this.codex.mode === "app-server"
      ? "`default`, `full-access`"
      : "`auto`, `workspace`, `full-access`";
  }

  private describeApprovalMode(mode: AppConfig["codex"]["sandboxMode"]): string {
    if (this.codex.mode === "app-server") {
      if (mode === "danger-full-access") {
        return "Codex app-server will use `approvalPolicy=never` with `sandbox=danger-full-access` on new runs.";
      }
      return "Codex app-server will use `approvalPolicy=on-request` with `sandbox=workspace-write` on new runs.";
    }
    if (mode === "danger-full-access") {
      return "Codex will use `--dangerously-bypass-approvals-and-sandbox` on new runs.";
    }
    return "Codex will use `--full-auto` on new runs.";
  }

  private approvalsHelpText(): string {
    return [
      "# Approvals",
      "",
      "Show or change the Codex approval mode for future runs.",
      "",
      "## Usage",
      "",
      "- `/approvals [mode]`",
      "- `/approvals -h|--help`",
      "",
      "## Options",
      "",
      "- `mode` show the current mode when omitted",
      ...(this.codex.mode === "app-server"
        ? [
            "- `default` use `approvalPolicy=on-request` with `sandbox=workspace-write`",
            "- `auto` compatibility alias for `default`",
            "- `full-access` use `approvalPolicy=never` with `sandbox=danger-full-access`"
          ]
        : [
            "- `auto` compatibility alias for `workspace`",
            "- `workspace` use Codex `--full-auto`",
            "- `full-access` use Codex `--dangerously-bypass-approvals-and-sandbox`"
          ]),
      "- `-h, --help` show approvals help",
      "",
      "## Behavior",
      "",
      ...(this.codex.mode === "app-server"
        ? [
            "- In `app-server`, `auto` is still accepted as a compatibility alias for `default`, but is not advertised.",
            "- Changes apply to future runs for this conversation."
          ]
        : [
            "- In `spawn`, `auto` maps to `workspace`.",
            "- Changes apply to future runs for this conversation."
          ]),
      "",
      "## Examples",
      "",
      "- `/approvals`",
      ...(this.codex.mode === "app-server"
        ? ["- `/approvals default`", "- `/approvals full-access`"]
        : ["- `/approvals workspace`", "- `/approvals full-access`"])
    ].join("\n");
  }

  private async requestApprovalFromFeishu(
    key: string,
    message: IncomingMessage,
    project: string,
    request: CodexServerRequest,
    onUpdate?: (text: string) => Promise<void>
  ): Promise<Record<string, unknown> | undefined> {
    const pending = this.buildPendingApproval(request, project);
    if (!pending) {
      return undefined;
    }

    this.cancelPendingApproval(key, "superseded by a newer request");

    const promise = new Promise<Record<string, unknown>>((resolve) => {
      pending.resolve = resolve;
    });
    pending.timer = setTimeout(() => {
      if (this.pendingApprovals.get(key) !== pending) return;
      this.pendingApprovals.delete(key);
      pending.resolve?.(pending.timeoutResult);
      void this.sendApprovalMessage(
        message,
        "Approval Timed Out",
        "red",
        [
          "# Approval Timed Out",
          "",
          `- **kind**: \`${pending.label}\``,
          `- **timeout**: \`${Math.round(this.config.codex.approvalTimeoutMs / 1000)}s\``,
          "- Codex was sent a timeout-safe response."
        ].join("\n")
      );
    }, this.config.codex.approvalTimeoutMs);
    pending.timer.unref();

    this.pendingApprovals.set(key, pending);
    await this.sendApprovalMessage(message, pending.title, "orange", pending.prompt, onUpdate);
    return promise;
  }

  private async sendApprovalMessage(
    message: IncomingMessage,
    title: string,
    template: OutgoingMessage["template"],
    text: string,
    onUpdate?: (text: string) => Promise<void>
  ): Promise<void> {
    if (this.feishu) {
      await this.feishu.send({
        chatId: message.chatId,
        title,
        template,
        footer: this.buildIsoFooter(),
        text,
        replyToMessageId: message.messageId,
        threadId: message.threadId
      });
      return;
    }
    if (onUpdate) {
      await onUpdate(text);
    }
  }

  private handleApprovalReply(
    key: string,
    pending: PendingApproval,
    text: string
  ): string {
    const parsed = pending.parse(text);
    if (!parsed.ok) {
      return [
        "# Approval Reply",
        "",
        `- **error**: ${parsed.error}`,
        "- Reply again with one of the listed answers, or use `/stop` to cancel the run."
      ].join("\n");
    }

    this.pendingApprovals.delete(key);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve?.(parsed.result || {});
    return this.renderApprovalAck(pending.label, parsed.result || {}, parsed.summary);
  }

  private cancelPendingApproval(key: string, reason: string): void {
    const pending = this.pendingApprovals.get(key);
    if (!pending) return;
    this.pendingApprovals.delete(key);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve?.(pending.cancelResult);
    console.log("pending approval cancelled", {
      conversationKey: key,
      label: pending.label,
      reason
    });
  }

  private renderApprovalAck(
    label: string,
    result: Record<string, unknown>,
    summary?: string
  ): string {
    const decision = typeof result.decision === "string" ? result.decision : undefined;
    const scope = typeof result.scope === "string" ? result.scope : undefined;
    if (decision === "accept" || decision === "approved") {
      return "# Approval Reply\n\nApproved this time. Passing to Codex...";
    }
    if (decision === "acceptForSession" || decision === "approved_for_session") {
      return "# Approval Reply\n\nApproved for this session. Passing to Codex...";
    }
    if (decision === "decline" || decision === "denied") {
      return "# Approval Reply\n\nDeclined. Sent to Codex.";
    }
    if (decision === "cancel" || decision === "abort") {
      return "# Approval Reply\n\nCancelled. Sent to Codex.";
    }
    if ("permissions" in result) {
      return `# Approval Reply\n\nGranted permission${scope === "session" ? "s for this session" : "s for this turn"}. Passing to Codex...`;
    }
    if ("answers" in result || "content" in result || "action" in result) {
      return "# Approval Reply\n\nReply sent to Codex.";
    }
    return [
      "# Approval Reply",
      "",
      `- **kind**: \`${label}\``,
      `- **answer**: ${summary || "`sent`"}`
    ].join("\n");
  }

  private recordCodexNotification(key: string, notification: { method: string; params: Record<string, unknown> }): void {
    const threadId = this.readString(notification.params.threadId);
    if (notification.method === "thread/tokenUsage/updated" && threadId) {
      const tokenUsage = asObjectRecord(notification.params.tokenUsage);
      this.latestTokenUsage.set(threadId, tokenUsage);
      return;
    }
    if (notification.method === "turn/plan/updated" && threadId) {
      const rawPlan = Array.isArray(notification.params.plan)
        ? notification.params.plan.filter((item): item is Record<string, unknown> => isRecord(item))
        : [];
      this.latestPlan.set(threadId, {
        explanation: this.readString(notification.params.explanation),
        plan: rawPlan
      });
      return;
    }
    if (notification.method === "turn/diff/updated" && threadId) {
      this.latestTurnDiff.set(threadId, {
        turnId: this.readString(notification.params.turnId) || "(unknown)",
        diff: this.readString(notification.params.diff) || ""
      });
      return;
    }
    if (notification.method === "model/rerouted" && threadId) {
      this.latestModelReroute.set(threadId, {
        fromModel: this.readString(notification.params.fromModel) || "(unknown)",
        toModel: this.readString(notification.params.toModel) || "(unknown)",
        reason: this.readString(notification.params.reason)
      });
      return;
    }
    if (notification.method === "account/rateLimits/updated") {
      this.latestRateLimits = notification.params;
      return;
    }
    if (notification.method === "account/updated") {
      this.latestAccountUpdate = notification.params;
      return;
    }
    if (notification.method === "thread/closed" && threadId) {
      this.latestPlan.delete(threadId);
      this.latestTurnDiff.delete(threadId);
    }
    void key;
  }

  private renderCodexNotificationUpdate(notification: { method: string; params: Record<string, unknown> }): string | undefined {
    if (notification.method === "model/rerouted") {
      const fromModel = this.readString(notification.params.fromModel) || "(unknown)";
      const toModel = this.readString(notification.params.toModel) || "(unknown)";
      const reason = this.readString(notification.params.reason);
      return `# 🔀 Model Rerouted\n\n- **from**: \`${fromModel}\`\n- **to**: \`${toModel}\`${reason ? `\n- **reason**: ${reason}` : ""}`;
    }
    if (notification.method === "turn/plan/updated") {
      const plan = Array.isArray(notification.params.plan)
        ? notification.params.plan.filter((item): item is Record<string, unknown> => isRecord(item))
        : [];
      if (plan.length === 0) return undefined;
      return [
        "# 🗺️ Plan Updated",
        "",
        ...(this.readString(notification.params.explanation) ? [`- **note**: ${this.readString(notification.params.explanation)}`] : []),
        ...plan.map((step, index) => `${index + 1}. [${this.readString(step.status) || "pending"}] ${this.readString(step.step) || "(step)"}`)
      ].join("\n");
    }
    if (notification.method === "turn/diff/updated") {
      const diff = this.readString(notification.params.diff) || "";
      const turnId = this.readString(notification.params.turnId);
      const files = this.summarizeDiffFiles(diff);
      return [
        "# 🧩 Diff Updated",
        "",
        ...(turnId ? [`- **turn**: \`${turnId}\``] : []),
        ...(files.length > 0 ? [`- **files**: ${files.map((item) => `\`${item}\``).join(", ")}`] : []),
        "```diff",
        diff || "(empty diff)",
        "```"
      ].join("\n");
    }
    if (notification.method === "item/completed") {
      const item = asObjectRecord(notification.params.item);
      const type = this.readString(item.type) || "(unknown)";
      if (type === "agentMessage") {
        return undefined;
      }
      const id = this.readString(item.id);
      const title =
        type === "commandExecution"
          ? "🧾 Command Completed"
          : type === "userMessage"
            ? "💬 User Message"
            : type === "reasoning"
              ? "🧠 Reasoning"
              : "📍 Codex Event";
      const lines = [
        `# ${title}`,
        "",
        `- **type**: \`${type}\``,
        ...(id ? [`- **id**: \`${id}\``] : [])
      ];
      lines.push(...this.renderCompletedItemDetails(item));
      return lines.join("\n");
    }
    return undefined;
  }

  private renderCodexServerRequestUpdate(
    request: CodexServerRequest,
    project: string
  ): string | undefined {
    if (request.method === "item/tool/call") {
      const id = this.readString(request.params.callId) || this.readString(request.params.itemId);
      const tool = this.readString(request.params.tool) || "(unknown)";
      const cwd = this.readString(request.params.cwd) || project;
      const args = request.params.arguments;
      const lines = [
        "# 🛠️ Tool Call",
        "",
        ...(id ? [`- **id**: \`${id}\``] : []),
        `- **tool**: \`${tool}\``,
        `- **cwd**: \`${cwd}\``
      ];
      if (args !== undefined) {
        lines.push("```json");
        lines.push(this.safeJsonStringify(args));
        lines.push("```");
      }
      return lines.join("\n");
    }
    return undefined;
  }

  private summarizeDiffFiles(diff: string): string[] {
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

  private renderCompletedItemDetails(item: Record<string, unknown>): string[] {
    const lines: string[] = [];
    const type = this.readString(item.type) || "(unknown)";
    const command = this.readString(item.command);
    const tool = this.readString(item.tool);
    const cwd = this.readString(item.cwd);
    const text = this.readString(item.text);
    const status = this.readString(item.status);
    const source = this.readString(item.source);
    const processId = this.readString(item.processId);
    const exitCode = this.readNumber(item.exitCode);
    const durationMs = this.readNumber(item.durationMs);

    if (command) lines.push(`- **command**: \`${command}\``);
    if (tool) lines.push(`- **tool**: \`${tool}\``);
    if (cwd) lines.push(`- **cwd**: \`${cwd}\``);
    if (status) lines.push(`- **status**: \`${status}\``);
    if (source) lines.push(`- **source**: \`${source}\``);
    if (processId) lines.push(`- **process**: \`${processId}\``);
    if (exitCode !== undefined) lines.push(`- **exit code**: \`${exitCode}\``);
    if (durationMs !== undefined) lines.push(`- **duration**: \`${durationMs}ms\``);

    if (type === "userMessage") {
      const content = this.readArray(item.content);
      const rendered = this.renderUserMessageContent(content);
      if (rendered.length > 0) lines.push(...rendered);
      return lines;
    }

    if (type === "reasoning") {
      const summary = this.readArray(item.summary)
        .map((part) => this.readString(part))
        .filter((part): part is string => Boolean(part));
      const content = this.readArray(item.content)
        .map((part) => this.readString(part))
        .filter((part): part is string => Boolean(part));
      if (summary.length > 0) {
        lines.push("- **summary**:");
        lines.push(...summary.slice(0, 8).map((part) => `  - ${part}`));
      }
      if (content.length > 0) {
        lines.push("```text");
        lines.push(content.join("\n\n"));
        lines.push("```");
      }
      return lines;
    }

    if (type === "commandExecution") {
      const output = this.readString(item.aggregatedOutput);
      if (output) {
        lines.push("```text");
        lines.push(output);
        lines.push("```");
      }
      return lines;
    }

    if (type === "fileChange") {
      const changes = this.readArray(item.changes)
        .map((change) => asObjectRecord(change))
        .map((change) => this.readString(change.path) || this.readString(change.filePath))
        .filter((path): path is string => Boolean(path));
      if (changes.length > 0) {
        lines.push(`- **files**: ${changes.slice(0, 12).map((path) => `\`${path}\``).join(", ")}`);
      }
      return lines;
    }

    if (type === "mcpToolCall" || type === "dynamicToolCall" || type === "collabAgentToolCall") {
      const server = this.readString(item.server);
      const prompt = this.readString(item.prompt);
      const model = this.readString(item.model);
      const reasoningEffort = this.readString(item.reasoningEffort);
      const result = item.result;
      const error = item.error;
      if (server) lines.push(`- **server**: \`${server}\``);
      if (model) lines.push(`- **model**: \`${model}\``);
      if (reasoningEffort) lines.push(`- **reasoning effort**: \`${reasoningEffort}\``);
      if (prompt) {
        lines.push("- **prompt**:");
        lines.push("```text");
        lines.push(prompt);
        lines.push("```");
      }
      if (item.arguments !== undefined) {
        lines.push("```json");
        lines.push(this.safeJsonStringify(item.arguments));
        lines.push("```");
      }
      if (result !== undefined && result !== null) {
        lines.push("```json");
        lines.push(this.safeJsonStringify(result));
        lines.push("```");
      }
      if (error !== undefined && error !== null) {
        lines.push("```json");
        lines.push(this.safeJsonStringify(error));
        lines.push("```");
      }
      return lines;
    }

    if (text) {
      lines.push("```text");
      lines.push(text);
      lines.push("```");
    }
    return lines;
  }

  private renderUserMessageContent(content: unknown[]): string[] {
    const textParts: string[] = [];
    const otherParts: string[] = [];
    for (const entry of content) {
      const item = asObjectRecord(entry);
      const type = this.readString(item.type) || "(unknown)";
      if (type === "text") {
        const text = this.readString(item.text);
        if (text) {
          textParts.push(text);
        }
        continue;
      }
      if (type === "image") {
        const url = this.readString(item.url);
        otherParts.push(`- **image**: ${url || "(unknown)"}`);
        continue;
      }
      if (type === "localImage") {
        const path = this.readString(item.path);
        otherParts.push(`- **local image**: \`${path || "(unknown)"}\``);
        continue;
      }
      if (type === "skill" || type === "mention") {
        const name = this.readString(item.name) || "(unknown)";
        const path = this.readString(item.path);
        otherParts.push(`- **${type}**: \`${name}\`${path ? ` (\`${path}\`)` : ""}`);
        continue;
      }
      otherParts.push(`- **${type}**:`);
      otherParts.push("```json");
      otherParts.push(this.safeJsonStringify(item));
      otherParts.push("```");
    }
    const lines: string[] = [];
    if (textParts.length > 0) {
      lines.push("```text");
      lines.push(textParts.join("\n\n"));
      lines.push("```");
    }
    lines.push(...otherParts);
    return lines;
  }

  private formatTokenUsageSummary(tokenUsage: Record<string, unknown>): string {
    const total = asObjectRecord(tokenUsage.total);
    const last = asObjectRecord(tokenUsage.last);
    const totalTokens = Number(total.totalTokens || 0);
    const inputTokens = Number(total.inputTokens || 0);
    const outputTokens = Number(total.outputTokens || 0);
    const lastTokens = Number(last.totalTokens || 0);
    return `total=\`${totalTokens}\` input=\`${inputTokens}\` output=\`${outputTokens}\` last-turn=\`${lastTokens}\``;
  }

  private formatContextWindowStatusLine(tokenUsage: Record<string, unknown>): string {
    const total = asObjectRecord(tokenUsage.total);
    const usedTokens = Number(total.totalTokens || 0);
    const contextWindow = Number(tokenUsage.modelContextWindow || 0);
    if (!Number.isFinite(contextWindow) || contextWindow <= 0 || !Number.isFinite(usedTokens) || usedTokens < 0) {
      return `- **context window**: ${this.formatTokenUsageSummary(tokenUsage)}`;
    }
    if (usedTokens > contextWindow) {
      return `- **context window**: ${this.formatTokenUsageSummary(tokenUsage)}`;
    }
    const leftPercent = Math.max(0, ((contextWindow - usedTokens) / contextWindow) * 100);
    return `- **context window**: \`${leftPercent.toFixed(0)}%\` left (${this.formatCompactTokenCount(usedTokens)} used / ${this.formatCompactTokenCount(contextWindow)})`;
  }

  private formatRateLimitLines(rateLimitPayload: Record<string, unknown>): string[] {
    const buckets = asObjectRecord(rateLimitPayload.rateLimitsByLimitId);
    const entries = Object.entries(buckets);
    if (entries.length === 0) {
      const snapshot = asObjectRecord(rateLimitPayload.rateLimits);
      return [`- **rate limits**: ${this.formatRateLimitSnapshot(snapshot)}`];
    }
    return entries.map(([key, value]) => `- **rate ${key}**: ${this.formatRateLimitSnapshot(asObjectRecord(value))}`);
  }

  private formatRateLimitSnapshot(snapshot: Record<string, unknown>): string {
    const primary = asObjectRecord(snapshot.primary);
    const secondary = asObjectRecord(snapshot.secondary);
    const credits = asObjectRecord(snapshot.credits);
    const parts = [
      snapshot.limitName ? `name=\`${String(snapshot.limitName)}\`` : undefined,
      primary.usedPercent !== undefined ? `primary=\`${Number(primary.usedPercent).toFixed(1)}%\`` : undefined,
      secondary.usedPercent !== undefined ? `secondary=\`${Number(secondary.usedPercent).toFixed(1)}%\`` : undefined,
      credits.balance ? `credits=\`${String(credits.balance)}\`` : undefined,
      snapshot.planType ? `plan=\`${String(snapshot.planType)}\`` : undefined
    ].filter((item): item is string => Boolean(item));
    return parts.join(" ") || "`(unavailable)`";
  }

  private formatRateLimitStatusLines(rateLimitPayload: Record<string, unknown>): string[] {
    const buckets = asObjectRecord(rateLimitPayload.rateLimitsByLimitId);
    const entries = Object.entries(buckets).filter(([, value]) => isRecord(value));
    if (entries.length > 0) {
      return entries.flatMap(([key, value]) =>
        this.formatRateLimitBucketStatusLines(asObjectRecord(value), key)
      );
    }
    const snapshot = asObjectRecord(rateLimitPayload.rateLimits);
    return this.formatRateLimitBucketStatusLines(snapshot);
  }

  private formatRateLimitBucketStatusLines(
    snapshot: Record<string, unknown>,
    bucketId?: string
  ): string[] {
    const primary = asObjectRecord(snapshot.primary);
    const secondary = asObjectRecord(snapshot.secondary);
    const prefix = this.formatRateLimitBucketPrefix(snapshot, bucketId);
    return [
      this.formatRateLimitWindowStatusLine(prefix, primary),
      this.formatRateLimitWindowStatusLine(prefix, secondary)
    ].filter((line): line is string => Boolean(line));
  }

  private formatRateLimitBucketPrefix(snapshot: Record<string, unknown>, bucketId?: string): string {
    const limitName = this.readString(snapshot.limitName);
    if (limitName) return limitName;
    if (bucketId && bucketId !== "codex") return bucketId;
    return "";
  }

  private formatRateLimitWindowStatusLine(
    prefix: string,
    window: Record<string, unknown>
  ): string | undefined {
    const usedPercent = Number(window.usedPercent);
    if (!Number.isFinite(usedPercent)) {
      return undefined;
    }
    const leftPercent = Math.max(0, 100 - usedPercent);
    const label = this.formatRateLimitWindowLabel(window);
    const titledLabel = prefix ? `${prefix} ${label}` : label;
    const resetSuffix = this.formatRateLimitResetSuffix(window.resetsAt);
    return `- **${titledLabel}**: \`${leftPercent.toFixed(0)}%\` left${resetSuffix ? ` (${resetSuffix})` : ""}`;
  }

  private formatRateLimitWindowLabel(window: Record<string, unknown>): string {
    const mins = Number(window.windowDurationMins);
    if (!Number.isFinite(mins) || mins <= 0) {
      return "limit";
    }
    if (mins % (60 * 24 * 7) === 0) {
      const weeks = mins / (60 * 24 * 7);
      return weeks === 1 ? "weekly limit" : `${weeks}w limit`;
    }
    if (mins % (60 * 24) === 0) {
      const days = mins / (60 * 24);
      return days === 1 ? "daily limit" : `${days}d limit`;
    }
    if (mins % 60 === 0) {
      const hours = mins / 60;
      return `${hours}h limit`;
    }
    return `${mins}m limit`;
  }

  private formatRateLimitResetSuffix(value: unknown): string | undefined {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return undefined;
    }
    const date = new Date(numeric * 1000);
    return `resets ${this.formatLocalIsoTimestamp(date)}`;
  }

  private formatSandboxLabel(value: AppConfig["codex"]["sandboxMode"]): string {
    switch (value) {
      case "danger-full-access":
        return "Full Access";
      case "default":
        return "Default";
      default:
        return "Workspace Write";
    }
  }

  private formatAccountSummary(account: Record<string, unknown>, planType: string): string | undefined {
    const email = this.readString(account.email);
    if (email) {
      return `\`${email}\` (\`${planType}\`)`;
    }
    if (planType && planType !== "(unknown)") {
      return `plan=\`${planType}\``;
    }
    return undefined;
  }

  private formatCompactTokenCount(value: number): string {
    if (!Number.isFinite(value) || value < 0) {
      return "0";
    }
    if (value >= 1000) {
      const compact = value / 1000;
      return `${compact % 1 === 0 ? compact.toFixed(0) : compact.toFixed(1)}K`;
    }
    return String(Math.round(value));
  }

  private formatThreadStatus(value: unknown): string {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (isRecord(value)) {
      const type = this.readString(value.type) || "(unknown)";
      const activeFlags = Array.isArray(value.activeFlags)
        ? value.activeFlags.map((item) => String(item)).filter(Boolean)
        : [];
      return activeFlags.length > 0 ? `${type}:${activeFlags.join(",")}` : type;
    }
    return "(unknown)";
  }

  private formatSessionSource(value: unknown): string {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (isRecord(value)) {
      if (this.readString(value.custom)) {
        return `custom:${this.readString(value.custom)}`;
      }
      if (value.subAgent) {
        return `subAgent:${JSON.stringify(value.subAgent)}`;
      }
    }
    return "(unknown)";
  }

  private formatUnixTimestamp(value: unknown): string {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return "(unknown)";
    }
    return this.formatLocalIsoTimestamp(new Date(numeric * 1000));
  }

  private formatAnyTimestamp(value: unknown, fallback = "(unknown)"): string {
    if (typeof value !== "string" || !value.trim()) {
      return fallback;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return value;
    }
    return this.formatLocalIsoTimestamp(parsed);
  }


  private buildPendingApproval(
    request: CodexServerRequest,
    project: string
  ): PendingApproval | undefined {
    switch (request.method) {
      case "item/commandExecution/requestApproval":
        return this.buildCommandApproval(request, project);
      case "execCommandApproval":
        return this.buildCommandApproval(request, project, true);
      case "item/fileChange/requestApproval":
        return this.buildFileApproval(request, project);
      case "applyPatchApproval":
        return this.buildFileApproval(request, project, true);
      case "item/permissions/requestApproval":
        return this.buildPermissionsApproval(request, project);
      case "item/tool/requestUserInput":
        return this.buildToolInputRequest(request, project);
      case "mcpServer/elicitation/request":
        return this.buildMcpElicitationRequest(request, project);
      default:
        return undefined;
    }
  }

  private buildCommandApproval(
    request: CodexServerRequest,
    project: string,
    legacy = false
  ): PendingApproval {
    console.debug("codex command approval request", request);
    const command = this.readString(request.params.command) ||
      readStringArray(request.params.command)?.join(" ") ||
      "(unknown command)";
    const cwd = this.readString(request.params.cwd) || project;
    const reason = this.readString(request.params.reason);
    const available = this.readDecisionChoices(request.params.availableDecisions);
    const choices = available.length > 0
      ? available
      : [
          { label: "allow once", aliases: ["1", "approve", "allow", "yes"], result: { decision: legacy ? "approved" : "accept" } },
          { label: "allow for session", aliases: ["2", "session"], result: { decision: legacy ? "approved_for_session" : "acceptForSession" } },
          { label: "deny", aliases: ["3", "deny", "no"], result: { decision: legacy ? "denied" : "decline" } },
          { label: "cancel", aliases: ["4", "cancel", "abort"], result: { decision: legacy ? "abort" : "cancel" } }
        ];
    return this.makePendingApproval({
      label: "command approval",
      prompt: [
        "# Approval Required",
        "",
        "Would you like to run the following command?",
        "",
        ...(reason ? [`Reason: ${reason}`, ""] : []),
        "```sh",
        command,
        "```",
        ...(cwd !== project ? ["", `cwd: \`${cwd}\``] : []),
        "",
        "## Reply",
        "",
        ...choices.map((choice, index) => `- \`${index + 1}\` ${choice.label}${choice.hint ? ` (${choice.hint})` : ""}`),
        `- You can also reply with the label text, for example ${choices.map((choice) => `\`${choice.aliases.find((alias) => !/^\d+$/.test(alias)) || choice.label}\``).join(", ")}.`
      ].join("\n"),
      parse: (text) => parseChoiceReply(text, choices),
      timeoutResult: { decision: legacy ? "abort" : "cancel" },
      cancelResult: { decision: legacy ? "abort" : "cancel" }
    });
  }

  private buildFileApproval(
    request: CodexServerRequest,
    project: string,
    legacy = false
  ): PendingApproval {
    const reason = this.readString(request.params.reason);
    const grantRoot = this.readString(request.params.grantRoot);
    const fileChanges = asObjectRecord(request.params.fileChanges);
    const fileList = Object.keys(fileChanges).slice(0, 5);
    const choices: ChoiceReply[] = [
      { label: "allow once", aliases: ["1", "approve", "allow", "yes"], result: { decision: legacy ? "approved" : "accept" } },
      { label: "allow for session", aliases: ["2", "session"], result: { decision: legacy ? "approved_for_session" : "acceptForSession" } },
      { label: "deny", aliases: ["3", "deny", "no"], result: { decision: legacy ? "denied" : "decline" } },
      { label: "cancel", aliases: ["4", "cancel", "abort"], result: { decision: legacy ? "abort" : "cancel" } }
    ];
    return this.makePendingApproval({
      label: "file approval",
      prompt: [
        "# Approval Required",
        "",
        `- **kind**: \`file change\``,
        `- **project**: \`${project}\``,
        ...(reason ? [`- **reason**: ${reason}`] : []),
        ...(grantRoot ? [`- **grant root**: \`${grantRoot}\``] : []),
        ...(fileList.length > 0 ? [`- **files**: ${fileList.map((item) => `\`${item}\``).join(", ")}`] : []),
        "",
        "## Reply",
        "",
        ...choices.map((choice, index) => `- \`${index + 1}\` ${choice.label}`)
      ].join("\n"),
      parse: (text) => parseChoiceReply(text, choices),
      timeoutResult: { decision: legacy ? "abort" : "cancel" },
      cancelResult: { decision: legacy ? "abort" : "cancel" }
    });
  }

  private buildPermissionsApproval(
    request: CodexServerRequest,
    project: string
  ): PendingApproval {
    const reason = this.readString(request.params.reason);
    const permissions = asObjectRecord(request.params.permissions);
    const items: Array<{ key: "network" | "fileSystem"; index: number; value: unknown }> = [];
    if (permissions.network) {
      items.push({ key: "network", index: 1, value: permissions.network });
    }
    if (permissions.fileSystem) {
      items.push({ key: "fileSystem", index: permissions.network ? 2 : 1, value: permissions.fileSystem });
    }
    return this.makePendingApproval({
      label: "permissions approval",
      prompt: [
        "# Approval Required",
        "",
        `- **kind**: \`permissions\``,
        `- **project**: \`${project}\``,
        ...(reason ? [`- **reason**: ${reason}`] : []),
        ...items.map((item) => `- \`${item.index}\` ${item.key}`),
        "",
        "## Reply",
        "",
        "- Reply with `all`, `1`, `2`, or `1 2`.",
        "- Add `session` to keep the grant for the session, for example `session all`.",
        "- Reply `deny` or `cancel` to reject."
      ].join("\n"),
      parse: (text) => {
        const normalized = normalizeApprovalReply(text);
        if (matchesAny(normalized, ["deny", "decline", "no"])) {
          return { ok: true, result: { permissions: {}, scope: "turn" }, summary: "`deny`" };
        }
        if (matchesAny(normalized, ["cancel", "abort"])) {
          return { ok: true, result: { permissions: {}, scope: "turn" }, summary: "`cancel`" };
        }
        const scope = normalized.includes("session") ? "session" : "turn";
        const numbers = parseNumberSelections(normalized);
        const wantsAll = normalized.includes("all") || normalized.includes("approve") || normalized.includes("allow");
        const granted: Record<string, unknown> = {};
        for (const item of items) {
          if (wantsAll || numbers.includes(item.index)) {
            granted[item.key] = item.value;
          }
        }
        if (Object.keys(granted).length === 0) {
          return { ok: false, error: "no permission selection matched the request" };
        }
        return {
          ok: true,
          result: { permissions: granted, scope },
          summary: `granted \`${Object.keys(granted).join(", ")}\` for \`${scope}\``
        };
      },
      timeoutResult: { permissions: {}, scope: "turn" },
      cancelResult: { permissions: {}, scope: "turn" }
    });
  }

  private buildToolInputRequest(
    request: CodexServerRequest,
    project: string
  ): PendingApproval {
    const questions = Array.isArray(request.params.questions)
      ? request.params.questions.filter((item): item is Record<string, unknown> => isRecord(item))
      : [];
    return this.makePendingApproval({
      label: "user input",
      prompt: [
        "# User Input Required",
        "",
        `- **project**: \`${project}\``,
        ...questions.flatMap((question, index) => this.renderToolQuestion(index + 1, question)),
        "",
        "## Reply",
        "",
        questions.length <= 1
          ? "- Reply with an option number, option label, or free text."
          : "- Reply one answer per line in the form `question_id=value`."
      ].join("\n"),
      parse: (text) => parseToolInputReply(text, questions),
      timeoutResult: { answers: {} },
      cancelResult: { answers: {} }
    });
  }

  private buildMcpElicitationRequest(
    request: CodexServerRequest,
    project: string
  ): PendingApproval {
    const mode = this.readString(request.params.mode) || "form";
    const message = this.readString(request.params.message) || "(no message)";
    const url = this.readString(request.params.url);
    const meta = request.params._meta ?? null;
    return this.makePendingApproval({
      label: "mcp elicitation",
      prompt: [
        "# User Input Required",
        "",
        `- **kind**: \`mcp elicitation\``,
        `- **project**: \`${project}\``,
        `- **mode**: \`${mode}\``,
        `- **message**: ${message}`,
        ...(url ? [`- **url**: ${url}`] : []),
        "",
        "## Reply",
        "",
        mode === "url"
          ? "- Reply `accept`, `decline`, or `cancel`."
          : "- Reply with a JSON object that matches the requested schema, or `decline` / `cancel`."
      ].join("\n"),
      parse: (text) => {
        const normalized = normalizeApprovalReply(text);
        if (matchesAny(normalized, ["decline", "deny", "no"])) {
          return { ok: true, result: { action: "decline", content: null, _meta: meta }, summary: "`decline`" };
        }
        if (matchesAny(normalized, ["cancel", "abort"])) {
          return { ok: true, result: { action: "cancel", content: null, _meta: meta }, summary: "`cancel`" };
        }
        if (mode === "url" && matchesAny(normalized, ["accept", "approve", "allow", "yes"])) {
          return { ok: true, result: { action: "accept", content: null, _meta: meta }, summary: "`accept`" };
        }
        try {
          const content = JSON.parse(text) as unknown;
          return { ok: true, result: { action: "accept", content, _meta: meta }, summary: "`accept` with JSON content" };
        } catch {
          return { ok: false, error: mode === "url" ? "reply `accept`, `decline`, or `cancel`" : "reply with valid JSON, `decline`, or `cancel`" };
        }
      },
      timeoutResult: { action: "cancel", content: null, _meta: meta },
      cancelResult: { action: "cancel", content: null, _meta: meta }
    });
  }

  private makePendingApproval(input: {
    label: string;
    prompt: string;
    parse: PendingApproval["parse"];
    timeoutResult: Record<string, unknown>;
    cancelResult: Record<string, unknown>;
  }): PendingApproval {
    return {
      title: input.label === "user input" ? "User Input Required" : "Approval Required",
      label: input.label,
      prompt: input.prompt,
      parse: input.parse,
      timeoutResult: input.timeoutResult,
      cancelResult: input.cancelResult
    };
  }

  private renderToolQuestion(index: number, question: Record<string, unknown>): string[] {
    const id = this.readString(question.id) || `q${index}`;
    const header = this.readString(question.header) || id;
    const prompt = this.readString(question.question) || "(no question text)";
    const options = Array.isArray(question.options)
      ? question.options.filter((item): item is Record<string, unknown> => isRecord(item))
      : [];
    return [
      `## ${index}. ${header}`,
      "",
      `- **id**: \`${id}\``,
      `- **question**: ${prompt}`,
      ...options.map((option, optionIndex) => {
        const label = this.readString(option.label) || `option ${optionIndex + 1}`;
        const description = this.readString(option.description);
        return `- \`${optionIndex + 1}\` ${label}${description ? `: ${description}` : ""}`;
      })
    ];
  }

  private safeJsonStringify(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  private readString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private readNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  private readArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  private readDecisionChoices(value: unknown): ChoiceReply[] {
    if (!Array.isArray(value)) return [];
    const choices: ChoiceReply[] = [];
    for (const [index, item] of value.entries()) {
      const choice = this.mapDecisionChoice(item, index + 1);
      if (choice) {
        choices.push(choice);
      }
    }
    return choices;
  }

  private mapDecisionChoice(item: unknown, index: number): ChoiceReply | undefined {
    if (item === "accept") {
      return {
        label: "Yes, proceed",
        aliases: [String(index), "y", "yes", "approve", "allow", "accept"],
        result: { decision: "accept" },
        hint: "y"
      };
    }
    if (item === "acceptForSession") {
      return {
        label: "Yes, and don't ask again for this session",
        aliases: [String(index), "p", "session", "persist", "accept for session"],
        result: { decision: "acceptForSession" },
        hint: "p"
      };
    }
    if (item === "decline") {
      return {
        label: "No, decline",
        aliases: [String(index), "n", "no", "deny", "decline"],
        result: { decision: "decline" },
        hint: "n"
      };
    }
    if (item === "cancel") {
      return {
        label: "No, cancel",
        aliases: [String(index), "esc", "cancel", "abort"],
        result: { decision: "cancel" },
        hint: "esc"
      };
    }
    if (isRecord(item) && isRecord(item.acceptWithExecpolicyAmendment)) {
      return {
        label: "Yes, and don't ask again for similar commands",
        aliases: [String(index), "p", "policy", "persist"],
        result: { decision: item as Record<string, unknown> },
        hint: "p"
      };
    }
    if (isRecord(item) && isRecord(item.applyNetworkPolicyAmendment)) {
      return {
        label: "Yes, and apply this network policy",
        aliases: [String(index), "p", "policy", "network policy"],
        result: { decision: item as Record<string, unknown> },
        hint: "p"
      };
    }
    return undefined;
  }

  private async persistJsonSetting(jsonPath: string[], value: string): Promise<void> {
    if (!this.config.configPath) return;
    const raw = await fs.readFile(this.config.configPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    this.setNestedJsonValue(parsed, jsonPath, value);
    await fs.writeFile(this.config.configPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  }

  private setNestedJsonValue(target: Record<string, unknown>, jsonPath: string[], value: unknown): void {
    let current: Record<string, unknown> = target;
    for (const segment of jsonPath.slice(0, -1)) {
      const next = current[segment];
      if (!next || typeof next !== "object" || Array.isArray(next)) {
        current[segment] = {};
      }
      current = current[segment] as Record<string, unknown>;
    }
    current[jsonPath[jsonPath.length - 1]] = value;
  }

  private async findMostRecentSessionId(
    project: string,
    allProjects = false
  ): Promise<string | undefined> {
    const sessions = await this.listSessionsForCommand(this.config.codex.sessionAllDefaultCount, project, {
      allProjects,
      allSources: this.codex.mode === "app-server"
    });
    return this.sortSessionEntries(sessions, project)[0]?.sessionId;
  }

  private async listScopedSessions(
    limit: number,
    project: string,
    allProjects = false
  ): Promise<Awaited<ReturnType<typeof listRecentSessions>>> {
    return listRecentSessions(
      this.config.codex.sessionsDir,
      Math.max(1, limit),
      allProjects
        ? undefined
        : {
            cwd: project,
            includeUnknownCwd: true
          }
    );
  }

  private async listSessionsForCommand(
    limit: number,
    project: string,
    options?: {
      allProjects?: boolean;
      allSources?: boolean;
      nonInteractiveOnly?: boolean;
      sourceKinds?: string[];
    }
  ): Promise<SessionListEntry[]> {
    if (this.codex.mode === "app-server" && this.codex.listThreads) {
      const native = await this.codex.listThreads(project, {
        limit: Math.max(1, limit),
        cwd: options?.allProjects ? undefined : project,
        allSources: options?.allSources ?? true,
        nonInteractiveOnly: options?.nonInteractiveOnly,
        sourceKinds: options?.sourceKinds,
        archived: false
      }).catch(() => undefined);
      if (native !== undefined) {
        const data = this.readArray(asObjectRecord(native).data);
        return data
          .map((item) => this.normalizeThreadListEntry(isRecord(item) ? item : undefined))
          .filter((item): item is SessionListEntry => Boolean(item));
      }
    }
    return this.listScopedSessions(limit, project, options?.allProjects);
  }

  private async listTrustedProjects(): Promise<string[]> {
    const trusted = await listTrustedProjects(this.config.codex.home);
    return trusted.filter((project) => this.isAllowedProject(project));
  }

  private async listProjects(
    mode: "default" | "all" | "trusted",
    currentProject: string,
    trustedProjects?: string[]
  ): Promise<ProjectListEntry[]> {
    const trusted = trustedProjects || (await this.listTrustedProjects());
    const bindings = await this.store.list();
    const seen = new Set<string>();
    const boundProjects: ProjectListEntry[] = bindings
      .filter((binding) => this.isAllowedProject(binding.project))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .filter((binding) => {
        if (seen.has(binding.project)) return false;
        seen.add(binding.project);
        return true;
      })
      .map((binding) => ({
        project: binding.project,
        name: path.basename(binding.project) || binding.project,
        bound: true,
        trusted: trusted.includes(binding.project),
        updatedAt: binding.updatedAt
      }));

    const trustedOnly: ProjectListEntry[] = trusted
      .filter((project) => !seen.has(project))
      .map((project) => ({
        project,
        name: path.basename(project) || project,
        bound: false,
        trusted: true
      }));

    const currentEntry: ProjectListEntry = {
      project: currentProject,
      name: path.basename(currentProject) || currentProject,
      bound: Boolean(bindings.find((binding) => binding.project === currentProject)),
      trusted: trusted.includes(currentProject),
      updatedAt: bindings.find((binding) => binding.project === currentProject)?.updatedAt
    };

    if (mode === "trusted") {
      const trustedList = [...boundProjects.filter((item) => item.trusted), ...trustedOnly];
      if (!trustedList.find((item) => item.project === currentProject) && currentEntry.trusted) {
        trustedList.unshift(currentEntry);
      }
      return this.sortProjectEntries(trustedList, currentProject);
    }

    const defaultList = [...boundProjects];
    if (!defaultList.find((item) => item.project === currentProject) && this.isAllowedProject(currentProject)) {
      defaultList.unshift(currentEntry);
    }
    if (mode === "default") {
      return this.sortProjectEntries(defaultList, currentProject);
    }
    return this.sortProjectEntries([...defaultList, ...trustedOnly], currentProject);
  }

  private sortProjectEntries(projects: ProjectListEntry[], currentProject: string): ProjectListEntry[] {
    return [...projects].sort((a, b) => {
      if (a.project === currentProject && b.project !== currentProject) return -1;
      if (b.project === currentProject && a.project !== currentProject) return 1;
      const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      if (byName !== 0) return byName;
      return a.project.localeCompare(b.project, undefined, { sensitivity: "base" });
    });
  }

  private previewText(value: string, maxLength = 120): string {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3)}...`;
  }

  private isAllowedProject(project: string): boolean {
    return this.config.project.allowedRoots.some((root) => {
      const relative = path.relative(root, project);
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    });
  }

  private projectHelpText(): string {
    return [
      "# Project",
      "",
      "Inspect the current bound project, browse known projects, or bind one.",
      "",
      "## Usage",
      "",
      "- `/project [list [--all|--trusted]|bind [<path>|-n <index>|-m|--mkdir <path>]|unbind <path>]`",
      "- `/project -h|--help`",
      "",
      "## Options",
      "",
      "### List",
      "",
      "- `list` browse known projects",
      "- `--all` include trusted projects that are not currently bound in the bridge store",
      "- `--trusted` show trusted projects only",
      "",
      "### Bind",
      "",
      "- `bind <path>` bind a project path to this conversation",
      "- `bind -n <index>` bind a project from the current `/project list` ordering",
      "- `bind -m, --mkdir <path>` create the directory before binding",
      "",
      "### Unbind",
      "",
      "- `unbind <path>` remove stored bridge bindings for one project path",
      "",
      "### General",
      "",
      "- `-h, --help` show project help",
      "",
      "## Behavior",
      "",
      "- `/project` shows the current bound project for this conversation.",
      "- `/project list` is the source list used by `/project bind -n <index>`.",
      "- `/project list` ordering is current project first, then project name ascending.",
      "- `/project unbind <path>` rejects the current conversation project; switch elsewhere first.",
      `- Allowed roots: ${this.config.project.allowedRoots.map((root) => `\`${root}\``).join(", ")}`,
      "",
      "## Examples",
      "",
      "- `/project`",
      "- `/project list --all`",
      "- `/project bind /path/to/project`"
    ].join("\n");
  }

  private resumeHelpText(): string {
    return [
      "# Resume",
      "",
      "Resume a session.",
      "",
      "## Usage",
      "",
      "- `/resume [<session-id>|--last|-n <index>|--list] [--all-projects] [--project <path>] [-C|--cd <dir>]`",
      "- `/resume -h|--help`",
      "",
      "## Options",
      "",
      "### Select Session",
      "",
      "- `<session-id>` bind one specific session id",
      "- `--last` bind the most recent session in the current scope",
      "- `-n <index>` bind the Nth session from the current `/session list` ordering",
      "",
      "### List Scope",
      "",
      "- `--list` show the current resumable session list",
      "- `--all-projects` expand browsing beyond the current project for `--list`",
      "- `--project <path>` scope `--list` browsing to one project path",
      "",
      "### Project",
      "",
      "- `-C, --cd <dir>` switch the bound project while resuming",
      "",
      "### General",
      "",
      "- `-h, --help` show resume help",
      "",
      "## Behavior",
      "",
      "- `/resume` and `/resume --last` both bind the most recent session in the current scope.",
      "- `/resume --list` is the listing shortcut before selecting a session to resume.",
      "- `/resume --list --all-projects` browses across projects.",
      "- `/resume <session-id>` adopts that session's own project by default; use `-C, --cd <dir>` to override it.",
      "- Use `-C, --cd <dir>` to switch project while resuming a session.",
      "- `/resume -n <index>` is order-dependent and should be treated as a convenience, not a stable identifier.",
      "- Native Codex flags like `--config`, `--remote`, `--image`, `--model`, `--sandbox`, and prompt arguments are not exposed on this bridge command.",
      "",
      "## Examples",
      "",
      "- `/resume`",
      "- `/resume --list`",
      "- `/resume -C /path/to/project`"
    ].join("\n");
  }

  private forkHelpText(): string {
    return [
      "# Fork",
      "",
      "Fork a Codex session into a new session and bind the new fork to this conversation.",
      "",
      "## Usage",
      "",
      "- `/fork [<session-id>|--last|-n <index>|--list] [--all-projects] [--project <path>]`",
      "- `/fork -h|--help`",
      "",
      "## Options",
      "",
      "### Select Session",
      "",
      "- `<session-id>` fork one specific session id",
      "- `--last` fork the most recent session in the current scope",
      "- `-n <index>` fork the Nth session from the current `/session list` ordering",
      "",
      "### List Scope",
      "",
      "- `--list` show the current forkable session list",
      "- `--all-projects` expand browsing beyond the current project",
      "- `--project <path>` scope browsing and latest-session lookup to one project path",
      "",
      "### General",
      "",
      "- `-h, --help` show fork help",
      "",
      "## Behavior",
      "",
      "- `/fork` defaults to the current bound session for this conversation.",
      "- The source session is not modified.",
      "- The new fork becomes the bound session for this conversation.",
      "- Requires `app-server` mode.",
      "",
      "## Examples",
      "",
      "- `/fork`",
      "- `/fork --list`",
      "- `/fork -n 3`"
    ].join("\n");
  }

  private sessionsHelpText(): string {
    return [
      "# Session",
      "",
      "Inspect the current bound session or browse recent native Codex sessions.",
      "",
      "## Usage",
      "",
      "- `/session [list [-n <count>|--all] [--all-projects] [--project <path>] [--interactive-only|--non-interactive-only|--all-sources|--source <source>]]`",
      "- `/session -h|--help`",
      "",
      "## Options",
      "",
      "### List",
      "",
      "- `list` browse recent sessions",
      `- ` + "`-n <count>`" + ` limit the list size; accepts values from ` + "`1`" + ` to ` + `\`${this.config.codex.sessionAllDefaultCount}\``,
      `- ` + "`--all`" + ` use the larger default count ` + `\`${this.config.codex.sessionAllDefaultCount}\``,
      "- `--all-projects` include sessions from other projects",
      "- `--project <path>` filter to one specific project path",
      "",
      "### Source Filters",
      "",
      "- `--interactive-only` show interactive sources only in `app-server` mode",
      "- `--non-interactive-only` show non-interactive sources only in `app-server` mode",
      "- `--all-sources` include all source kinds in `app-server` mode",
      `- ` + "`--source <source>`" + ` filter by one native source kind: ` + SESSION_SOURCE_KINDS.map((item) => `\`${item}\``).join(", "),
      "",
      "### General",
      "",
      "- `-h, --help` show session help",
      "",
      "## Behavior",
      "",
      "- `/session` shows the current bound session for this conversation.",
      `- \`/session list\` defaults to \`${this.config.codex.sessionListDefaultCount}\` sessions for the current project.`,
      "- In `app-server` mode, `/session list` uses native `thread/list` and defaults to `--all-sources`.",
      "- Session tables are ordered current project first, then project asc, then time desc.",
      "- Use `/resume <session-id>` to bind one of the listed sessions.",
      "",
      "## Examples",
      "",
      "- `/session`",
      "- `/session list --source exec`",
      "- `/session list --all --all-projects`"
    ].join("\n");
  }

  private parseSessionsListLimit(args: ArgCursor): number | undefined {
    if (args.peek() === "--all") {
      args.shift();
      return this.config.codex.sessionAllDefaultCount;
    }
    const remaining = args.remaining();
    if (remaining.length === 1 && /^\d+$/.test(remaining[0] || "")) {
      const raw = args.shift();
      return Math.min(
        this.config.codex.sessionListDefaultCount,
        Math.max(1, Number(raw) || this.config.codex.sessionListDefaultCount)
      );
    }
    const raw = args.takeOption("-n", "--count");
    if (raw !== undefined) {
      if (!raw || !/^\d+$/.test(raw)) {
        return undefined;
      }
      return Math.min(
        this.config.codex.sessionListDefaultCount,
        Math.max(1, Number(raw) || this.config.codex.sessionListDefaultCount)
      );
    }
    return Math.min(
      this.config.codex.sessionListDefaultCount,
      Math.max(1, this.config.codex.sessionListDefaultCount)
    );
  }

  private noSessionsText(project: string, allProjects: boolean, explicitProject = false): string {
    if (explicitProject) {
      return `No native Codex sessions found for project \`${project}\` under ${this.config.codex.sessionsDir}`;
    }
    return allProjects
      ? `No native Codex sessions found under ${this.config.codex.sessionsDir}`
      : `No native Codex sessions found for current project \`${project}\` under ${this.config.codex.sessionsDir}`;
  }

  private renderSessionList(
    title: string,
    sessions: SessionListEntry[],
    boundSessionId?: string,
    currentProject?: string
  ): string {
    const sortedSessions = this.sortSessionEntries(sessions, currentProject);
    const lines = [
      `# ${title}`,
      "",
      "- sorted by: `current project first, then project asc, then time desc`",
      "",
      "| # | project | time | session | source | about | flags |",
      "| --- | --- | --- | --- | --- | --- | --- |"
    ];
    for (const [index, session] of sortedSessions.entries()) {
      const flags = [
        currentProject && session.cwd === currentProject ? "current" : "",
        session.sessionId === boundSessionId ? "bound" : ""
      ].filter(Boolean);
      lines.push(
        `| ${index + 1} | ${escapeMarkdownCell(session.cwd || "(unknown)")} | ${escapeMarkdownCell(this.formatAnyTimestamp(session.createdAt))} | ${escapeMarkdownCell(session.sessionId)} | ${escapeMarkdownCell(session.source || "-")} | ${escapeMarkdownCell(session.preview || "(no preview)")} | ${escapeMarkdownCell(flags.join(", ") || "-")} |`
      );
    }
    return lines.join("\n");
  }

  private sortSessionEntries(
    sessions: SessionListEntry[],
    currentProject?: string
  ): SessionListEntry[] {
    return [...sessions].sort((a, b) => {
      const aCurrent = currentProject && a.cwd === currentProject;
      const bCurrent = currentProject && b.cwd === currentProject;
      if (aCurrent && !bCurrent) return -1;
      if (bCurrent && !aCurrent) return 1;
      const aProject = a.cwd || "";
      const bProject = b.cwd || "";
      const byProject = aProject.localeCompare(bProject, undefined, { sensitivity: "base" });
      if (byProject !== 0) return byProject;
      const byTime = (b.createdAt || "").localeCompare(a.createdAt || "");
      if (byTime !== 0) return byTime;
      return a.sessionId.localeCompare(b.sessionId, undefined, { sensitivity: "base" });
    });
  }

  private normalizeThreadListEntry(thread: Record<string, unknown> | undefined): SessionListEntry | undefined {
    if (!thread) return undefined;
    const sessionId = this.readString(thread.id);
    if (!sessionId) return undefined;
    return {
      sessionId,
      createdAt: this.formatThreadTimestamp(this.readNumber(thread.createdAt)),
      cwd: this.readString(thread.cwd),
      preview: this.readString(thread.preview),
      source: this.formatThreadSource(thread.source)
    };
  }

  private formatThreadTimestamp(value: number | undefined): string | undefined {
    if (!Number.isFinite(value)) return undefined;
    return new Date((value as number) * 1000).toISOString();
  }

  private formatThreadSource(source: unknown): string | undefined {
    if (typeof source === "string") return source;
    if (!isRecord(source)) return undefined;
    const entry = Object.entries(source)[0];
    if (!entry) return undefined;
    const [key, value] = entry;
    if (typeof value === "string" && value) {
      return `${key}:${value}`;
    }
    return key;
  }

  private renderProjectList(
    title: string,
    projects: ProjectListEntry[],
    currentProject: string
  ): string {
    const lines = [
      `# ${title}`,
      "",
      "- sorted by: `current first, then name asc`",
      "",
      "| # | name | flags | updated | path |",
      "| --- | --- | --- | --- | --- |"
    ];
    for (const [index, item] of projects.entries()) {
      const flags = [
        item.project === currentProject ? "current" : "",
        item.bound ? "bound" : "",
        item.trusted ? "trusted" : ""
      ].filter(Boolean);
      lines.push(
        `| ${index + 1} | ${escapeMarkdownCell(item.name)} | ${escapeMarkdownCell(flags.join(", ") || "-")} | ${escapeMarkdownCell(item.updatedAt ? this.formatAnyTimestamp(item.updatedAt) : "-")} | ${escapeMarkdownCell(item.project)} |`
      );
    }
    return lines.join("\n");
  }

  private parseLogQuery(args: string[]): LogQuery | Error {
    const query: LogQuery = { limit: 200 };
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "-n") {
        const limit = Number(args[index + 1] || "");
        if (!Number.isInteger(limit) || limit < 1 || limit > 2000) {
          return new Error("`-n` must be an integer between 1 and 2000");
        }
        query.limit = limit;
        index += 1;
        continue;
      }
      if (arg === "--since") {
        const { value, nextIndex } = this.consumeOptionText(args, index + 1);
        const since = value.trim();
        if (!since) {
          return new Error("`--since` requires a value such as `10m ago`, `today`, or `2026-03-27 01:00:00`");
        }
        query.since = this.normalizeJournalctlSince(since);
        index = nextIndex;
        continue;
      }
      if (arg === "--grep") {
        const { value, nextIndex } = this.consumeOptionText(args, index + 1);
        const grep = value.trim();
        if (!grep) {
          return new Error("`--grep` requires a non-empty value");
        }
        query.grep = grep;
        index = nextIndex;
        continue;
      }
      return new Error(`unsupported option \`${arg}\``);
    }
    return query;
  }

  private logHelpText(): string {
    return [
      "# Log",
      "",
      "Read recent bridge service logs from the systemd journal.",
      "",
      "## Usage",
      "",
      "- `/log [-n <count>] [--since <expr>] [--grep <text>]`",
      "- `/log -h|--help`",
      "",
      "## Options",
      "",
      "- `-n <count>` set the number of lines to read",
      "- `--since <expr>` set the journal time filter",
      "- `--grep <text>` filter the fetched journal output case-insensitively",
      "- `-h, --help` show log help",
      "",
      "## Behavior",
      "",
      "- Default tail is `200` lines.",
      "- `-n` accepts values from `1` to `2000`.",
      "- `--since` accepts multi-word values like `30 minutes ago`, plus compact forms like `30m`, `2h`, and `1d`.",
      "",
      "## Examples",
      "",
      "- `/log`",
      "- `/log -n 50`",
      "- `/log --since today --grep reconnect`"
    ].join("\n");
  }

  private feishuHelpText(): string {
    return [
      "# Feishu",
      "",
      "Show Feishu websocket and outbound send diagnostics for the running bridge.",
      "",
      "## Usage",
      "",
      "- `/feishu [ws|send|doctor]`",
      "- `/feishu -h|--help`",
      "",
      "## Options",
      "",
      "- `ws` show websocket readiness and recent inbound timing",
      "- `send` show outbound retry, failure, and streaming-card state",
      "- `doctor` run the quick Feishu health view",
      "- `-h, --help` show Feishu help",
      "",
      "## Behavior",
      "",
      "- `/feishu` shows a compact summary.",
      "",
      "## Examples",
      "",
      "- `/feishu`",
      "- `/feishu ws`",
      "- `/feishu doctor`"
    ].join("\n");
  }

  private statusHelpText(): string {
    return [
      "# Status",
      "",
      "Show current bridge conversation state, bound session, project, and live run details.",
      "",
      "## Usage",
      "",
      "- `/status [check-update]`",
      "- `/status -h|--help`",
      "",
      "## Options",
      "",
      "- `check-update` show the lightweight update-only view for Codex and Feishu package versions",
      "- `-h, --help` show status help",
      "",
      "## Behavior",
      "",
      "- Includes native-style Codex status, bridge state, and a separate Feishu diagnostics section.",
      "- Sends a short progress update first because `/status` may read local metadata and app-server state.",
      "- In `app-server`, includes thread metadata, token usage, latest reroute, and plan when available.",
      "- `check-update` switches to the update-only view instead of the full status report.",
      "",
      "## Examples",
      "",
      "- `/status`",
      "- `/status check-update`"
    ].join("\n");
  }

  private statusRequestsUpdateCheck(args: ArgCursor): boolean {
    if (args.peek() === "check-update" || args.peek() === "--check-update") {
      args.shift();
      return true;
    }
    return false;
  }

  private renderFeishuSummary(diagnostics: ReturnType<FeishuGateway["diagnostics"]>): string {
    return [
      "# Feishu",
      "",
      `- **status**: ${this.formatFeishuDoctorVerdict(diagnostics)}`,
      `- **ws**: ${this.formatFeishuWsSummary(diagnostics)}`,
      `- **send**: ${this.formatFeishuSendSummary(diagnostics)}`,
      "",
      "## More",
      "",
      "- `/feishu ws`",
      "- `/feishu send`",
      "- `/feishu doctor`"
    ].join("\n");
  }

  private renderFeishuWs(diagnostics: ReturnType<FeishuGateway["diagnostics"]>): string {
    return [
      "# Feishu WS",
      "",
      `- **connected once**: \`${diagnostics.wsConnectedOnce ? "yes" : "no"}\``,
      `- **reconnecting**: \`${diagnostics.wsReconnecting ? "yes" : "no"}\``,
      `- **reconnect count**: \`${diagnostics.reconnectCount}\``,
      `- **auto reconnect**: \`${this.config.feishu.wsAutoReconnect ? "yes" : "no"}\``,
      `- **logger level**: \`${this.config.feishu.wsLoggerLevel}\``,
      `- **agent keepalive ms**: \`${this.config.feishu.wsAgentKeepAliveMsecs}\``,
      `- **agent max sockets**: \`${this.config.feishu.wsAgentMaxSockets}\``,
      `- **agent max free sockets**: \`${this.config.feishu.wsAgentMaxFreeSockets}\``,
      `- **connect warn after ms**: \`${this.config.feishu.wsConnectWarnAfterMs}\``,
      `- **reconnect warn threshold**: \`${this.config.feishu.wsReconnectWarnThreshold}\``,
      `- **reconnect debounce ms**: \`${this.config.feishu.reconnectReadyDebounceMs}\``,
      `- **last reconnect started**: ${this.formatAnyTimestamp(diagnostics.lastReconnectStartedAt, "(never)")}`,
      `- **last ws ready**: ${this.formatAnyTimestamp(diagnostics.lastWsReadyAt)}`,
      `- **last reconnect ready**: ${this.formatAnyTimestamp(diagnostics.lastReconnectReadyAt, "(never)")}`,
      `- **last inbound message**: ${this.formatAnyTimestamp(diagnostics.lastInboundMessageAt)}`,
      `- **last inbound message id**: \`${diagnostics.lastInboundMessageId || "(unknown)"}\``
    ].join("\n");
  }

  private renderFeishuSend(diagnostics: ReturnType<FeishuGateway["diagnostics"]>): string {
    return [
      "# Feishu Send",
      "",
      `- **retry max attempts**: \`${this.config.feishu.sendRetryMaxAttempts}\``,
      `- **retry base delay ms**: \`${this.config.feishu.sendRetryBaseDelayMs}\``,
      `- **retry multiplier**: \`${this.config.feishu.sendRetryMultiplier}\``,
      `- **retry max delay ms**: \`${this.config.feishu.sendRetryMaxDelayMs}\``,
      `- **outbound retries**: \`${diagnostics.outboundRetryCount}\``,
      `- **outbound failures**: \`${diagnostics.outboundFailureCount}\``,
      `- **active chat send queues**: \`${diagnostics.activeChatSendQueues}\``,
      `- **queued chats**: ${diagnostics.queuedChatIds.length > 0 ? diagnostics.queuedChatIds.map((chatId) => `\`${chatId}\``).join(", ") : "(none)"}`,
      `- **active streaming cards**: \`${diagnostics.activeStreamingCards}\``,
      `- **last send error**: ${diagnostics.lastSendError || "(none)"}`
    ].join("\n");
  }

  private renderFeishuDoctor(diagnostics: ReturnType<FeishuGateway["diagnostics"]>): string {
    const findings: string[] = [];
    const startedAtMs = Date.parse(diagnostics.startedAt);
    if (!diagnostics.wsConnectedOnce) {
      findings.push("- websocket has not connected yet");
    }
    if (
      !diagnostics.wsConnectedOnce &&
      Number.isFinite(startedAtMs) &&
      Date.now() - startedAtMs >= this.config.feishu.wsConnectWarnAfterMs
    ) {
      findings.push(
        `- websocket has not become ready within \`${this.config.feishu.wsConnectWarnAfterMs}\` ms since startup`
      );
    }
    if (diagnostics.wsReconnecting) {
      findings.push("- websocket is currently reconnecting");
    }
    if (diagnostics.reconnectCount >= this.config.feishu.wsReconnectWarnThreshold) {
      findings.push(
        `- websocket has reconnected multiple times since startup: \`${diagnostics.reconnectCount}\` (threshold \`${this.config.feishu.wsReconnectWarnThreshold}\`)`
      );
    }
    if (diagnostics.outboundFailureCount > 0) {
      findings.push(`- outbound send failures observed: \`${diagnostics.outboundFailureCount}\``);
    }
    if ((diagnostics.lastSendError || "").includes("Missing access token")) {
      findings.push("- last send error suggests Feishu auth or token handling is failing");
    }
    if (diagnostics.activeStreamingCards > 10) {
      findings.push(`- active streaming cards is high: \`${diagnostics.activeStreamingCards}\``);
    }
    if (!diagnostics.lastInboundMessageAt) {
      findings.push("- no inbound Feishu message has been observed since startup");
    }
    return [
      "# Feishu Doctor",
      "",
      `- **verdict**: ${this.formatFeishuDoctorVerdict(diagnostics)}`,
      `- **ws summary**: ${this.formatFeishuWsSummary(diagnostics)}`,
      `- **send summary**: ${this.formatFeishuSendSummary(diagnostics)}`,
      "",
      "## Findings",
      "",
      ...(findings.length ? findings : ["- no obvious transport issues from the current in-memory diagnostics"])
    ].join("\n");
  }

  private formatFeishuStatusSummary(diagnostics: ReturnType<FeishuGateway["diagnostics"]>): string {
    return `${this.formatFeishuDoctorVerdict(diagnostics)}; ${this.formatFeishuWsSummary(diagnostics)}; ${this.formatFeishuSendSummary(diagnostics)}`;
  }

  private formatFeishuDoctorVerdict(
    diagnostics: ReturnType<FeishuGateway["diagnostics"]>
  ): string {
    if (!diagnostics.wsConnectedOnce) {
      return "`attention` (ws not connected yet)";
    }
    if (diagnostics.wsReconnecting) {
      return "`attention` (reconnecting)";
    }
    if (diagnostics.outboundFailureCount > 0) {
      return "`attention` (outbound failures seen)";
    }
    return "`ok`";
  }

  private formatFeishuWsSummary(diagnostics: ReturnType<FeishuGateway["diagnostics"]>): string {
    return `connected=\`${diagnostics.wsConnectedOnce ? "yes" : "no"}\` reconnecting=\`${diagnostics.wsReconnecting ? "yes" : "no"}\` reconnects=\`${diagnostics.reconnectCount}\` lastReady=${this.formatAnyTimestamp(diagnostics.lastWsReadyAt)} lastInbound=${this.formatAnyTimestamp(diagnostics.lastInboundMessageAt)}`;
  }

  private formatFeishuSendSummary(diagnostics: ReturnType<FeishuGateway["diagnostics"]>): string {
    return `retries=\`${diagnostics.outboundRetryCount}\` failures=\`${diagnostics.outboundFailureCount}\` streaming=\`${diagnostics.activeStreamingCards}\`${diagnostics.lastSendError ? ` error=${diagnostics.lastSendError}` : ""}`;
  }

  private async readStatusUpdates(
    currentCodexVersion: string | undefined,
    currentFeishuSdkVersion: string | undefined,
    declaredFeishuSdkRange: string | undefined
  ): Promise<{
    codex: { packageName: string; current?: string; latest?: string; status: string; detail: string };
    feishu: {
      packageName: string;
      declared?: string;
      current?: string;
      latest?: string;
      status: string;
      detail: string;
    };
  }> {
    const [latestCodexVersion, latestFeishuSdkVersion] = await Promise.all([
      this.readLatestNpmPackageVersion("@openai/codex"),
      this.readLatestNpmPackageVersion("@larksuiteoapi/node-sdk")
    ]);
    return {
      codex: {
        packageName: "@openai/codex",
        current: currentCodexVersion,
        latest: latestCodexVersion,
        status: this.describeUpdateStatus(currentCodexVersion, latestCodexVersion),
        detail: "Current version comes from the local Codex runtime metadata used by the bridge."
      },
      feishu: {
        packageName: "@larksuiteoapi/node-sdk",
        declared: declaredFeishuSdkRange,
        current: currentFeishuSdkVersion,
        latest: latestFeishuSdkVersion,
        status: this.describeUpdateStatus(currentFeishuSdkVersion, latestFeishuSdkVersion),
        detail: "This is the Node SDK dependency used by the bridge for Feishu websocket and HTTPS APIs."
      }
    };
  }

  private async readInstalledPackageVersion(packageName: string): Promise<string | undefined> {
    const packagePath = new URL(`../../node_modules/${packageName}/package.json`, import.meta.url);
    const raw = await fs.readFile(packagePath, "utf8").catch(() => "");
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as { version?: string };
      return typeof parsed.version === "string" ? parsed.version : undefined;
    } catch {
      return undefined;
    }
  }

  private async readDeclaredPackageRange(packageName: string): Promise<string | undefined> {
    const packagePath = new URL("../../package.json", import.meta.url);
    const raw = await fs.readFile(packagePath, "utf8").catch(() => "");
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      return parsed.dependencies?.[packageName] || parsed.devDependencies?.[packageName];
    } catch {
      return undefined;
    }
  }

  private async readLatestNpmPackageVersion(packageName: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync(
        "npm",
        ["view", packageName, "version", "--json"],
        { timeout: 15_000, maxBuffer: 512 * 1024 }
      );
      const trimmed = stdout.trim();
      if (!trimmed) return undefined;
      const parsed = JSON.parse(trimmed) as string;
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private describeUpdateStatus(currentVersion?: string, latestVersion?: string): string {
    if (!latestVersion) return "latest unavailable";
    if (!currentVersion) return "current unknown";
    return this.normalizeVersion(currentVersion) === this.normalizeVersion(latestVersion)
      ? "up to date"
      : "update available";
  }

  private formatUpdateStatusBadge(status: string): string {
    return status === "up to date" ? `\`${status}\`` : `**${status}**`;
  }

  private normalizeVersion(value: string): string {
    return value.trim().replace(/^v/i, "");
  }

  private threadHelpText(): string {
    return [
      "# Thread",
      "",
      "Show app-server thread metadata for the current bound session.",
      "",
      "## Usage",
      "",
      "- `/thread [--turns]`",
      "- `/thread -h|--help`",
      "",
      "## Options",
      "",
      "- `--turns` fetch turn details and print a compact turn summary",
      "- `-h, --help` show thread help",
      "",
      "## Behavior",
      "",
      "- Requires a currently bound session and `app-server` support.",
      "",
      "## Examples",
      "",
      "- `/thread`",
      "- `/thread --turns`"
    ].join("\n");
  }

  private summaryHelpText(): string {
    return [
      "# Summary",
      "",
      "Show the current bound Codex conversation summary.",
      "",
      "## Usage",
      "",
      "- `/summary`",
      "- `/summary -h|--help`",
      "",
      "## Options",
      "",
      "- `-h, --help` show summary help",
      "",
      "## Behavior",
      "",
      "- Requires a currently bound session.",
      "- Uses native Codex `getConversationSummary` in `app-server` mode.",
      "",
      "## Examples",
      "",
      "- `/summary`"
    ].join("\n");
  }

  private diffHelpText(): string {
    return [
      "# Diff",
      "",
      "Show the latest cached app-server turn diff for the current bound session.",
      "",
      "## Usage",
      "",
      "- `/diff`",
      "- `/diff -h|--help`",
      "",
      "## Options",
      "",
      "- `-h, --help` show diff help",
      "",
      "## Behavior",
      "",
      "- Uses the most recent `turn/diff/updated` notification seen by the bridge.",
      "- If no diff notification has been seen yet, the command returns no cached diff.",
      "",
      "## Examples",
      "",
      "- `/diff`"
    ].join("\n");
  }

  private skillsHelpText(): string {
    return [
      "# Skills",
      "",
      "Show Codex skills visible for the current project.",
      "",
      "## Usage",
      "",
      "- `/skills [--reload]`",
      "- `/skills -h|--help`",
      "",
      "## Options",
      "",
      "- `--reload` bypass the skills cache and rescan from disk",
      "- `-h, --help` show skills help",
      "",
      "## Behavior",
      "",
      "- Uses native Codex `skills/list` in `app-server` mode.",
      "",
      "## Examples",
      "",
      "- `/skills`",
      "- `/skills --reload`"
    ].join("\n");
  }

  private configHelpText(): string {
    return [
      "# Config",
      "",
      "Show key effective Codex config values for the current project.",
      "",
      "## Usage",
      "",
      "- `/config [codex-toml] [--layers]`",
      "- `/config -h|--help`",
      "",
      "## Options",
      "",
      "- `codex-toml` show a redacted raw view of `~/.codex/config.toml`",
      "- `--layers` include the resolved config layer list",
      "- `-h, --help` show config help",
      "",
      "## Behavior",
      "",
      "- Uses native Codex `config/read` in `app-server` mode.",
      "",
      "## Examples",
      "",
      "- `/config`",
      "- `/config codex-toml`",
      "- `/config --layers`"
    ].join("\n");
  }

  private redactToml(raw: string): string {
    const sensitiveKey = /(token|secret|password|api[_-]?key|bearer|authorization|cookie|access[_-]?key|client[_-]?secret|shared[_-]?secret|private[_-]?key)/i;
    const envPattern = /\b[A-Z][A-Z0-9_]{2,}\b/g;
    return raw
      .split(/\r?\n/)
      .map((line) => {
        const keyValue = line.match(/^(\s*["']?[^"'=\s#]+["']?\s*=\s*)(.*)$/);
        if (!keyValue) return line;
        const [, prefix, value] = keyValue;
        const key = prefix.split("=")[0] || "";
        if (sensitiveKey.test(key)) {
          return `${prefix}"<redacted>"`;
        }
        const redactedValue = value
          .replace(/(["'])([^"']*?(token|secret|password|api[_-]?key|bearer|authorization|cookie)[^"']*)\1/gi, `"${
            "<redacted>"
          }"`)
          .replace(envPattern, (match) => (sensitiveKey.test(match) ? "<redacted-env>" : match));
        return `${prefix}${redactedValue}`;
      })
      .join("\n");
  }

  private compactHelpText(): string {
    return [
      "# Compact",
      "",
      "Compact the currently bound native Codex session.",
      "",
      "## Usage",
      "",
      "- `/compact`",
      "- `/compact -h|--help`",
      "",
      "## Options",
      "",
      "- `-h, --help` show compact help",
      "",
      "## Behavior",
      "",
      "- Requires a currently bound session from `/new` or `/resume`.",
      "- Uses native Codex thread compaction in `app-server` mode.",
      "- The bridge updates the bound session timestamp after compaction completes.",
      "",
      "## Examples",
      "",
      "- `/compact`"
    ].join("\n");
  }

  private newHelpText(): string {
    return [
      "# New",
      "",
      "Create and bind a fresh Codex session for the current bound project.",
      "",
      "## Usage",
      "",
      "- `/new [-C|--cd <dir>]`",
      "- `/new -h|--help`",
      "",
      "## Options",
      "",
      "- `-C, --cd <dir>` switch the conversation project before creating the new session",
      "- `-h, --help` show new-session help",
      "",
      "## Behavior",
      "",
      "- Uses the current bound project from `/project` unless you pass `-C` or `--cd`.",
      "- Carries the current conversation search, model, and profile settings into the new session.",
      "",
      "## Examples",
      "",
      "- `/new`",
      "- `/new -C /path/to/project`"
    ].join("\n");
  }

  private stopHelpText(): string {
    return [
      "# Stop",
      "",
      "Stop the active Codex run for this conversation.",
      "",
      "## Usage",
      "",
      "- `/stop`",
      "- `/stop -h|--help`",
      "",
      "## Options",
      "",
      "- `-h, --help` show stop help",
      "",
      "## Behavior",
      "",
      "- Cancels any pending approval for the active run.",
      "- Does not unbind the current session.",
      "",
      "## Examples",
      "",
      "- `/stop`"
    ].join("\n");
  }

  private searchHelpText(): string {
    return [
      "# Search",
      "",
      "Show or change live web search for future turns in this conversation.",
      "",
      "## Usage",
      "",
      "- `/search [on|off]`",
      "- `/search -h|--help`",
      "",
      "## Options",
      "",
      "- `on` enable live web search for future turns",
      "- `off` disable live web search for future turns",
      "- `-h, --help` show search help",
      "",
      "## Behavior",
      "",
      "- This setting is stored in the bridge binding for the current conversation.",
      "- New and resumed turns use the latest saved setting.",
      "",
      "## Examples",
      "",
      "- `/search`",
      "- `/search on`",
      "- `/search off`"
    ].join("\n");
  }

  private modelHelpText(): string {
    return [
      "# Model",
      "",
      "Show or change the Codex model override for this conversation.",
      "",
      "## Usage",
      "",
      "- `/model [--list|name|clear]`",
      "- `/model -h|--help`",
      "",
      "## Options",
      "",
      "- `--list` show common model IDs you can try",
      "- `name` set the conversation-level model override",
      "- `clear` remove the conversation-level model override",
      "- `default` remove the conversation-level model override",
      "- `reset` remove the conversation-level model override",
      "- `-h, --help` show model help",
      "",
      "## Behavior",
      "",
      "- `clear`, `default`, and `reset` remove the conversation-level override.",
      "- `/model --list` shows common model IDs you can try; exact availability depends on your Codex account/backend.",
      "- The configured override is used for future turns.",
      "",
      "## Examples",
      "",
      "- `/model`",
      "- `/model --list`",
      "- `/model gpt-5.4`"
    ].join("\n");
  }

  private modelListText(modelList?: Record<string, unknown>): string {
    const liveModels = Array.isArray(modelList?.data)
      ? modelList.data.filter((item): item is Record<string, unknown> => isRecord(item))
      : [];
    if (liveModels.length > 0) {
      return [
        "# Model List",
        "",
        ...liveModels.map((model) => {
          const id = this.readString(model.model) || this.readString(model.id) || "(unknown)";
          const displayName = this.readString(model.displayName);
          const defaultFlag = model.isDefault ? " default" : "";
          const description = this.readString(model.description);
          return `- \`${id}\`${displayName && displayName !== id ? ` (${displayName}${defaultFlag})` : defaultFlag ? ` (${defaultFlag.trim()})` : ""}${description ? `: ${description}` : ""}`;
        }),
        "",
        "## Notes",
        "",
        "- This list comes from Codex app-server `model/list`.",
        "- Exact availability still depends on your current account and server-side routing.",
        "- Use `/model <name>` to set one for future turns in this conversation.",
        "- Use `/model clear` to remove the override."
      ].join("\n");
    }

    return [
      "# Model List",
      "",
      "- `gpt-5.4`",
      "- `gpt-5.4-mini`",
      "- `gpt-5.3-codex`",
      "- `gpt-5.2-codex`",
      "- `gpt-5.2`",
      "- `gpt-5.1-codex-max`",
      "- `gpt-5.1-codex-mini`",
      "",
      "## Notes",
      "",
      "- This is a bridge-side fallback list because a live app-server model list was unavailable.",
      "- Exact availability depends on your current Codex account, backend, and server-side routing.",
      "- Use `/model <name>` to set one for future turns in this conversation.",
      "- Use `/model clear` to remove the override."
    ].join("\n");
  }

  private profileHelpText(): string {
    return [
      "# Profile",
      "",
      "Show or change the Codex profile override for this conversation.",
      "",
      "## Usage",
      "",
      "- `/profile [name|clear]`",
      "- `/profile -h|--help`",
      "",
      "## Options",
      "",
      "- `name` set the conversation-level profile override",
      "- `clear` remove the conversation-level profile override",
      "- `default` remove the conversation-level profile override",
      "- `reset` remove the conversation-level profile override",
      "- `-h, --help` show profile help",
      "",
      "## Behavior",
      "",
      "- `clear`, `default`, and `reset` remove the conversation-level override.",
      "- The configured override is used for future turns.",
      "",
      "## Examples",
      "",
      "- `/profile`",
      "- `/profile personal`",
      "- `/profile clear`"
    ].join("\n");
  }

  private consumeOptionText(args: string[], startIndex: number): { value: string; nextIndex: number } {
    const parts: string[] = [];
    let index = startIndex;
    for (; index < args.length; index += 1) {
      if (args[index].startsWith("-")) break;
      parts.push(args[index]);
    }
    return { value: parts.join(" "), nextIndex: index - 1 };
  }

  private normalizeJournalctlSince(value: string): string {
    const trimmed = value.trim();
    const compact = trimmed.match(/^(\d+)([mhd])$/i);
    if (!compact) return trimmed;
    const amount = Number(compact[1]);
    const unit = compact[2].toLowerCase();
    const date = new Date();
    if (unit === "m") {
      date.setMinutes(date.getMinutes() - amount);
    } else if (unit === "h") {
      date.setHours(date.getHours() - amount);
    } else {
      date.setDate(date.getDate() - amount);
    }
    return this.formatJournalctlTimestamp(date);
  }

  private formatJournalctlTimestamp(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    const second = String(date.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  }

  private async readBridgeLogs(query: LogQuery): Promise<string> {
    try {
      const journalArgs = [
        "--user",
        "-u",
        "codex-feishu-bridge.service",
        "-n",
        String(query.limit),
        "--no-pager"
      ];
      if (query.since) {
        journalArgs.push("--since", query.since);
      }
      const { stdout, stderr } = await execFileAsync("journalctl", journalArgs, {
        timeout: GIT_COMMAND_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024
      });
      const combined = [stdout, stderr].filter(Boolean).join(stderr && stdout ? "\n" : "");
      const filtered = query.grep
        ? combined
            .split(/\r?\n/)
            .filter((line) => line.toLowerCase().includes(query.grep!.toLowerCase()))
            .join("\n")
        : combined;
      return [
        "# Log",
        "",
        `- **unit**: \`codex-feishu-bridge.service\``,
        `- **lines**: \`${query.limit}\``,
        ...(query.since ? [`- **since**: \`${query.since}\``] : []),
        ...(query.grep ? [`- **grep**: \`${query.grep}\``] : []),
        "",
        "```text",
        truncateOutput(filtered || "(no output)"),
        "```"
      ].join("\n");
    } catch (error) {
      const maybe = error as Error & { stdout?: string; stderr?: string; code?: number | string };
      const output = [maybe.stdout, maybe.stderr].filter(Boolean).join(maybe.stdout && maybe.stderr ? "\n" : "");
      return [
        "# Log",
        "",
        `- **unit**: \`codex-feishu-bridge.service\``,
        `- **status**: \`failed\``,
        `- **code**: \`${String(maybe.code ?? "(unknown)")}\``,
        "",
        "```text",
        truncateOutput(output || maybe.message || "journalctl failed"),
        "```"
      ].join("\n");
    }
  }

  private async runGitCommand(project: string, args: string[]): Promise<string | AppResponse> {
    const gitArgs = [...args];
    const commandText = ["git", ...gitArgs].join(" ");
    try {
      const { stdout, stderr } = await execFileAsync("git", gitArgs, {
        cwd: project,
        timeout: GIT_COMMAND_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024
      });
      const combined = [stdout, stderr].filter(Boolean).join(stderr && stdout ? "\n" : "");
      return [
        "# Git",
        "",
        `- **project**: \`${project}\``,
        `- **command**: \`${commandText}\``,
        "",
        "```text",
        truncateOutput(combined || "(no output)"),
        "```"
      ].join("\n");
    } catch (error) {
      const maybe = error as Error & {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        signal?: NodeJS.Signals;
      };
      const output = [maybe.stdout, maybe.stderr].filter(Boolean).join(maybe.stdout && maybe.stderr ? "\n" : "");
      return {
        severity: "warning",
        text: [
          "# Git",
          "",
          `- **project**: \`${project}\``,
          `- **command**: \`${commandText}\``,
          `- **status**: ⚠️ \`failed\``,
          `- **code**: \`${String(maybe.code ?? "(unknown)")}\``,
          ...(maybe.signal ? [`- **signal**: \`${maybe.signal}\``] : []),
          "",
          "```text",
          truncateOutput(output || maybe.message || "git command failed"),
          "```"
        ].join("\n")
      };
    }
  }

  private async runLocalCommand(
    command: "cat" | "find" | "head" | "ls" | "pwd" | "rg" | "sha256sum" | "tail" | "tree" | "wc",
    project: string,
    args: string[]
  ): Promise<string | AppResponse> {
    const commandText = [command, ...args].join(" ");
    const execArgs = [...args];
    try {
      const { stdout, stderr } = await execFileAsync(command, execArgs, {
        cwd: project,
        timeout: GIT_COMMAND_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024
      });
      const combined = [stdout, stderr].filter(Boolean).join(stderr && stdout ? "\n" : "");
      return [
        `# ${command.toUpperCase()}`,
        "",
        `- **project**: \`${project}\``,
        `- **command**: \`${commandText || command}\``,
        "",
        "```text",
        truncateOutput(combined || "(no output)"),
        "```"
      ].join("\n");
    } catch (error) {
      const maybe = error as Error & {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        signal?: NodeJS.Signals;
      };
      const output = [maybe.stdout, maybe.stderr].filter(Boolean).join(maybe.stdout && maybe.stderr ? "\n" : "");
      return {
        severity: "warning",
        text: [
          `# ${command.toUpperCase()}`,
          "",
          `- **project**: \`${project}\``,
          `- **command**: \`${commandText || command}\``,
          `- **status**: ⚠️ \`failed\``,
          `- **code**: \`${String(maybe.code ?? "(unknown)")}\``,
          ...(maybe.signal ? [`- **signal**: \`${maybe.signal}\``] : []),
          "",
          "```text",
          truncateOutput(output || maybe.message || `${command} command failed`),
          "```"
        ].join("\n")
      };
    }
  }
}

interface ProjectListEntry {
  project: string;
  name: string;
  bound: boolean;
  trusted: boolean;
  updatedAt?: string;
}

interface PendingApproval {
  title: string;
  label: string;
  prompt: string;
  parse: (text: string) => ParsedApprovalReply;
  timeoutResult: Record<string, unknown>;
  cancelResult: Record<string, unknown>;
  resolve?: (value: Record<string, unknown>) => void;
  timer?: NodeJS.Timeout;
}

interface ParsedApprovalReply {
  ok: boolean;
  result?: Record<string, unknown>;
  summary?: string;
  error?: string;
}

interface ChoiceReply {
  label: string;
  aliases: string[];
  result: Record<string, unknown>;
  hint?: string;
}

interface LogQuery {
  limit: number;
  since?: string;
  grep?: string;
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

function truncateOutput(value: string): string {
  if (value.length <= GIT_OUTPUT_SOFT_LIMIT) return value;
  return `${value.slice(0, GIT_OUTPUT_SOFT_LIMIT)}\n\n[output truncated]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asObjectRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

function normalizeApprovalReply(text: string): string {
  return text.trim().toLowerCase();
}

function matchesAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text === term || text.includes(term));
}

function parseNumberSelections(text: string): number[] {
  const matches = Array.from(text.matchAll(/\b\d+\b/g), (match) => Number(match[0]));
  return matches.filter((value) => Number.isInteger(value) && value > 0);
}

function parseChoiceReply(text: string, choices: ChoiceReply[]): ParsedApprovalReply {
  const normalized = normalizeApprovalReply(text);
  const numbers = parseNumberSelections(normalized);
  if (numbers.length > 0) {
    const selected = choices[numbers[0] - 1];
    if (!selected) {
      return { ok: false, error: `unknown choice index \`${numbers[0]}\`` };
    }
    return { ok: true, result: selected.result, summary: `\`${selected.label}\`` };
  }

  for (const choice of choices) {
    if (choice.aliases.some((alias) => normalized === alias || normalized.includes(alias))) {
      return { ok: true, result: choice.result, summary: `\`${choice.label}\`` };
    }
  }

  return { ok: false, error: "reply did not match any available choice" };
}

function parseToolInputReply(
  text: string,
  questions: Array<Record<string, unknown>>
): ParsedApprovalReply {
  if (questions.length === 0) {
    return { ok: true, result: { answers: {} }, summary: "`(empty)`" };
  }

  if (questions.length === 1) {
    const question = questions[0];
    const id = typeof question.id === "string" ? question.id : "q1";
    const answer = parseSingleQuestionAnswer(text, question);
    if (!answer.ok) return answer;
    return {
      ok: true,
      result: { answers: { [id]: { answers: answer.values } } },
      summary: `answered \`${id}\``
    };
  }

  const answers: Record<string, { answers: string[] }> = {};
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^([^=:#]+)\s*[:=]\s*(.+)$/);
    if (!match) continue;
    const key = match[1].trim();
    const rawValue = match[2].trim();
    const question =
      questions.find((item) => String(item.id || "") === key) ||
      questions[Number(key) - 1];
    if (!question) continue;
    const parsed = parseSingleQuestionAnswer(rawValue, question);
    if (!parsed.ok) return parsed;
    answers[String(question.id || key)] = { answers: parsed.values };
  }
  if (Object.keys(answers).length === 0) {
    return { ok: false, error: "reply using `question_id=value` lines for multi-question input" };
  }
  return { ok: true, result: { answers }, summary: `answered ${Object.keys(answers).length} question(s)` };
}

function parseSingleQuestionAnswer(
  text: string,
  question: Record<string, unknown>
): { ok: boolean; values: string[]; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, values: [], error: "empty answer" };
  }

  const options = Array.isArray(question.options)
    ? question.options.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
  if (options.length === 0) {
    return { ok: true, values: [trimmed] };
  }

  const numbers = parseNumberSelections(trimmed);
  const selectedByIndex = numbers
    .map((value) => options[value - 1])
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => String(item.label || "").trim())
    .filter(Boolean);
  if (selectedByIndex.length > 0) {
    return { ok: true, values: selectedByIndex };
  }

  const normalized = normalizeApprovalReply(trimmed);
  const selectedByLabel = options
    .map((item) => String(item.label || "").trim())
    .filter(Boolean)
    .filter((label) => normalized.includes(label.toLowerCase()));
  if (selectedByLabel.length > 0) {
    return { ok: true, values: selectedByLabel };
  }

  return { ok: true, values: [trimmed] };
}
