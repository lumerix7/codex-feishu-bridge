export type FeishuConversationKey = string;
export type CodexSessionId = string;

export interface SessionBinding {
  conversationKey: FeishuConversationKey;
  codexSessionId?: CodexSessionId;
  project: string;
  searchEnabled?: boolean;
  model?: string;
  profile?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActiveRun {
  conversationKey: FeishuConversationKey;
  codexSessionId: CodexSessionId;
  runId: string;
  startedAt: string;
  status: "starting" | "running" | "stopping";
}

export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group" | "unknown";
  threadId?: string;
  rootId?: string;
  senderOpenId?: string;
  text: string;
}

export interface OutgoingMessage {
  chatId: string;
  title?: string;
  text?: string;
  template?: "blue" | "wathet" | "turquoise" | "green" | "yellow" | "orange" | "red" | "carmine" | "violet" | "purple" | "indigo" | "grey" | "default";
  footer?: string;
  replyToMessageId?: string;
  threadId?: string;
  streaming?: boolean;
  streamKey?: string;
  finalizeStreaming?: boolean;
  includeRawMarkdown?: boolean;
}
