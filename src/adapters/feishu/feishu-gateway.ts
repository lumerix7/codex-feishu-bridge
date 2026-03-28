import * as Lark from "@larksuiteoapi/node-sdk";
import http from "node:http";
import https from "node:https";
import { AppConfig } from "../../config/env.js";
import { IncomingMessage, OutgoingMessage } from "../../types/domain.js";

type MessageHandler = (message: IncomingMessage) => Promise<void>;
type ReconnectHandler = () => Promise<void> | void;
type LarkLogger = {
  error: (...msg: unknown[]) => void;
  warn: (...msg: unknown[]) => void;
  info: (...msg: unknown[]) => void;
  debug: (...msg: unknown[]) => void;
  trace: (...msg: unknown[]) => void;
};
const FEISHU_POST_SOFT_LIMIT = 3500;
const FEISHU_CODEX_STREAM_PAGE_LIMIT = 3000;
const STREAMING_MARKDOWN_ELEMENT_ID = "markdown_stream";
const STREAMING_RAW_MARKDOWN_ELEMENT_ID = "markdown_raw";
const STREAMING_FOOTER_ELEMENT_ID = "footer_meta";
const STREAMING_LINE_DELAY_MS = 40;
const STREAMING_MAX_LINE_UPDATES = 64;
const STREAMING_LONG_LINE_STEP = 120;

export class FeishuGateway {
  private client: Lark.Client;
  private wsClient: Lark.WSClient;
  private readonly startedAt = Date.now();
  private readonly httpAgent: http.Agent;
  private readonly httpsAgent: https.Agent;
  private readonly recentMessages = new Map<string, number>();
  private readonly activeStreamingCards = new Map<string, ActiveStreamingCard>();
  private readonly activePagedStreams = new Map<string, ActivePagedStreamingState>();
  private readonly chatSendQueues = new Map<string, Promise<void>>();
  private cleanupTimer?: NodeJS.Timeout;
  private reconnecting = false;
  private readyOnce = false;
  private lastReconnectReadyAt = 0;
  private lastReconnectStartedAt?: string;
  private reconnectCount = 0;
  private lastWsReadyAt?: string;
  private lastInboundMessageAt?: string;
  private lastInboundMessageId?: string;
  private sendRetryCount = 0;
  private sendFailureCount = 0;
  private lastSendError?: string;
  private reconnectHandler?: ReconnectHandler;

