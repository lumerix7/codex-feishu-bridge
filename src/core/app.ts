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

export class App {
  private readonly store: BindingStore;
  private readonly codex: CodexBackend;
  private feishu?: FeishuGateway;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();

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
        const messageTitle = this.titleForCommand(command?.name);
        const messageTemplate = this.templateForCommand(command?.name);
        const messageFooter = this.footerForMessage(command?.name, currentBinding);
        const formatForFeishu = (text: string): string =>
          command?.name ? this.stripLeadingMarkdownHeading(text) : text;
        try {
          let streamed = false;
          let lastUpdateText: string | undefined;
          const sendUpdateSafely = async (update: string): Promise<void> => {
            try {
              const latestBinding =
                (await this.store.get(conversationKeyFor(message))) || currentBinding;
              await this.feishu?.send({
                chatId: message.chatId,
                title: messageTitle,
                template: messageTemplate,
                footer: command?.name
                  ? this.footerForMessage(command?.name, latestBinding)
                  : this.footerForCodexReply(latestBinding),
                text: formatForFeishu(update),
                replyToMessageId: message.messageId,
                threadId: message.threadId
              });
              streamed = true;
              lastUpdateText = formatForFeishu(update);
            } catch (error) {
              console.error("failed to send Feishu update", {
                messageId: message.messageId,
                chatId: message.chatId,
                threadId: message.threadId,
                textPreview: this.previewText(update),
                error
              });
            }
          };

          const text = await this.handleIncoming(message, sendUpdateSafely);
          const formattedText = formatForFeishu(text);
          if ((formattedText && formattedText !== lastUpdateText) || !streamed) {
            const latestBinding =
              (await this.store.get(conversationKeyFor(message))) || currentBinding;
            const finalFooter = command?.name
              ? this.footerForMessage(command?.name, latestBinding)
              : this.footerForCodexReply(latestBinding);
            await this.feishu?.send({
              chatId: message.chatId,
              title: messageTitle,
              template: messageTemplate,
              footer: finalFooter,
              text: formattedText,
              replyToMessageId: message.messageId,
              threadId: message.threadId
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
    onUpdate?: (text: string) => Promise<void>
  ): Promise<string> {
    if (message.chatType !== "p2p") {
      return "Only direct messages are supported right now.";
    }

    const command = parseCommand(message);
    if (command?.name === "help") {
      return [
        "# Bridge Help",
        "",
        "- `/help` show commands",
        "- `/status` show current session and run state",
        "- `/new` create and bind a fresh Codex session",
        "- `/session [list [-n N|--all] [--all-projects] [--project <path>]|-h|--help]` show the current bound session, list recent sessions, or show session help",
        "- `/resume [--last|<session-id>|-n N|-h|--all] [--all-projects] [--project <path>] [-C|--cd <dir>]` bind the latest session by default, optionally switching project",
        "- `/stop` stop the current active run",
        "- `/project [list [--all|--trusted]|bind [-n N|-m|--mkdir <path>|<path>]|-h]` show, list, or bind projects",
        "- `/git [args...]` run `git` in the current bound project; use `/git -h` for bridge usage",
        "- `/log [-n N] [--since <expr>] [--grep <text>] [-h|--help]` show recent bridge service logs from systemd journal",
        "- `/pwd`, `/ls [args...]`, `/cat <path...>`, `/tree [args...]`, `/find [args...]`, `/rg [args...]` run local project commands",
        "- `/approvals [...]` show or change Codex approvals for the active backend",
        "- `/search [on|off]` show or change live web search for this conversation",
        "- `/model [name|clear]` show or change the Codex model for this conversation",
        "- `/profile [name|clear]` show or change the Codex profile for this conversation"
      ].join("\n");
    }

    const key = conversationKeyFor(message);
    const existing = await this.store.get(key);
    const activeRun = this.activeRuns.get(key);
    let sentEarlyUpdate = false;
    const sendEarlyUpdate = async (text: string): Promise<void> => {
      if (!onUpdate || sentEarlyUpdate) return;
      sentEarlyUpdate = true;
      await onUpdate(text);
    };

    if (command?.name === "status") {
      const project = existing?.project || this.config.project.defaultProject;
      const sessionId = existing?.codexSessionId || "(none)";
      const session =
        existing?.codexSessionId
          ? await getSessionSummary(this.config.codex.sessionsDir, existing.codexSessionId)
          : undefined;
      const trustedProjects = await this.listTrustedProjects();
      const runtimeMeta = await getCodexRuntimeMeta(this.config.codex.home);
      const agentsPath = path.join(project, "AGENTS.md");
      const hasAgents = await fs
        .stat(agentsPath)
        .then((stats) => stats.isFile())
        .catch(() => false);
      return [
        "# Bridge Status",
        "",
        `- **conversation**: \`${key}\``,
        `- **session**: \`${sessionId}\``,
        `- **project**: \`${project}\``,
        `- **trusted**: \`${trustedProjects.includes(project) ? "yes" : "no"}\``,
        `- **backend**: \`${this.codex.mode}\``,
        `- **codex**: \`${runtimeMeta.version || "(unknown)"}\``,
        `- **sandbox**: \`${this.config.codex.sandboxMode}\``,
        `- **auth**: \`${runtimeMeta.authMode || "(unknown)"}\``,
        `- **agents.md**: \`${hasAgents ? agentsPath : "<none>"}\``,
        `- **search**: \`${existing?.searchEnabled ? "on" : "off"}\``,
        `- **model**: \`${existing?.model || "(default)"}\``,
        `- **profile**: \`${existing?.profile || "(default)"}\``,
        `- **run**: \`${activeRun ? `${activeRun.status}:${activeRun.runId}` : "idle"}\``,
        `- **session time**: ${session?.createdAt || "(unknown)"}`,
        `- **session cwd**: \`${session?.cwd || "(unknown)"}\``,
        `- **session about**: ${session?.preview || "(no preview)"}`
      ].join("\n");
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
      const resumeArgs = [...command.args];
      const cdIndex = resumeArgs.findIndex((arg) => arg === "-C" || arg === "--cd");
      let resumeProject = existing?.project || this.config.project.defaultProject;
      let projectExplicitlySelected = false;
      if (cdIndex >= 0) {
        const requestedProject = resumeArgs[cdIndex + 1];
        if (!requestedProject) {
          return "Usage: `/resume ... [-C|--cd <dir>]`";
        }
        resumeProject = await this.resolveProject(
          requestedProject,
          existing?.project || this.config.project.defaultProject
        );
        projectExplicitlySelected = true;
        resumeArgs.splice(cdIndex, 2);
      }

      const allProjects = this.consumeFlag(resumeArgs, "--all-projects");
      const projectScopeArg = this.consumeOptionValue(resumeArgs, "--project");
      if (projectScopeArg === "") {
        return "Usage: `/resume ... [--project <path>]`";
      }
      if (projectScopeArg) {
        const scopedProject = await this.resolveProject(projectScopeArg, resumeProject);
        if (projectExplicitlySelected && scopedProject !== resumeProject) {
          return "Cannot use different project paths for `--project <path>` and `-C|--cd <dir>`.";
        }
        resumeProject = scopedProject;
        projectExplicitlySelected = true;
      }
      if (resumeArgs[0] === "-h" || resumeArgs[0] === "--help") {
        return this.resumeHelpText();
      }
      if (resumeArgs[0] === "--last") {
        resumeArgs.shift();
      }
      if (resumeArgs[0] === "--all") {
        const sessions = await this.listScopedSessions(
          this.config.codex.sessionAllDefaultCount,
          resumeProject,
          allProjects
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
          existing?.codexSessionId
        );
      }
      if ((resumeArgs[0] || "").startsWith("-") && resumeArgs[0] !== "-n") {
        return [
          "# Resume",
          "",
          `- **error**: unsupported bridge option \`${resumeArgs[0]}\``,
          "- **supported**: `/resume`, `/resume --last`, `/resume -n N`, `/resume <session-id>`, `/resume --all`, `/resume --all-projects`, `/resume --project <path>`, `/resume -h`, `/resume ... -C <dir>`",
          "- Use a normal follow-up message after `/resume ...` if you want to continue the bound session."
        ].join("\n");
      }

      let targetSessionId =
        resumeArgs[0] ||
        (await this.findMostRecentSessionId(
          resumeProject,
          projectExplicitlySelected ? false : allProjects
        )) ||
        existing?.codexSessionId;
      let resumeSource = resumeArgs[0] ? "explicit" : "latest";
      let resumeWarning: string | undefined;
      let resumeIndex: number | undefined;

      if (resumeArgs[0] === "-n") {
        const index = Number(resumeArgs[1] || "");
        if (!Number.isInteger(index) || index < 1) {
          return "Usage: `/resume -n <index>` where `<index>` is an integer >= 1.";
        }
        const sessions = await this.listScopedSessions(
          Math.min(index, this.config.codex.sessionAllDefaultCount),
          resumeProject,
          allProjects
        );
        const selected = sessions[index - 1];
        if (!selected) {
          return `session index out of range: ${index}. Use \`/session list${allProjects ? " --all-projects" : ""}${projectExplicitlySelected ? ` --project ${resumeProject}` : ""} --all\` first.`;
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
      await sendEarlyUpdate(`resolving session ${targetSessionId} for project \`${resumeProject}\`...`);
      const sessionExists = await this.codex.getSession(targetSessionId);
      if (!sessionExists) {
        return `session not found: ${targetSessionId}`;
      }
      const session = await getSessionSummary(this.config.codex.sessionsDir, targetSessionId);
      const binding = this.makeBinding(
        key,
        targetSessionId,
        resumeProject,
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
        `- **time**: ${session?.createdAt || "(unknown)"}`,
        `- **cwd**: \`${session?.cwd || "(unknown)"}\``,
        `- **about**: ${session?.preview || "(no preview)"}`,
        ...(resumeWarning ? [`- **warning**: ${resumeWarning}`] : [])
      ].join("\n");
    }

    if (command?.name === "session") {
      const sessionArgs = [...command.args];
      const allProjects = this.consumeFlag(sessionArgs, "--all-projects");
      const currentProject = existing?.project || this.config.project.defaultProject;
      const projectScopeArg = this.consumeOptionValue(sessionArgs, "--project");
      if (projectScopeArg === "") {
        return "Usage: `/session [list ...] [--project <path>]`";
      }
      if (sessionArgs[0] === "-h" || sessionArgs[0] === "--help") {
        return this.sessionsHelpText();
      }
      const isLegacyNumericList = sessionArgs.length === 1 && /^\d+$/.test(sessionArgs[0] || "");
      const isList = sessionArgs[0] === "list" || isLegacyNumericList;
      if (isList) {
        const listArgs = sessionArgs[0] === "list" ? sessionArgs.slice(1) : sessionArgs;
        const limit = this.parseSessionsListLimit(listArgs);
        const scopedProject = projectScopeArg
          ? await this.resolveProject(projectScopeArg, currentProject)
          : currentProject;
        const sessions = await this.listScopedSessions(limit, scopedProject, allProjects);
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
          existing?.codexSessionId
        );
      }

      if (!existing?.codexSessionId) {
        return "No session is currently bound. Use `/new`, `/resume`, or `/session list`.";
      }
      const session = await getSessionSummary(this.config.codex.sessionsDir, existing.codexSessionId);
      return [
        "# Current Session",
        "",
        `- **session**: \`${existing.codexSessionId}\``,
        `- **project**: \`${existing.project || this.config.project.defaultProject}\``,
        `- **time**: ${session?.createdAt || "(unknown)"}`,
        `- **cwd**: \`${session?.cwd || "(unknown)"}\``,
        `- **about**: ${session?.preview || "(no preview)"}`
      ].join("\n");
    }

    const binding = existing;
    if (command?.name === "new") {
      if (activeRun) {
        return `Cannot create a new session while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      const project = binding?.project || this.config.project.defaultProject;
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
      const currentProject = binding?.project || this.config.project.defaultProject;
      const trustedProjects = await this.listTrustedProjects();
      if (command.args[0] === "-h" || command.args[0] === "--help") {
        return this.projectHelpText();
      }
      if (command.args.length === 0) {
        return [
          "# Project",
          "",
          `- **project**: \`${currentProject}\``,
          `- **trusted**: \`${trustedProjects.includes(currentProject) ? "yes" : "no"}\``,
          `- **allowed roots**: ${this.config.project.allowedRoots.map((root) => `\`${root}\``).join(", ")}`
        ].join("\n");
      }

      if (command.args[0] === "list") {
        const mode = command.args.includes("--trusted")
          ? "trusted"
          : command.args.includes("--all")
            ? "all"
            : "default";
        const projects = await this.listProjects(mode, currentProject, trustedProjects);
        if (projects.length === 0) {
          return "# Projects\n\n- No projects found.";
        }
        return this.renderProjectList("Projects", projects, currentProject);
      }

      if (command.args[0] !== "bind") {
        return this.projectHelpText();
      }
      if (activeRun) {
        return `Cannot change project while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }

      const bindArgs = command.args.slice(1);
      const mkdirIndex = bindArgs.findIndex((arg) => arg === "-m" || arg === "--mkdir");
      const createMissing = mkdirIndex >= 0;
      const projectArgs = [...bindArgs];
      if (mkdirIndex >= 0) {
        projectArgs.splice(mkdirIndex, 1);
      }

      let project: string | undefined;
      let bindWarning: string | undefined;
      if (projectArgs[0] === "-n") {
        const index = Number(projectArgs[1] || "");
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
        const requested = projectArgs.join(" ").trim();
        if (!requested) {
          return this.projectHelpText();
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
      if (command.args[0] === "-h" || command.args[0] === "--help") {
        return this.logHelpText();
      }
      const query = this.parseLogQuery(command.args);
      if (query instanceof Error) {
        return `# Log\n\n- **error**: ${query.message}\n- **usage**: \`/log [-n N] [--since <expr>] [--grep <text>]\``;
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
      if (command.args.length === 0 || command.args[0] === "-h" || command.args[0] === "--help") {
        return this.gitHelpText();
      }
      await sendEarlyUpdate(`running git in project \`${project}\`...`);
      return this.runGitCommand(project, command.args);
    }

    if (
      command?.name === "pwd" ||
      command?.name === "ls" ||
      command?.name === "cat" ||
      command?.name === "tree" ||
      command?.name === "find" ||
      command?.name === "rg"
    ) {
      const localCommandName = command.name;
      const project = binding?.project || this.config.project.defaultProject;
      if (localCommandName !== "pwd" && (command.args[0] === "-h" || command.args[0] === "--help")) {
        return this.localCommandHelpText(localCommandName);
      }
      await sendEarlyUpdate(`running ${localCommandName} in project \`${project}\`...`);
      return this.runLocalCommand(localCommandName, project, command.args);
    }

    if (command?.name === "approvals") {
      if (command.args[0] === "-h" || command.args[0] === "--help") {
        return this.approvalsHelpText();
      }
      if (command.args.length === 0) {
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
      const nextMode = this.parseApprovalMode(command.args.join(" "));
      if (!nextMode) {
        return [
          "# Approvals",
          "",
          `- **error**: unknown mode \`${command.args.join(" ")}\``,
          `- **choices**: ${this.approvalChoicesText()}`
        ].join("\n");
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
      const enabled = binding?.searchEnabled ?? this.config.project.defaultSearchEnabled;
      if (command.args.length === 0) {
        return `# Search\n\n- **mode**: \`${enabled ? "on" : "off"}\``;
      }
      if (activeRun) {
        return `Cannot change search while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      const normalized = command.args[0]?.toLowerCase();
      if (!["on", "off"].includes(normalized || "")) {
        return "# Search\n\n- **usage**: `/search [on|off]`";
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
      const current = binding?.model || "(default)";
      if (command.args.length === 0) {
        return `# Model\n\n- **model**: \`${current}\``;
      }
      if (activeRun) {
        return `Cannot change model while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      const nextValue = command.args.join(" ").trim();
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
      const current = binding?.profile || "(default)";
      if (command.args.length === 0) {
        return `# Profile\n\n- **profile**: \`${current}\``;
      }
      if (activeRun) {
        return `Cannot change profile while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      const nextValue = command.args.join(" ").trim();
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
    await sendEarlyUpdate(`sending prompt to Codex for project \`${project}\`...`);
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
          onStatus: onUpdate,
          onUpdate,
          onServerRequest: (request) =>
            this.requestApprovalFromFeishu(
              key,
              message,
              project,
              request,
              onUpdate
            )
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
        this.buildIsoFooter()
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
    return [
      `# ${title}`,
      "",
      `- **backend**: \`${this.codex.mode}\``,
      `- **profile**: \`${this.config.codex.profileMode}\``,
      `- **default project**: \`${this.config.project.defaultProject}\``,
      ...(currentProject ? [`- **current project**: \`${currentProject}\``] : []),
      `- **sandbox**: \`${this.config.codex.sandboxMode}\``,
      `- **search default**: \`${this.config.project.defaultSearchEnabled ? "on" : "off"}\``
    ].join("\n");
  }

  private titleForCommand(commandName?: string): string {
    switch (commandName) {
      case "help":
        return "Bridge Help";
      case "status":
        return "Bridge Status";
      case "new":
        return "New Session";
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

  private templateForCommand(commandName?: string): OutgoingMessage["template"] {
    if (!commandName) {
      return "blue";
    }
    switch (commandName) {
      case "help":
      case "status":
      case "session":
      case "project":
      case "approvals":
      case "log":
      case "search":
      case "model":
      case "profile":
        return "indigo";
      case "new":
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

  private footerForMessage(commandName: string | undefined, binding?: SessionBinding): string | undefined {
    if (!commandName) return undefined;
    const project = binding?.project || this.config.project.defaultProject;
    return `${this.buildIsoFooter()}  |  project: \`${path.basename(project) || project}\``;
  }

  private footerForCodexReply(binding?: SessionBinding): string {
    const parts = [this.buildIsoFooter()];
    if (binding?.codexSessionId) {
      parts.push(`session: \`${binding.codexSessionId}\``);
    }
    const project = binding?.project || this.config.project.defaultProject;
    parts.push(`project: \`${path.basename(project) || project}\``);
    return parts.join("  |  ");
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
    createMissing = false
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

    let stats = await fs.stat(resolved).catch(() => null);
    if (!stats && createMissing) {
      await fs.mkdir(resolved, { recursive: true });
      stats = await fs.stat(resolved).catch(() => null);
    }
    if (!stats?.isDirectory()) {
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
      "- `/approvals`",
      ...(this.codex.mode === "app-server"
        ? ["- `/approvals default`", "- `/approvals full-access`"]
        : ["- `/approvals auto`", "- `/approvals workspace`", "- `/approvals full-access`"]),
      "- `/approvals -h`",
      "",
      "## Notes",
      "",
      ...(this.codex.mode === "app-server"
        ? [
            "- In `app-server`, `auto` is still accepted as a compatibility alias for `default`, but is not advertised.",
            "- `default` uses `approvalPolicy=on-request` with `sandbox=workspace-write`.",
            "- `full-access` uses `approvalPolicy=never` with `sandbox=danger-full-access`."
          ]
        : [
            "- In `spawn`, `auto` maps to `workspace`.",
            "- `workspace` uses Codex `--full-auto`.",
            "- `full-access` uses Codex `--dangerously-bypass-approvals-and-sandbox`."
          ])
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

  private readString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
    const sessions = await this.listScopedSessions(1, project, allProjects);
    return sessions[0]?.sessionId;
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
        bound: true,
        trusted: trusted.includes(binding.project),
        updatedAt: binding.updatedAt
      }));

    const trustedOnly: ProjectListEntry[] = trusted
      .filter((project) => !seen.has(project))
      .map((project) => ({
        project,
        bound: false,
        trusted: true
      }));

    const currentEntry: ProjectListEntry = {
      project: currentProject,
      bound: Boolean(bindings.find((binding) => binding.project === currentProject)),
      trusted: trusted.includes(currentProject),
      updatedAt: bindings.find((binding) => binding.project === currentProject)?.updatedAt
    };

    if (mode === "trusted") {
      const trustedList = [...boundProjects.filter((item) => item.trusted), ...trustedOnly];
      if (!trustedList.find((item) => item.project === currentProject) && currentEntry.trusted) {
        trustedList.unshift(currentEntry);
      }
      return trustedList;
    }

    const defaultList = [...boundProjects];
    if (!defaultList.find((item) => item.project === currentProject) && this.isAllowedProject(currentProject)) {
      defaultList.unshift(currentEntry);
    }
    if (mode === "default") {
      return defaultList;
    }
    return [...defaultList, ...trustedOnly];
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
      "- `/project`",
      "- `/project list`",
      "- `/project list --all`",
      "- `/project list --trusted`",
      "- `/project bind <path>`",
      "- `/project bind -m <path>`",
      "- `/project bind -n 3`",
      "- `/project -h`",
      "",
      "## Notes",
      "",
      "- `/project list` shows the normal project list used by `/project bind -n N`.",
      "- `/project list --all` includes trusted Codex projects that are not currently bound in the bridge store.",
      "- `/project list --trusted` shows trusted Codex projects from `config.toml` under the allowed roots.",
      "- `/project bind -n <index>` uses the current `/project list` ordering.",
      `- **allowed roots**: ${this.config.project.allowedRoots.map((root) => `\`${root}\``).join(", ")}`,
      "- Missing projects are rejected unless you use `-m` or `--mkdir`."
    ].join("\n");
  }

  private gitHelpText(): string {
    return [
      "# Git",
      "",
      "Run `git` directly in the current bound project.",
      "",
      "## Usage",
      "",
      "- `/git status`",
      "- `/git branch --all`",
      "- `/git log --oneline -n 20`",
      "- `/git diff`",
      "- `/git diff --cached`",
      "- `/git show HEAD~1`",
      "- `/git add <path>`",
      "- `/git commit -m message`",
      "- `/git push`",
      "- `/git -h`",
      "",
      "## Notes",
      "",
      "- The command runs in the current bound project from `/project`.",
      "- Arguments are passed directly to `git` after `/git`.",
      "- Chat parsing is whitespace-based, so shell quoting is limited."
    ].join("\n");
  }

  private localCommandHelpText(name: "pwd" | "ls" | "cat" | "tree" | "find" | "rg"): string {
    const examples: Record<typeof name, string[]> = {
      pwd: ["- `/pwd`"],
      ls: ["- `/ls`", "- `/ls -la`", "- `/ls src`"],
      cat: ["- `/cat README.md`", "- `/cat src/core/app.ts`"],
      tree: ["- `/tree`", "- `/tree -L 2`", "- `/tree src`"],
      find: ["- `/find . -maxdepth 2 -type f`", "- `/find src -name '*.ts'`"],
      rg: ["- `/rg TODO`", "- `/rg handleIncoming src`", "- `/rg --files src`"]
    };
    return [
      `# ${name.toUpperCase()}`,
      "",
      `Run \`${name}\` directly in the current bound project.`,
      "",
      "## Usage",
      "",
      ...examples[name],
      "",
      "## Notes",
      "",
      "- Arguments are passed directly without a shell.",
      "- Redirection and shell operators like `>`, `|`, `&&`, and `;` are not interpreted."
    ].join("\n");
  }

  private resumeHelpText(): string {
    return [
      "# Resume",
      "",
      "Resume a previous session.",
      "",
      "## Usage",
      "",
      "- `/resume`",
      "- `/resume --last`",
      "- `/resume -n 3`",
      "- `/resume <session-id>`",
      "- `/resume --all-projects`",
      "- `/resume --project /path/to/project`",
      "- `/resume --all --project /path/to/project`",
      "- `/resume --last -C subdir`",
      "- `/resume -h`",
      "- `/resume --all`",
      "",
      "## Notes",
      "",
      "- `/resume` and `/resume --last` both bind the most recent recorded native Codex session for the current project.",
      "- `/resume -n <index>` binds the Nth session from the current `/session list` ordering.",
      "- `/resume <session-id>` binds a specific native session id.",
      "- `-C, --cd <dir>` switches the bound project while resuming the session.",
      "- `--all-projects` expands browsing beyond the current project.",
      "- `--project <path>` scopes browsing and latest-session lookup to that specific project path.",
      "- `/resume --all` shows the recent sessions list for the current project in Feishu instead of opening an interactive picker.",
      `- In Feishu, use \`/session list --all\` for the default current-project list of \`${this.config.codex.sessionAllDefaultCount}\` sessions, or \`/session list --all --all-projects\` to browse across projects.`,
      "- Index-based resume is order-dependent and should be treated as a convenience, not a stable identifier.",
      "- Native Codex flags like `--config`, `--remote`, `--image`, `--model`, `--sandbox`, and prompt arguments are not exposed on this bridge command."
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
      "- `/session`",
      "- `/session list`",
      "- `/session list -n 12`",
      "- `/session list --all`",
      "- `/session list --all-projects`",
      "- `/session list --project /path/to/project`",
      "- `/session list --all --project /path/to/project`",
      "- `/session -h`",
      "",
      "## Notes",
      "",
      "- `/session` shows the current bound session for this conversation.",
      "- `/session list` shows recent native Codex sessions for the current project.",
      "- `--all-projects` expands the list across `CODEX_SESSIONS_DIR`.",
      "- `--project <path>` filters the list to that specific project path.",
      `- \`/session list\` defaults to \`${this.config.codex.sessionListDefaultCount}\` sessions for the current project.`,
      `- \`/session list --all\` uses the default count \`${this.config.codex.sessionAllDefaultCount}\` for the current project.`,
      `- \`-n\` accepts values from \`1\` to \`${this.config.codex.sessionAllDefaultCount}\`.`,
      "- Use `/resume <session-id>` to bind one of the listed sessions."
    ].join("\n");
  }

  private parseSessionsListLimit(args: string[]): number {
    if (args[0] === "--all") {
      return this.config.codex.sessionAllDefaultCount;
    }
    if (args.length === 1 && /^\d+$/.test(args[0] || "")) {
      return Math.min(
        this.config.codex.sessionListDefaultCount,
        Math.max(1, Number(args[0]) || this.config.codex.sessionListDefaultCount)
      );
    }
    const flagIndex = args.findIndex((arg) => arg === "-n" || arg === "--count");
    const raw = flagIndex >= 0 ? args[flagIndex + 1] : undefined;
    return Math.min(
      this.config.codex.sessionListDefaultCount,
      Math.max(1, Number(raw || String(this.config.codex.sessionListDefaultCount)) || this.config.codex.sessionListDefaultCount)
    );
  }

  private consumeFlag(args: string[], flag: string): boolean {
    const index = args.indexOf(flag);
    if (index < 0) return false;
    args.splice(index, 1);
    return true;
  }

  private consumeOptionValue(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    const value = args[index + 1];
    args.splice(index, value ? 2 : 1);
    if (!value || value.startsWith("-")) {
      return "";
    }
    return value;
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
    sessions: Awaited<ReturnType<typeof listRecentSessions>>,
    boundSessionId?: string
  ): string {
    const lines = [`# ${title}`, "", "- sorted by: `time desc`", ""];
    for (const [index, session] of sessions.entries()) {
      const flags = [session.sessionId === boundSessionId ? "bound" : ""].filter(Boolean);
      lines.push(
        `${index + 1}. \`${session.sessionId}\`${flags.length ? ` (${flags.join(", ")})` : ""}`
      );
      lines.push(`   - project: \`${escapeMarkdownCell(session.cwd || "(unknown)")}\``);
      lines.push(`   - time: ${escapeMarkdownCell(session.createdAt || "(unknown)")}`);
      lines.push(`   - about: ${escapeMarkdownCell(session.preview || "(no preview)")}`);
    }
    return lines.join("\n");
  }

  private renderProjectList(
    title: string,
    projects: ProjectListEntry[],
    currentProject: string
  ): string {
    const lines = [`# ${title}`, ""];
    for (const [index, item] of projects.entries()) {
      const flags = [
        item.project === currentProject ? "current" : "",
        item.bound ? "bound" : "",
        item.trusted ? "trusted" : ""
      ].filter(Boolean);
      lines.push(`${index + 1}. \`${item.project}\`${flags.length ? ` (${flags.join(", ")})` : ""}`);
      if (item.updatedAt) {
        lines.push(`   - updated: ${item.updatedAt}`);
      }
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
      "- `/log`",
      "- `/log -n 50`",
      "- `/log --since 30m`",
      "- `/log --since today --grep reconnect`",
      "- `/log -h`",
      "",
      "## Notes",
      "",
      "- Default tail is `200` lines.",
      "- `-n` accepts values from `1` to `2000`.",
      "- `--since` accepts multi-word values like `30 minutes ago`, plus compact forms like `30m`, `2h`, and `1d`.",
      "- `--grep` filters the fetched journal output case-insensitively."
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

  private async runGitCommand(project: string, args: string[]): Promise<string> {
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
      return [
        "# Git",
        "",
        `- **project**: \`${project}\``,
        `- **command**: \`${commandText}\``,
        `- **status**: \`failed\``,
        `- **code**: \`${String(maybe.code ?? "(unknown)")}\``,
        ...(maybe.signal ? [`- **signal**: \`${maybe.signal}\``] : []),
        "",
        "```text",
        truncateOutput(output || maybe.message || "git command failed"),
        "```"
      ].join("\n");
    }
  }

  private async runLocalCommand(
    command: "pwd" | "ls" | "cat" | "tree" | "find" | "rg",
    project: string,
    args: string[]
  ): Promise<string> {
    const commandText = [command, ...args].join(" ");
    const execArgs = command === "pwd" ? [] : [...args];
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
      return [
        `# ${command.toUpperCase()}`,
        "",
        `- **project**: \`${project}\``,
        `- **command**: \`${commandText || command}\``,
        `- **status**: \`failed\``,
        `- **code**: \`${String(maybe.code ?? "(unknown)")}\``,
        ...(maybe.signal ? [`- **signal**: \`${maybe.signal}\``] : []),
        "",
        "```text",
        truncateOutput(output || maybe.message || `${command} command failed`),
        "```"
      ].join("\n");
    }
  }
}

interface ProjectListEntry {
  project: string;
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
