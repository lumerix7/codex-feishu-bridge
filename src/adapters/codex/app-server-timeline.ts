export type TimelineEntry =
  | { kind: "agent"; itemId: string; text: string; completed: boolean }
  | { kind: "event"; text: string };

export interface AppServerTimelineState {
  readonly timeline: TimelineEntry[];
  readonly agentEntryIndexById: Map<string, number>;
}

export function createAppServerTimelineState(): AppServerTimelineState {
  return {
    timeline: [],
    agentEntryIndexById: new Map<string, number>()
  };
}

export function appendEventBlock(state: AppServerTimelineState, text: string): void {
  const normalized = text.trim();
  if (!normalized) return;
  state.timeline.push({ kind: "event", text: normalized });
}

export function applyAgentDelta(
  state: AppServerTimelineState,
  itemId: string,
  delta: string
): string {
  const entry = ensureAgentEntry(state, itemId);
  entry.text = `${entry.text}${delta}`;
  return entry.text;
}

export function completeAgentText(
  state: AppServerTimelineState,
  itemId: string,
  text?: string
): string {
  const entry = ensureAgentEntry(state, itemId);
  if (text !== undefined) {
    entry.text = text.trim();
  }
  entry.completed = true;
  return entry.text;
}

export function buildVisibleTimelineText(state: AppServerTimelineState): string {
  const parts: string[] = [];
  for (const entry of state.timeline) {
    const text = entry.text.trim();
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("\n\n").trim();
}

function ensureAgentEntry(
  state: AppServerTimelineState,
  itemId: string
): Extract<TimelineEntry, { kind: "agent" }> {
  const existingIndex = state.agentEntryIndexById.get(itemId);
  if (existingIndex !== undefined) {
    return state.timeline[existingIndex] as Extract<TimelineEntry, { kind: "agent" }>;
  }
  const entry: Extract<TimelineEntry, { kind: "agent" }> = {
    kind: "agent",
    itemId,
    text: "",
    completed: false
  };
  state.agentEntryIndexById.set(itemId, state.timeline.length);
  state.timeline.push(entry);
  return entry;
}