  constructor(private readonly config: AppConfig["feishu"]) {
    this.httpAgent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: this.config.wsAgentKeepAliveMsecs,
      maxSockets: this.config.wsAgentMaxSockets,
      maxFreeSockets: this.config.wsAgentMaxFreeSockets
    });
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: this.config.wsAgentKeepAliveMsecs,
      maxSockets: this.config.wsAgentMaxSockets,
      maxFreeSockets: this.config.wsAgentMaxFreeSockets
    });
    Lark.defaultHttpInstance.defaults.timeout = 30_000;
    Lark.defaultHttpInstance.defaults.httpAgent = this.httpAgent;
    Lark.defaultHttpInstance.defaults.httpsAgent = this.httpsAgent;
    this.client = this.createClient();
    this.wsClient = this.createWsClient();
  }

  async start(onMessage: MessageHandler, onReconnect?: ReconnectHandler): Promise<void> {
    this.reconnectHandler = onReconnect;
    this.cleanupTimer = setInterval(() => this.evictDedupCache(), 60_000);
    this.cleanupTimer.unref();

    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        console.log("Feishu raw receive event", {
          eventId: data?.event_id,
          messageId: data?.message?.message_id,
          chatId: data?.message?.chat_id,
          chatType: data?.message?.chat_type,
          messageType: data?.message?.message_type,
          hasContent: typeof data?.message?.content === "string",
          senderOpenId: data?.sender?.sender_id?.open_id
        });
        const message = normalizeIncoming(data);
        if (!message) {
          console.warn("Feishu inbound event ignored", {
            eventId: data?.event_id,
            messageId: data?.message?.message_id,
            reason: describeIgnoredMessage(data)
          });
          return;
        }
        if (message.senderOpenId && message.senderOpenId === this.config.botOpenId) {
          console.log("Feishu inbound event ignored", {
            eventId: data?.event_id,
            messageId: message.messageId,
            reason: "message from bot itself"
          });
          return;
        }

        const dedupKey = message.messageId;
        if (this.recentMessages.has(dedupKey)) return;
        this.recentMessages.set(dedupKey, Date.now());

        console.log("Feishu inbound message", {
          messageId: message.messageId,
          chatId: message.chatId,
          chatType: message.chatType,
          threadId: message.threadId,
          textPreview: previewText(message.text)
        });
        this.lastInboundMessageAt = new Date().toISOString();
        this.lastInboundMessageId = message.messageId;

        setImmediate(() => {
          void onMessage(message).catch((error: unknown) => {
            console.error("failed to process Feishu message", error);
          });
        });
      },
      "im.message.message_read_v1": async () => {
        // No-op. Registering the event avoids repeated SDK warnings for read receipts.
      }
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    this.onWsReady();
    console.log("Feishu websocket client connected.");
  }

  async send(message: OutgoingMessage): Promise<void> {
    return this.enqueueChatSend(message.chatId, async () => {
      const plan = buildRenderPlan(message, FEISHU_POST_SOFT_LIMIT);
      if (message.streaming) {
        const sent = await this.sendStreamingFirst(message, plan).catch((error) => {
          console.warn("Feishu streaming-first send failed; falling back to normal card send", {
            chatId: message.chatId,
            title: message.title,
            streamKey: message.streamKey,
            error: formatFeishuError(error)
          });
          this.cleanupStreamingCardsForMessage(message);
          return false;
        });
        if (sent) return;
      }
      this.logChunkPlan("normal", message, plan);
      for (const page of plan.pages) {
      await this.sendChunkWithRetry(
        message.chatId,
        page.text,
        message.title,
        message.template,
        page.footer,
        message.includeRawMarkdown
      );
      }
    });
  }

  private enqueueChatSend(chatId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.chatSendQueues.get(chatId) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task);
    this.chatSendQueues.set(chatId, next);
    return next.finally(() => {
      if (this.chatSendQueues.get(chatId) === next) {
        this.chatSendQueues.delete(chatId);
      }
    });
  }

  private async sendStreamingFirst(message: OutgoingMessage, plan: RenderPlan): Promise<boolean> {
    this.logChunkPlan("streaming", message, plan);
    if (message.streamKey && message.preserveStreamingPages) {
      return this.sendPreservedStreamingPages(message);
    }
    if (message.streamKey) {
      for (const [index, page] of plan.pages.entries()) {
        const pageMessage: OutgoingMessage = {
          ...message,
          text: page.text,
          footer: page.footer,
          streamKey: `${message.streamKey}:page:${index + 1}`,
          finalizeStreaming: message.finalizeStreaming
        };
        const sent = await this.sendOrUpdateStreamingCard(pageMessage);
        if (!sent) {
          return false;
        }
      }
      return true;
    }

    for (const page of plan.pages) {
      const pageMessage: OutgoingMessage = {
        ...message,
        text: page.text,
        footer: page.footer
      };
      const sent = await this.sendStreamingCard(pageMessage);
      if (!sent) {
        return false;
      }
    }
    return true;
  }

  private async sendPreservedStreamingPages(message: OutgoingMessage): Promise<boolean> {
    const rootStreamKey = message.streamKey;
    if (!rootStreamKey) return false;

    const rendered = (message.text || "").trim();
    let state = this.activePagedStreams.get(rootStreamKey);
    if (!state) {
      state = { frozenPages: [], pageCount: 0 };
      this.activePagedStreams.set(rootStreamKey, state);
    }

    const pages = splitMessageText(rendered, FEISHU_CODEX_STREAM_PAGE_LIMIT);
    const completedPages = pages.slice(0, -1);
    const activePage = pages[pages.length - 1] || "";

    let commonPrefixCount = 0;
    while (
      commonPrefixCount < state.frozenPages.length &&
      commonPrefixCount < completedPages.length &&
      state.frozenPages[commonPrefixCount] === completedPages[commonPrefixCount]
    ) {
      commonPrefixCount += 1;
    }

    for (let index = commonPrefixCount; index < completedPages.length; index += 1) {
      const pageText = completedPages[index];
      const pageIndex = index + 1;
      const pageMessage: OutgoingMessage = {
        ...message,
        text: pageText,
        footer: message.footer,
        streamKey: `${rootStreamKey}:page:${pageIndex}`,
        finalizeStreaming: true
      };
      const sent = await this.sendOrUpdateStreamingCard(pageMessage);
      if (!sent) {
        return false;
      }
    }
    state.frozenPages = completedPages;

    const activePageIndex = completedPages.length + 1;
    const activeMessage: OutgoingMessage = {
      ...message,
      text: activePage,
      footer: message.footer,
      streamKey: `${rootStreamKey}:page:${activePageIndex}`,
      finalizeStreaming: message.finalizeStreaming
    };
    const sent = await this.sendOrUpdateStreamingCard(activeMessage);
    if (!sent) {
      return false;
    }
    state.pageCount = Math.max(state.pageCount, activePageIndex);

    for (let index = pages.length + 1; index <= state.pageCount; index += 1) {
      const superseded = await this.sendOrUpdateStreamingCard({
        ...message,
        text: "```text\nSuperseded by a newer Codex stream snapshot.\n```",
        footer: message.footer,
        streamKey: `${rootStreamKey}:page:${index}`,
        finalizeStreaming: true
      });
      if (!superseded) {
        return false;
      }
    }
    state.pageCount = pages.length;
    if (message.finalizeStreaming) {
      this.activePagedStreams.delete(rootStreamKey);
    }
    return true;
  }

  private logChunkPlan(mode: "normal" | "streaming", message: OutgoingMessage, plan: RenderPlan): void {
    if (plan.pages.length <= 1) return;
    console.log("Feishu outbound chunk plan", {
      mode,
      chatId: message.chatId,
      title: message.title,
      chunks: plan.pages.length,
      containsTable: plan.containsTable,
      previews: plan.pages.slice(0, 3).map((page) => previewText(page.text))
    });
  }

  private async sendOrUpdateStreamingCard(message: OutgoingMessage): Promise<boolean> {
    const streamKey = message.streamKey;
    if (!streamKey) return false;

    let active = this.activeStreamingCards.get(streamKey);
    if (!active) {
      active = await this.createStreamingCard(message);
      this.activeStreamingCards.set(streamKey, active);
    }

    const rendered = (message.text || "").trim();
    try {
      if (rendered && rendered !== active.lastText) {
        await this.withFeishuRetry(async () =>
          this.client.cardkit.v1.cardElement.content({
            path: {
              card_id: active.cardId,
              element_id: STREAMING_MARKDOWN_ELEMENT_ID
            },
            data: {
              content: rendered,
              sequence: active.sequence
            }
          }),
          "streaming content"
        );
        active.sequence += 1;
        active.lastText = rendered;
      }

      if (message.finalizeStreaming) {
        await this.withFeishuRetry(async () =>
          this.client.cardkit.v1.cardElement.update({
            path: {
              card_id: active.cardId,
              element_id: STREAMING_RAW_MARKDOWN_ELEMENT_ID
            },
            data: {
              element: JSON.stringify({
                tag: "markdown",
                content: wrapRawMarkdown(rendered),
                element_id: STREAMING_RAW_MARKDOWN_ELEMENT_ID
              }),
              sequence: active.sequence
            }
          }),
          "streaming raw markdown"
        );
        active.sequence += 1;
        await this.withFeishuRetry(async () =>
          this.client.cardkit.v1.card.settings({
            path: {
              card_id: active.cardId
            },
            data: {
              settings: JSON.stringify({
                config: {
                  streaming_mode: false
                }
              }),
              sequence: active.sequence
            }
          }),
          "streaming finalize"
        );
        this.activeStreamingCards.delete(streamKey);
      }
    } catch (error) {
      this.activeStreamingCards.delete(streamKey);
      throw error;
    }

    console.log("Feishu outbound live streaming card updated", {
      chatId: message.chatId,
      cardId: active.cardId,
      streamKey,
      final: Boolean(message.finalizeStreaming),
      textPreview: previewText(rendered),
      footerPreview: previewText(message.footer || buildCardMetaMarkdown(message.title))
    });
    return true;
  }

  private async sendStreamingCard(message: OutgoingMessage): Promise<boolean> {
    const rendered = (message.text || "").trim();
    const active = await this.createStreamingCard(message);
    try {
      const lineFrames = buildStreamingLineFrames(rendered, STREAMING_MAX_LINE_UPDATES);
      for (const frame of lineFrames) {
        await this.withFeishuRetry(async () =>
          this.client.cardkit.v1.cardElement.content({
            path: {
              card_id: active.cardId,
              element_id: STREAMING_MARKDOWN_ELEMENT_ID
            },
            data: {
              content: frame,
              sequence: active.sequence
            }
          }),
          "streaming content"
        );
        active.sequence += 1;
        if (lineFrames.length > 1) {
          await sleep(STREAMING_LINE_DELAY_MS);
        }
      }

      await this.withFeishuRetry(async () =>
        this.client.cardkit.v1.cardElement.update({
          path: {
            card_id: active.cardId,
            element_id: STREAMING_RAW_MARKDOWN_ELEMENT_ID
          },
          data: {
            element: JSON.stringify({
              tag: "markdown",
              content: wrapRawMarkdown(rendered),
              element_id: STREAMING_RAW_MARKDOWN_ELEMENT_ID
            }),
            sequence: active.sequence
          }
        }),
        "streaming raw markdown"
      );
      active.sequence += 1;

      await this.withFeishuRetry(async () =>
        this.client.cardkit.v1.card.settings({
          path: {
            card_id: active.cardId
          },
          data: {
            settings: JSON.stringify({
              config: {
                streaming_mode: false
              }
            }),
            sequence: active.sequence
          }
        }),
        "streaming finalize"
      );
    } catch (error) {
      throw error;
    }

    console.log("Feishu outbound streaming card sent", {
      chatId: message.chatId,
      cardId: active.cardId,
      textPreview: previewText(rendered),
      footerPreview: previewText(message.footer || buildCardMetaMarkdown(message.title))
    });
    return true;
  }

  private async createStreamingCard(message: OutgoingMessage): Promise<ActiveStreamingCard> {
    const rendered = (message.text || "").trim();
    const footer = message.footer || buildCardMetaMarkdown(message.title);
    const summary = buildCardSummary(message.title, rendered);
    const card = await this.withFeishuRetry(async () =>
      this.client.cardkit.v1.card.create({
        data: {
          type: "card_json",
          data: JSON.stringify(
            buildStreamingCard(
              "",
              message.title,
              message.template,
              footer,
              summary
            )
          )
        }
      }),
      "streaming card create"
    );
    const cardId = String(card.data?.card_id || "").trim();
    if (!cardId) {
      throw new Error("Feishu CardKit create returned no card_id");
    }

    await this.withFeishuRetry(async () =>
      this.client.im.v1.message.create({
        params: {
          receive_id_type: "chat_id"
        },
        data: {
          receive_id: message.chatId,
          msg_type: "interactive",
          content: JSON.stringify({
            type: "card",
            data: {
              card_id: cardId
            }
          })
        }
      }),
      "streaming card send"
    );

    return {
      cardId,
      sequence: 1,
      lastText: "",
      chatId: message.chatId
    };
  }

  private async withFeishuRetry<T>(action: () => Promise<T>, label = "send"): Promise<T> {
    let lastError: unknown;
    const configuredAttempts = this.config.sendRetryMaxAttempts;
    const attempts = Math.max(1, configuredAttempts);

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await action();
      } catch (error) {
        lastError = error;
        if (shouldResetFeishuClient(error)) {
          this.client = this.createClient();
        }
        if (!shouldRetryFeishuError(error) || attempt >= attempts) {
          break;
        }
        const delayMs = computeRetryDelayMs(
          attempt,
          this.config.sendRetryBaseDelayMs,
          this.config.sendRetryMultiplier,
          this.config.sendRetryMaxDelayMs
        );
        console.warn(
          `Feishu ${label} retry ${attempt}/${Math.max(0, attempts - 1)} in ${delayMs}ms: ${formatFeishuError(error)}`
        );
        this.sendRetryCount += 1;
        this.lastSendError = formatFeishuError(error);
        await sleep(delayMs);
      }
    }

    this.sendFailureCount += 1;
    this.lastSendError = formatFeishuError(lastError);
    throw new Error(
      `Feishu ${label} failed after ${attempts} attempt${attempts === 1 ? "" : "s"}${configuredAttempts === 0 ? " (retry disabled)" : ""}: ${formatFeishuError(lastError)}`
    );
  }

  async sendStartupReady(text: string, footer?: string, title?: string): Promise<void> {
    if (!this.config.startupNotifyChatId) return;
    await this.send({
      chatId: this.config.startupNotifyChatId,
      title,
      text,
      footer
    });
  }

  exampleIncoming(text: string): IncomingMessage {
    return {
      messageId: "local-example",
      chatId: "local-chat",
      chatType: "p2p",
      text
    };
  }

  private evictDedupCache(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [key, timestamp] of this.recentMessages) {
      if (timestamp < cutoff) {
        this.recentMessages.delete(key);
      }
    }
  }

  private async sendChunkWithRetry(
    chatId: string,
    chunk: string,
    title?: string,
    template?: OutgoingMessage["template"],
    footer?: string,
    includeRawMarkdown = true
  ): Promise<void> {
    await this.withFeishuRetry(async () =>
      this.client.im.v1.message.create({
        params: {
          receive_id_type: "chat_id"
        },
        data: {
          receive_id: chatId,
          msg_type: "interactive",
          content: buildInteractiveCardContent(chunk, title, template, footer, includeRawMarkdown)
        }
      }),
      "send"
    );
    console.log("Feishu outbound message sent", {
      chatId,
      textPreview: previewText(chunk),
      footerPreview: previewText(footer || buildCardMetaMarkdown(title))
    });
  }

  private cleanupStreamingCardsForMessage(message: OutgoingMessage): void {
    if (!message.streamKey) return;
    this.activePagedStreams.delete(message.streamKey);
    const prefix = `${message.streamKey}:page:`;
    for (const key of this.activeStreamingCards.keys()) {
      if (key === message.streamKey || key.startsWith(prefix)) {
        this.activeStreamingCards.delete(key);
      }
    }
  }

  private createClient(): Lark.Client {
    return new Lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      logger: this.createLarkLogger()
    });
  }

  private createWsClient(): Lark.WSClient {
    return new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      httpInstance: Lark.defaultHttpInstance,
      agent: this.httpsAgent,
      autoReconnect: this.config.wsAutoReconnect,
      logger: this.createLarkLogger()
    });
  }

  private createLarkLogger(): LarkLogger {
    const proxy = (level: "error" | "warn" | "info" | "debug" | "trace") =>
      (...msg: unknown[]): void => {
        this.observeWsLog(level, msg);
        if (!this.shouldEmit(level)) return;
        switch (level) {
          case "error":
            console.error(...msg);
            return;
          case "warn":
            console.warn(...msg);
            return;
          case "info":
            console.info(...msg);
            return;
          case "debug":
            console.debug(...msg);
            return;
          default:
            console.debug(...msg);
        }
      };
    return {
      error: proxy("error"),
      warn: proxy("warn"),
      info: proxy("info"),
      debug: proxy("debug"),
      trace: proxy("trace")
    };
  }

  private observeWsLog(level: string, msg: unknown[]): void {
    const scope = String(msg[0] || "");
    const detail = String(msg[1] || "");
    if (scope !== "[ws]") return;

    if (detail === "reconnect") {
      this.reconnecting = true;
      this.reconnectCount += 1;
      this.lastReconnectStartedAt = new Date().toISOString();
      return;
    }
    if (detail === "ws client ready" || detail === "reconnect success") {
      this.onWsReady();
      return;
    }
    if (level === "error" && detail === "connect failed") {
      this.reconnecting = true;
    }
  }

  private onWsReady(): void {
    const wasReconnect = this.readyOnce && this.reconnecting;
    this.readyOnce = true;
    this.reconnecting = false;
    this.lastWsReadyAt = new Date().toISOString();
    if (!wasReconnect) return;

    const now = Date.now();
    if (now - this.lastReconnectReadyAt < this.config.reconnectReadyDebounceMs) {
      return;
    }
    this.lastReconnectReadyAt = now;
    void this.reconnectHandler?.();
  }

  private shouldEmit(level: "error" | "warn" | "info" | "debug" | "trace"): boolean {
    const rank = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3,
      trace: 4
    } as const;
    return rank[level] <= rank[this.config.wsLoggerLevel];
  }

  diagnostics(): {
    wsConnectedOnce: boolean;
    wsReconnecting: boolean;
    startedAt: string;
    reconnectCount: number;
    lastReconnectStartedAt?: string;
    lastWsReadyAt?: string;
    lastReconnectReadyAt?: string;
    lastInboundMessageAt?: string;
    lastInboundMessageId?: string;
    outboundRetryCount: number;
    outboundFailureCount: number;
    lastSendError?: string;
    activeStreamingCards: number;
    activeChatSendQueues: number;
    queuedChatIds: string[];
  } {
    return {
      wsConnectedOnce: this.readyOnce,
      wsReconnecting: this.reconnecting,
      startedAt: new Date(this.startedAt).toISOString(),
      reconnectCount: this.reconnectCount,
      lastReconnectStartedAt: this.lastReconnectStartedAt,
      lastWsReadyAt: this.lastWsReadyAt,
      lastReconnectReadyAt: this.lastReconnectReadyAt
        ? new Date(this.lastReconnectReadyAt).toISOString()
        : undefined,
      lastInboundMessageAt: this.lastInboundMessageAt,
      lastInboundMessageId: this.lastInboundMessageId,
      outboundRetryCount: this.sendRetryCount,
      outboundFailureCount: this.sendFailureCount,
      lastSendError: this.lastSendError,
      activeStreamingCards: this.activeStreamingCards.size,
      activeChatSendQueues: this.chatSendQueues.size,
      queuedChatIds: [...this.chatSendQueues.keys()].slice(0, 5)
    };
  }
}

