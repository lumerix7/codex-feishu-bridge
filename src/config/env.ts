import { config as loadEnv } from "dotenv";
import fs from "node:fs";
import path from "node:path";

if (!process.env.FEISHU_APP_ID) {
  loadEnv();
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export interface AppConfig {
  port: number;
  logLevel: string;
  nodeEnv: string;
  configPath?: string;
  feishu: {
    appId: string;
    appSecret: string;
    botOpenId: string;
    startupNotifyChatId?: string;
    connectionMode: "websocket";
    wsAutoReconnect: boolean;
    wsLoggerLevel: "error" | "warn" | "info" | "debug" | "trace";
    wsAgentKeepAliveMsecs: number;
    wsAgentMaxSockets: number;
    wsAgentMaxFreeSockets: number;
    wsConnectWarnAfterMs: number;
    wsReconnectWarnThreshold: number;
    reconnectReadyDebounceMs: number;
    sendRetryMaxAttempts: number;
    sendRetryBaseDelayMs: number;
    sendRetryMultiplier: number;
    sendRetryMaxDelayMs: number;
    titleMaxLength: number;
  };
  codex: {
    bin: string;
    home: string;
    sessionsDir: string;
    profileMode: "isolated" | "personal";
    backendMode: "spawn" | "terminal" | "app-server";
    outputSoftLimit: number;
    modelListMaxCount: number;
    appServerSidebandCards: boolean;
    appServerInlineBlocks: "off" | "compact" | "full";
    sandboxMode: "default" | "workspace-write" | "danger-full-access";
    sessionListDefaultCount: number;
    sessionAllDefaultCount: number;
    resumeReplayCount: number;
    runTimeoutMs: number;
    approvalTimeoutMs: number;
    compactTimeoutMs: number;
    spawnStatusIntervalMs: number;
    statusIncludeProject: boolean;
    terminalRenderMode: "markdown" | "plain";
    terminalFlushIdleMs: number;
    terminalFlushMaxChars: number;
    terminalStartupTimeoutMs: number;
  };
  project: {
    allowedRoots: string[];
    defaultProject: string;
    defaultSearchEnabled: boolean;
  };
  storePath: string;
}

interface JsonConfigShape {
  __path?: string;
  app?: {
    port?: unknown;
    logLevel?: unknown;
  };
  feishu?: {
    wsAutoReconnect?: unknown;
    wsLoggerLevel?: unknown;
    wsAgent?: {
      keepAliveMsecs?: unknown;
      maxSockets?: unknown;
      maxFreeSockets?: unknown;
    };
    wsConnectWarnAfterMs?: unknown;
    wsReconnectWarnThreshold?: unknown;
    reconnectReadyDebounceMs?: unknown;
    sendRetry?: {
      maxAttempts?: unknown;
      baseDelayMs?: unknown;
      multiplier?: unknown;
      maxDelayMs?: unknown;
    };
    titleMaxLength?: unknown;
  };
  codex?: {
    bin?: unknown;
    home?: unknown;
    sessionsDir?: unknown;
    profileMode?: unknown;
    backendMode?: unknown;
    outputSoftLimit?: unknown;
    modelListMaxCount?: unknown;
    appServer?: {
      sidebandCards?: unknown;
      inlineBlocks?: unknown;
    };
    sandboxMode?: unknown;
    runTimeoutMs?: unknown;
    approvalTimeoutMs?: unknown;
    compactTimeoutMs?: unknown;
    spawn?: {
      statusIntervalMs?: unknown;
    };
    terminal?: {
      renderMode?: unknown;
      flushIdleMs?: unknown;
      flushMaxChars?: unknown;
      startupTimeoutMs?: unknown;
    };
  };
  session?: {
    listDefaultCount?: unknown;
    allDefaultCount?: unknown;
    resumeReplayCount?: unknown;
  };
  project?: {
    allowedRoots?: unknown;
    defaultPath?: unknown;
    defaultSearchEnabled?: unknown;
  };
  status?: {
    includeProject?: unknown;
  };
  paths?: {
    storePath?: unknown;
  };
  [key: string]: unknown;
}

export function loadConfig(): AppConfig {
  const jsonConfig = loadJsonConfig(process.env.BRIDGE_CONFIG_JSON);
  const nodeEnv = optional("NODE_ENV", "development");
  const defaultProject = path.resolve(
    readTextSetting("DEFAULT_PROJECT", process.cwd(), jsonConfig, ["project", "defaultPath"])
  );
  const projectAllowedRoots = readRootsSetting(
    "PROJECT_ALLOWED_ROOTS",
    jsonConfig,
    ["project", "allowedRoots"],
    defaultProject
  );
  if (!isUnderAnyRoot(defaultProject, projectAllowedRoots)) {
    throw new Error(
      `project.defaultPath must stay under project.allowedRoots: ${defaultProject}`
    );
  }

  const homeDir = process.env.HOME || "/tmp";
  const codexProfileMode =
    readTextSetting(
      "CODEX_PROFILE_MODE",
      nodeEnv === "development" ? "isolated" : "personal",
      jsonConfig,
      ["codex", "profileMode"]
    ) ===
    "personal"
      ? "personal"
      : "isolated";
  const defaultCodexHome =
    codexProfileMode === "personal"
      ? path.join(homeDir, ".codex")
      : path.join(
          homeDir,
          nodeEnv === "development" ? ".codex-feishu-bridge-dev" : ".codex-feishu-bridge"
        );

  const codexBackendMode = readTextSetting("CODEX_BACKEND_MODE", "spawn", jsonConfig, [
    "codex",
    "backendMode"
  ]);
  return {
    configPath: jsonConfig?.__path,
    nodeEnv,
    port: readIntegerSetting("PORT", 3300, jsonConfig, ["app", "port"], { min: 1 }),
    logLevel: readTextSetting("LOG_LEVEL", "info", jsonConfig, ["app", "logLevel"]),
    feishu: {
      appId: required("FEISHU_APP_ID"),
      appSecret: required("FEISHU_APP_SECRET"),
      botOpenId: required("FEISHU_BOT_OPEN_ID"),
      startupNotifyChatId: optional("FEISHU_STARTUP_NOTIFY_CHAT_ID", "").trim() || undefined,
      connectionMode: "websocket",
      wsAutoReconnect: readBooleanSetting(
        "FEISHU_WS_AUTO_RECONNECT",
        true,
        jsonConfig,
        ["feishu", "wsAutoReconnect"]
      ),
      wsLoggerLevel: normalizeFeishuLoggerLevel(
        readTextSetting("FEISHU_WS_LOGGER_LEVEL", "debug", jsonConfig, ["feishu", "wsLoggerLevel"])
      ),
      wsAgentKeepAliveMsecs: readIntegerSetting(
        "FEISHU_WS_AGENT_KEEP_ALIVE_MSECS",
        60000,
        jsonConfig,
        ["feishu", "wsAgent", "keepAliveMsecs"],
        { min: 1 }
      ),
      wsAgentMaxSockets: readIntegerSetting(
        "FEISHU_WS_AGENT_MAX_SOCKETS",
        100,
        jsonConfig,
        ["feishu", "wsAgent", "maxSockets"],
        { min: 1 }
      ),
      wsAgentMaxFreeSockets: readIntegerSetting(
        "FEISHU_WS_AGENT_MAX_FREE_SOCKETS",
        20,
        jsonConfig,
        ["feishu", "wsAgent", "maxFreeSockets"],
        { min: 1 }
      ),
      wsConnectWarnAfterMs: readIntegerSetting(
        "FEISHU_WS_CONNECT_WARN_AFTER_MS",
        60000,
        jsonConfig,
        ["feishu", "wsConnectWarnAfterMs"],
        { min: 0 }
      ),
      wsReconnectWarnThreshold: readIntegerSetting(
        "FEISHU_WS_RECONNECT_WARN_THRESHOLD",
        3,
        jsonConfig,
        ["feishu", "wsReconnectWarnThreshold"],
        { min: 0 }
      ),
      reconnectReadyDebounceMs: readIntegerSetting(
        "FEISHU_RECONNECT_READY_DEBOUNCE_MS",
        60000,
        jsonConfig,
        ["feishu", "reconnectReadyDebounceMs"],
        { min: 0 }
      ),
      sendRetryMaxAttempts: readIntegerSetting(
        "FEISHU_SEND_RETRY_MAX_ATTEMPTS",
        5,
        jsonConfig,
        ["feishu", "sendRetry", "maxAttempts"],
        { min: 0 }
      ),
      sendRetryBaseDelayMs: readIntegerSetting(
        "FEISHU_SEND_RETRY_BASE_DELAY_MS",
        1000,
        jsonConfig,
        ["feishu", "sendRetry", "baseDelayMs"],
        { min: 0 }
      ),
      sendRetryMultiplier: readNumberSetting(
        "FEISHU_SEND_RETRY_MULTIPLIER",
        2,
        jsonConfig,
        ["feishu", "sendRetry", "multiplier"],
        { min: 1 }
      ),
      sendRetryMaxDelayMs: readIntegerSetting(
        "FEISHU_SEND_RETRY_MAX_DELAY_MS",
        10000,
        jsonConfig,
        ["feishu", "sendRetry", "maxDelayMs"],
        { min: 0 }
      ),
      titleMaxLength: readIntegerSetting(
        "FEISHU_TITLE_MAX_LENGTH",
        120,
        jsonConfig,
        ["feishu", "titleMaxLength"],
        { min: 8 }
      )
    },
    codex: {
      bin: readTextSetting("CODEX_BIN", "codex", jsonConfig, ["codex", "bin"]),
      home: readTextSetting("CODEX_HOME", defaultCodexHome, jsonConfig, ["codex", "home"]),
      sessionsDir: readTextSetting(
        "CODEX_SESSIONS_DIR",
        path.join(defaultCodexHome, "sessions"),
        jsonConfig,
        ["codex", "sessionsDir"]
      ),
      profileMode: codexProfileMode,
      backendMode:
        codexBackendMode === "terminal"
          ? "terminal"
          : codexBackendMode === "app-server"
            ? "app-server"
            : "spawn",
      outputSoftLimit: readIntegerSetting(
        "CODEX_OUTPUT_SOFT_LIMIT",
        100000,
        jsonConfig,
        ["codex", "outputSoftLimit"],
        { min: 1 }
      ),
      modelListMaxCount: readIntegerSetting(
        "CODEX_MODEL_LIST_MAX_COUNT",
        100,
        jsonConfig,
        ["codex", "modelListMaxCount"],
        { min: 1 }
      ),
      appServerSidebandCards: readBooleanSetting(
        "CODEX_APP_SERVER_SIDEBAND_CARDS",
        false,
        jsonConfig,
        ["codex", "appServer", "sidebandCards"]
      ),
      appServerInlineBlocks: normalizeAppServerInlineBlocks(
        readTextSetting(
          "CODEX_APP_SERVER_INLINE_BLOCKS",
          "full",
          jsonConfig,
          ["codex", "appServer", "inlineBlocks"]
        )
      ),
      sandboxMode: normalizeApprovalMode(
        readTextSetting("CODEX_SANDBOX_MODE", "workspace-write", jsonConfig, ["codex", "sandboxMode"])
      ),
      sessionListDefaultCount: readIntegerSetting(
        "CODEX_SESSION_LIST_DEFAULT_COUNT",
        20,
        jsonConfig,
        ["session", "listDefaultCount"],
        { min: 1 }
      ),
      sessionAllDefaultCount: readIntegerSetting(
        "CODEX_SESSION_ALL_DEFAULT_COUNT",
        100,
        jsonConfig,
        ["session", "allDefaultCount"],
        { min: 1 }
      ),
      resumeReplayCount: readIntegerSetting(
        "CODEX_SESSION_RESUME_REPLAY_COUNT",
        5,
        jsonConfig,
        ["session", "resumeReplayCount"],
        { min: 0 }
      ),
      runTimeoutMs: readIntegerSetting(
        "CODEX_RUN_TIMEOUT_MS",
        600000,
        jsonConfig,
        ["codex", "runTimeoutMs"],
        { min: 0 }
      ),
      approvalTimeoutMs: readIntegerSetting(
        "CODEX_APPROVAL_TIMEOUT_MS",
        180000,
        jsonConfig,
        ["codex", "approvalTimeoutMs"],
        { min: 1000 }
      ),
      compactTimeoutMs: readIntegerSetting(
        "CODEX_COMPACT_TIMEOUT_MS",
        180000,
        jsonConfig,
        ["codex", "compactTimeoutMs"],
        { min: 1000 }
      ),
      spawnStatusIntervalMs: readIntegerSetting(
        "SPAWN_STATUS_INTERVAL_MS",
        60000,
        jsonConfig,
        ["codex", "spawn", "statusIntervalMs"],
        { min: 0 }
      ),
      statusIncludeProject: readBooleanSetting(
        "STATUS_INCLUDE_PROJECT",
        true,
        jsonConfig,
        ["status", "includeProject"]
      ),
      terminalRenderMode:
        readTextSetting("TERMINAL_RENDER_MODE", "markdown", jsonConfig, [
          "codex",
          "terminal",
          "renderMode"
        ]) === "plain"
          ? "plain"
          : "markdown",
      terminalFlushIdleMs: readIntegerSetting(
        "TERMINAL_FLUSH_IDLE_MS",
        3000,
        jsonConfig,
        ["codex", "terminal", "flushIdleMs"],
        { min: 0 }
      ),
      terminalFlushMaxChars: readIntegerSetting(
        "TERMINAL_FLUSH_MAX_CHARS",
        4000,
        jsonConfig,
        ["codex", "terminal", "flushMaxChars"],
        { min: 0 }
      ),
      terminalStartupTimeoutMs: readIntegerSetting(
        "TERMINAL_STARTUP_TIMEOUT_MS",
        30000,
        jsonConfig,
        ["codex", "terminal", "startupTimeoutMs"],
        { min: 1 }
      )
    },
    project: {
      allowedRoots: projectAllowedRoots,
      defaultProject,
      defaultSearchEnabled: readBooleanSetting(
        "DEFAULT_SEARCH_ENABLED",
        true,
        jsonConfig,
        ["project", "defaultSearchEnabled"]
      )
    },
    storePath: readTextSetting("STORE_PATH", ".data/bindings.json", jsonConfig, ["paths", "storePath"])
  };
}

function normalizeApprovalMode(value: string): AppConfig["codex"]["sandboxMode"] {
  const normalized = value.trim().toLowerCase();
  if (["default", "ask", "on-request"].includes(normalized)) {
    return "default";
  }
  if (["danger-full-access", "full-access", "danger", "bypass"].includes(normalized)) {
    return "danger-full-access";
  }
  return "workspace-write";
}

function normalizeFeishuLoggerLevel(value: string): AppConfig["feishu"]["wsLoggerLevel"] {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "error":
    case "warn":
    case "debug":
    case "trace":
      return normalized;
    default:
      return "info";
  }
}