interface ActiveStreamingCard {
  cardId: string;
  sequence: number;
  lastText: string;
  chatId: string;
}

interface ActivePagedStreamingState {
  frozenPages: string[];
  pageCount: number;
}

interface RenderPlanPage {
  text: string;
  footer?: string;
}

interface RenderPlan {
  pages: RenderPlanPage[];
  containsTable: boolean;
}

function normalizeIncoming(data: any): IncomingMessage | undefined {
  if (!data?.message?.message_id || !data?.message?.chat_id || typeof data?.message?.content !== "string") {
    return undefined;
  }

  const content = parseJson(data.message.content);
  const text = extractIncomingText(content).trim();
  if (!text) return undefined;

  return {
    messageId: data.message.message_id,
    chatId: data.message.chat_id,
    chatType: normalizeChatType(data.message.chat_type),
    threadId: data.message.thread_id,
    rootId: data.message.root_id,
    senderOpenId: data.sender?.sender_id?.open_id,
    text
  };
}

function normalizeChatType(value: string | undefined): "p2p" | "group" | "unknown" {
  if (value === "p2p") return "p2p";
  if (value === "group") return "group";
  return "unknown";
}

function parseJson(value: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function extractIncomingText(content: Record<string, unknown> | undefined): string {
  if (!content) return "";
  const parts: string[] = [];
  const title = typeof content.title === "string" ? content.title.trim() : "";
  if (title) {
    parts.push(title);
  }
  if (typeof content.text === "string") {
    const text = content.text.trim();
    if (text) parts.push(text);
    return parts.join("\n");
  }
  if (Array.isArray(content.content)) {
    const text = flattenFeishuPostContent(content.content);
    if (text) parts.push(text);
    return parts.join("\n");
  }
  return parts.join("\n");
}

function flattenFeishuPostContent(content: unknown[]): string {
  const lines: string[] = [];

  for (const block of content) {
    if (!Array.isArray(block)) continue;
    const parts: string[] = [];
    for (const item of block) {
      if (!item || typeof item !== "object") continue;
      const tag = typeof (item as { tag?: unknown }).tag === "string" ? (item as { tag: string }).tag : "";
      if (tag === "text") {
        const text = (item as { text?: unknown }).text;
        if (typeof text === "string" && text.trim()) {
          parts.push(text);
        }
        continue;
      }
      if (tag === "a") {
        const text = (item as { text?: unknown }).text;
        const href = (item as { href?: unknown }).href;
        if (typeof text === "string" && text.trim()) {
          parts.push(text);
        } else if (typeof href === "string" && href.trim()) {
          parts.push(href);
        }
        continue;
      }
      if (tag === "at") {
        const userName = (item as { user_name?: unknown }).user_name;
        if (typeof userName === "string" && userName.trim()) {
          parts.push(`@${userName}`);
        }
      }
    }
    const line = parts.join("").trim();
    if (line) lines.push(line);
  }

  return lines.join("\n");
}

function splitMessageText(text: string, maxChars: number): string[] {
  if (maxChars <= 0 || text.length <= maxChars) return [text];

  const tableChunks = splitMarkdownTableText(text, maxChars);
  if (tableChunks) {
    return tableChunks;
  }

  const blocks = splitMarkdownBlocks(text);
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = (): void => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = "";
  };

  for (const block of blocks) {
    if (!block.trim()) continue;
    if (block.length > maxChars) {
      pushCurrent();
      chunks.push(...splitOversizedMarkdownBlock(block, maxChars));
      continue;
    }

    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    pushCurrent();
    current = block;
  }

  pushCurrent();
  return chunks.length > 0 ? chunks : [text];
}

function buildRenderPlan(message: OutgoingMessage, maxChars: number): RenderPlan {
  const text = message.text || "";
  const pages = splitMessageText(text, maxChars);
  return {
    containsTable: containsMarkdownTable(text),
    pages: pages.map((pageText, index) => ({
      text: pageText,
      footer: formatChunkFooter(message.footer, index, pages.length, message.suppressChunkFooter)
    }))
  };
}

function containsMarkdownTable(text: string): boolean {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].trim().startsWith("|")) continue;
    if (/^\|\s*[:\-| ]+\|\s*$/.test(lines[index + 1].trim())) {
      return true;
    }
  }
  return false;
}

function splitMarkdownTableText(text: string, maxChars: number): string[] | undefined {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const tableStart = lines.findIndex((line, index) => {
    if (!line.trim().startsWith("|")) return false;
    const next = lines[index + 1] || "";
    return /^\|\s*[:\-| ]+\|\s*$/.test(next.trim());
  });
  if (tableStart < 0) return undefined;

  const tableHeader = lines[tableStart];
  const tableSeparator = lines[tableStart + 1];
  const prefix = lines.slice(0, tableStart).join("\n").trim();
  const rows: string[] = [];
  let endIndex = tableStart + 2;
  for (; endIndex < lines.length; endIndex += 1) {
    const line = lines[endIndex];
    if (!line.trim()) continue;
    if (!line.trim().startsWith("|")) break;
    rows.push(line);
  }
  if (rows.length === 0) return undefined;
  const suffix = lines.slice(endIndex).join("\n").trim();

  const tableOnlyHeader = [tableHeader, tableSeparator].join("\n");
  const firstPageHeader = prefix
    ? `${prefix}\n\n${tableHeader}\n${tableSeparator}`
    : tableOnlyHeader;
  if (firstPageHeader.length > maxChars || tableOnlyHeader.length > maxChars) {
    return undefined;
  }

  const chunks: string[] = [];
  let current = firstPageHeader;
  let continuationHeader = tableOnlyHeader;
  for (const row of rows) {
    const candidate = `${current}\n${row}`;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current === firstPageHeader || current === continuationHeader) {
      return undefined;
    }
    chunks.push(current);
    current = `${continuationHeader}\n${row}`;
    if (current.length > maxChars) {
      return undefined;
    }
  }

  if (suffix) {
    const withSuffix = `${current}\n\n${suffix}`;
    if (withSuffix.length <= maxChars) {
      current = withSuffix;
    } else {
      chunks.push(current);
      const suffixChunks = splitMessageText(suffix, maxChars);
      if (suffixChunks.length === 0) {
        return undefined;
      }
      chunks.push(...suffixChunks.slice(0, -1));
      current = suffixChunks[suffixChunks.length - 1] || "";
    }
  }

  if (current.trim()) {
    chunks.push(current);
  }
  return chunks.length > 1 ? chunks : undefined;
}