function normalizeAppServerInlineBlocks(
  value: string
): AppConfig["codex"]["appServerInlineBlocks"] {
  const normalized = value.trim().toLowerCase();
  if (normalized === "off" || normalized === "none" || normalized === "disabled") {
    return "off";
  }
  if (normalized === "compact") {
    return "compact";
  }
  return "full";
}

function readIntegerSetting(
  name: string,
  fallback: number,
  jsonConfig: JsonConfigShape | undefined,
  jsonPath: string[],
  options: { min: number }
): number {
  const raw = readScalarSetting(name, fallback, jsonConfig, jsonPath);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < options.min) {
    throw new Error(`${name} must be an integer >= ${options.min}: ${JSON.stringify(raw)}`);
  }
  return value;
}

function readNumberSetting(
  name: string,
  fallback: number,
  jsonConfig: JsonConfigShape | undefined,
  jsonPath: string[],
  options: { min: number }
): number {
  const raw = readScalarSetting(name, fallback, jsonConfig, jsonPath);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < options.min) {
    throw new Error(`${name} must be a number >= ${options.min}: ${JSON.stringify(raw)}`);
  }
  return value;
}

function loadJsonConfig(configPath?: string): JsonConfigShape | undefined {
  if (!configPath) return undefined;
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Missing bridge config json: ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, "utf8");
  const parsed = JSON.parse(raw) as JsonConfigShape;
  parsed.__path = resolved;
  return parsed;
}