function buildInteractiveCardContent(
  text: string,
  title?: string,
  template: OutgoingMessage["template"] = "blue",
  footer?: string,
  includeRawMarkdown = true
): string {
  const rendered = text.trim();
  const summary = buildCardSummary(title, rendered);
  const meta = buildCardMetaMarkdown(title);
  return JSON.stringify({
    schema: "2.0",
    config: {
      summary: {
        content: summary
      },
      wide_screen_mode: true,
      width_mode: "fill",
      enable_forward: true,
      update_multi: true
    },
    header: {
      template,
      title: {
        tag: "plain_text",
        content: title?.trim() || "Codex"
      }
    },
    body: {
      direction: "vertical",
      padding: "12px 8px 12px 8px",
      vertical_spacing: "8px",
      elements: [
        {
          tag: "markdown",
          content: rendered
        },
        ...(includeRawMarkdown ? [{
          tag: "markdown",
          content: wrapRawMarkdown(rendered)
        }] : []),
        {
          tag: "markdown",
          content: footer || meta
        }
      ]
    }
  });
}

function buildStreamingCard(
  text: string,
  title?: string,
  template: OutgoingMessage["template"] = "blue",
  footer?: string,
  summary?: string
): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      summary: {
        content: summary || buildCardSummary(title, text)
      },
      streaming_config: {
        print_frequency_ms: {
          default: 70,
          android: 70,
          ios: 70,
          pc: 70
        },
        print_step: {
          default: 1,
          android: 1,
          ios: 1,
          pc: 1
        },
        print_strategy: "fast"
      },
      wide_screen_mode: true,
      width_mode: "fill",
      enable_forward: true,
      update_multi: true
    },
    header: {
      template,
      title: {
        tag: "plain_text",
        content: title?.trim() || "Codex"
      }
    },
    body: {
      direction: "vertical",
      padding: "12px 8px 12px 8px",
      vertical_spacing: "8px",
      elements: [
        {
          tag: "markdown",
          content: text,
          element_id: STREAMING_MARKDOWN_ELEMENT_ID
        },
        {
          tag: "markdown",
          content: "",
          element_id: STREAMING_RAW_MARKDOWN_ELEMENT_ID
        },
        {
          tag: "markdown",
          content: footer || buildCardMetaMarkdown(title),
          element_id: STREAMING_FOOTER_ELEMENT_ID
        }
      ]
    }
  };
}

function buildStreamingLineFrames(text: string, maxFrames: number): string[] {
  if (!text) return [""];
  const frames: string[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let current = "";

  const pushFrame = (value: string): void => {
    if (!value || frames[frames.length - 1] === value) return;
    frames.push(value);
  };

  for (const line of lines) {
    const prefix = current ? `${current}\n` : "";
    if (line.length <= STREAMING_LONG_LINE_STEP) {
      current = `${prefix}${line}`;
      pushFrame(current);
      continue;
    }

    for (let index = STREAMING_LONG_LINE_STEP; index < line.length; index += STREAMING_LONG_LINE_STEP) {
      pushFrame(`${prefix}${line.slice(0, index)}`);
    }
    current = `${prefix}${line}`;
    pushFrame(current);
  }

  if (frames.length <= maxFrames) {
    return frames.length > 0 ? frames : [text];
  }

  const reduced: string[] = [];
  const step = Math.max(1, Math.ceil(frames.length / maxFrames));
  for (let index = step; index < frames.length; index += step) {
    reduced.push(frames[index - 1]);
  }
  const full = frames[frames.length - 1] || text;
  if (reduced[reduced.length - 1] !== full) {
    reduced.push(full);
  }
  return reduced;
}

function buildCardSummary(title: string | undefined, rendered: string): string {
  const firstLine = rendered
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const base = firstLine || title?.trim() || "Codex";
  return previewText(base, 80);
}

function buildCardMetaMarkdown(title: string | undefined): string {
  return `\`${formatIsoTimestamp(new Date())}\``;
}

function formatChunkFooter(
  footer: string | undefined,
  index: number,
  total: number,
  suppressChunkFooter = false
): string | undefined {
  if (suppressChunkFooter) {
    return footer;
  }
  const chunk = total > 1 ? `chunk ${index + 1}/${total}` : "";
  if (footer && chunk) return `${footer}  |  ${chunk}`;
  return footer || chunk || undefined;
}

function formatIsoTimestamp(date: Date): string {
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


function wrapRawMarkdown(text: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(text.matchAll(/`+/g), (match) => match[0].length)
  );
  const fence = "`".repeat(Math.max(4, longestBacktickRun + 1));
  return `${fence}markdown\n${text}\n${fence}`;
}

function splitMarkdownBlocks(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const blocks: string[] = [];
  const lines = normalized.split("\n");
  let current: string[] = [];
  let inFence = false;
  let fenceMarker = "";

  const flush = (): void => {
    const block = current.join("\n").trim();
    if (block) blocks.push(block);
    current = [];
  };

  for (const line of lines) {
    const fenceInfo = parseFenceLine(line);
    if (fenceInfo && !inFence) {
      flush();
      inFence = true;
      fenceMarker = fenceInfo.marker;
      current.push(line);
      continue;
    }
    if (inFence) {
      current.push(line);
      if (fenceInfo && fenceInfo.marker === fenceMarker) {
        flush();
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    current.push(line);
  }

  flush();
  return blocks;
}

function splitOversizedMarkdownBlock(block: string, maxChars: number): string[] {
  const fenceInfo = parseFenceLine(block.split("\n", 1)[0] || "");
  if (!fenceInfo) {
    return splitPlainTextBlock(block, maxChars);
  }

  const lines = block.split("\n");
  const closingIndex = findClosingFenceIndex(lines, fenceInfo.marker);
  if (closingIndex <= 0) {
    return splitPlainTextBlock(block, maxChars);
  }

  const opening = lines[0];
  const closing = lines[closingIndex];
  const body = lines.slice(1, closingIndex).join("\n");
  const wrapperCost = opening.length + closing.length + 2;
  const innerMax = Math.max(1, maxChars - wrapperCost);
  const innerChunks = splitPlainTextBlock(body, innerMax);
  return innerChunks.map((chunk) => `${opening}\n${chunk}\n${closing}`);
}

function splitPlainTextBlock(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    const splitAt = pickSplitPoint(remaining, maxChars);
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function parseFenceLine(line: string): { marker: string } | undefined {
  const match = line.match(/^(`{3,}|~{3,})/);
  if (!match) return undefined;
  return { marker: match[1] };
}

function findClosingFenceIndex(lines: string[], marker: string): number {
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].startsWith(marker)) {
      return index;
    }
  }
  return -1;
}

function pickSplitPoint(text: string, maxChars: number): number {
  const slice = text.slice(0, maxChars);
  const paragraph = slice.lastIndexOf("\n\n");
  if (paragraph >= Math.floor(maxChars * 0.5)) return paragraph + 2;
  const line = slice.lastIndexOf("\n");
  if (line >= Math.floor(maxChars * 0.5)) return line + 1;
  const space = slice.lastIndexOf(" ");
  if (space >= Math.floor(maxChars * 0.5)) return space + 1;
  return maxChars;
}

function formatFeishuError(error: unknown): string {
  if (!(error instanceof Error)) {
    return typeof error === "string" ? error : "unknown error";
  }

  const parts = [error.message];
  const maybe = error as Error & {
    code?: string;
    response?: {
      status?: number;
      statusText?: string;
      data?: unknown;
    };
  };

  if (maybe.code) {
    parts.push(`code=${maybe.code}`);
  }
  if (maybe.response?.status) {
    parts.push(`status=${maybe.response.status}`);
  }
  if (maybe.response?.statusText) {
    parts.push(`statusText=${maybe.response.statusText}`);
  }
  if (maybe.response?.data !== undefined) {
    const body = compactValue(maybe.response.data);
    if (body) parts.push(`body=${body}`);
  }

  return parts.join(" | ");
}

function shouldRetryFeishuError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const maybe = error as Error & {
    code?: string;
    response?: {
      status?: number;
    };
  };

  const status = maybe.response?.status;
  if (status === 429) return true;
  if (typeof status === "number" && status >= 500) return true;

  return (
    error.message.includes("tenant_access_token") ||
    error.message.includes("socket hang up") ||
    maybe.code === "ECONNRESET" ||
    maybe.code === "ECONNABORTED" ||
    maybe.code === "ETIMEDOUT" ||
    maybe.code === "EAI_AGAIN" ||
    maybe.code === "ENOTFOUND" ||
    maybe.code === "ERR_NETWORK" ||
    maybe.code === "ERR_BAD_RESPONSE"
  );
}

function shouldResetFeishuClient(error: unknown): boolean {
  return error instanceof Error && error.message.includes("tenant_access_token");
}

function computeRetryDelayMs(
  attempt: number,
  baseDelayMs: number,
  multiplier: number,
  maxDelayMs: number
): number {
  const exponential = baseDelayMs * Math.max(1, multiplier ** (attempt - 1));
  const jittered = exponential * (0.8 + Math.random() * 0.4);
  return Math.min(Math.round(jittered), maxDelayMs);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactValue(value: unknown): string {
  try {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    return raw.replace(/\s+/g, " ").trim().slice(0, 400);
  } catch {
    return "";
  }
}

function previewText(value: string, maxLength = 120): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3)}...`;
}

function describeIgnoredMessage(data: any): string {
  if (!data?.message?.message_id) return "missing message id";
  if (!data?.message?.chat_id) return "missing chat id";
  if (typeof data?.message?.content !== "string") return "missing string content";

  const content = parseJson(data.message.content);
  if (!content) return "message content is not valid JSON";
  if (!extractIncomingText(content).trim()) {
    return `unsupported content keys: ${Object.keys(content).join(", ") || "(none)"}`;
  }
  if (!extractIncomingText(content).trim()) return "empty text";
  return "unknown";
}