function readBooleanSetting(
  name: string,
  fallback: boolean,
  jsonConfig: JsonConfigShape | undefined,
  jsonPath: string[]
): boolean {
  const envValue = process.env[name];
  if (envValue !== undefined) return parseBooleanSetting(name, envValue);
  const jsonValue = readJsonValue(jsonConfig, jsonPath, [name]);
  if (typeof jsonValue === "boolean") return jsonValue;
  if (typeof jsonValue === "string") {
    return parseBooleanSetting(name, jsonValue);
  }
  return fallback;
}

function readTextSetting(
  name: string,
  fallback: string,
  jsonConfig: JsonConfigShape | undefined,
  jsonPath: string[]
): string {
  const envValue = process.env[name];
  if (envValue) return envValue;
  const jsonValue = readJsonValue(jsonConfig, jsonPath, [name]);
  if (typeof jsonValue === "string" && jsonValue.length > 0) {
    return expandEnvPlaceholders(jsonValue);
  }
  return fallback;
}

function readScalarSetting(
  name: string,
  fallback: string | number | boolean,
  jsonConfig: JsonConfigShape | undefined,
  jsonPath: string[]
): string | number | boolean {
  const envValue = process.env[name];
  if (envValue) return envValue;
  const jsonValue = readJsonValue(jsonConfig, jsonPath, [name]);
  if (
    typeof jsonValue === "string" ||
    typeof jsonValue === "number" ||
    typeof jsonValue === "boolean"
  ) {
    return typeof jsonValue === "string" ? expandEnvPlaceholders(jsonValue) : jsonValue;
  }
  return fallback;
}

function readRootsSetting(
  name: string,
  jsonConfig: JsonConfigShape | undefined,
  jsonPath: string[],
  primaryRoot: string
): string[] {
  const envValue = process.env[name];
  if (envValue) {
    return parseRootsSetting(envValue, primaryRoot);
  }
  const jsonValue = readJsonValue(jsonConfig, jsonPath, [name]);
  if (Array.isArray(jsonValue)) {
    return normalizeRoots(
      jsonValue
        .filter((item): item is string => typeof item === "string")
        .map((item) => expandEnvPlaceholders(item)),
      primaryRoot
    );
  }
  if (typeof jsonValue === "string" && jsonValue.trim()) {
    return parseRootsSetting(expandEnvPlaceholders(jsonValue), primaryRoot);
  }
  return normalizeRoots([], primaryRoot);
}

function readJsonValue(
  jsonConfig: JsonConfigShape | undefined,
  jsonPath: string[],
  legacyKeys: string[] = []
): unknown {
  const nested = getNestedValue(jsonConfig, jsonPath);
  if (nested !== undefined) return nested;
  for (const key of legacyKeys) {
    if (jsonConfig && key in jsonConfig) {
      return jsonConfig[key];
    }
  }
  return undefined;
}

function getNestedValue(value: unknown, jsonPath: string[]): unknown {
  let current: unknown = value;
  for (const segment of jsonPath) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function parseBooleanSetting(name: string, raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean: ${JSON.stringify(raw)}`);
}

function parseRootsSetting(raw: string, primaryRoot: string): string[] {
  return normalizeRoots(
    raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => path.resolve(part)),
    primaryRoot
  );
}

function normalizeRoots(parts: string[], primaryRoot: string): string[] {
  return Array.from(new Set([path.resolve(primaryRoot), ...parts.map((part) => path.resolve(part))]));
}

function expandEnvPlaceholders(value: string): string {
  return value.replace(/\$(\w+)|\$\{([^}]+)\}/g, (_, simpleName: string, bracketName: string) => {
    const variableName = simpleName || bracketName;
    return process.env[variableName] || "";
  });
}

function isUnderAnyRoot(target: string, roots: string[]): boolean {
  return roots.some((root) => {
    const relative = path.relative(root, target);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}
