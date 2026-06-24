import type { Message, Part } from "../lib/api";
import { MessageBubble } from "./message/MessageBubble";
import type { CardState } from "./AskUserQuestionCard";

interface ChatMessagesProps {
  messages: Message[];
  cardStates?: Map<string, CardState>;
  onCardSubmit?: (id: string, value: string) => void;
  onCardCancel?: (id: string) => void;
  isLastMessageStreaming?: boolean;
}

/**
 * Group messages into turns.
 *
 * A turn = (user message)? + 0..N consecutive assistant+toolResult messages.
 * The same agent turn can interleave many (assistant toolCall) -> (toolResult)
 * -> (assistant toolCall) -> (toolResult) -> ... -> (assistant final text)
 * sequences as it thinks out loud; we want all of those in one bubble.
 *
 * toolResult messages are absorbed into the preceding assistant bubble.
 * User messages are kept as their own bubbles (one per user prompt).
 */
function groupTurns(messages: Message[]): Message[] {
  const out: Message[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === "user") {
      out.push(m);
      i++;
      continue;
    }
    // Start of an assistant turn (possibly already seen toolResults, but the
    // outer while skips them by jumping past).
    const parts: Part[] = [];
    const seenIds = new Set<string>(); // dedupe parts by some content key
    let model: string | undefined;
    let provider: string | undefined;
    let usage: Message["usage"];
    let lastTimestamp = m.timestamp;
    let lastId = m.id;
    // The assistant message itself: contribute its parts.
    for (const p of m.parts) {
      const k = `${p.type}:${(p as any).text ?? (p as any).id ?? (p as any).toolCallId ?? ""}`;
      if (seenIds.has(k)) continue;
      seenIds.add(k);
      parts.push(p);
    }
    if (m.model) model = m.model;
    if (m.provider) provider = m.provider;
    if (m.usage) usage = m.usage;
    i++;
    // Now consume every (toolResult | assistant) until we hit a user message.
    // toolResults are absorbed; the next assistant extends the same turn.
    while (i < messages.length && messages[i].role !== "user") {
      const next = messages[i];
      if (next.role === "toolResult") {
        for (const p of next.parts) {
          const k = `${p.type}:${(p as any).toolCallId ?? (p as any).text ?? ""}`;
          if (seenIds.has(k)) continue;
          seenIds.add(k);
          parts.push(p);
        }
        i++;
      } else if (next.role === "assistant") {
        for (const p of next.parts) {
          const k = `${p.type}:${(p as any).text ?? (p as any).id ?? (p as any).toolCallId ?? ""}`;
          if (seenIds.has(k)) continue;
          seenIds.add(k);
          parts.push(p);
        }
        if (next.model && !model) model = next.model;
        if (next.provider && !provider) provider = next.provider;
        if (next.usage && !usage) usage = next.usage;
        // Use the most recent timestamp for the bubble header
        if (next.timestamp > lastTimestamp) lastTimestamp = next.timestamp;
        // Use the latest id for React keys
        lastId = next.id;
        i++;
      } else {
        // Unknown role — break out to avoid infinite loop
        break;
      }
    }
    out.push({
      id: lastId,
      sessionId: m.sessionId,
      role: "assistant",
      parts,
      timestamp: lastTimestamp,
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(usage ? { usage } : {}),
    });
  }
  return out;
}

export default function ChatMessages({ messages, cardStates, onCardSubmit, onCardCancel, isLastMessageStreaming }: ChatMessagesProps) {
  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-stone-400">
        <p className="text-sm">No messages yet</p>
        <p className="text-xs">Send a message to start the conversation</p>
      </div>
    );
  }

  const turns = groupTurns(messages);

  return (
    <div className="flex flex-col">
      {turns.map((message, i) => (
        <MessageBubble
          key={message.id}
          message={message}
          cardStates={cardStates}
          onCardSubmit={onCardSubmit}
          onCardCancel={onCardCancel}
          isStreaming={Boolean(isLastMessageStreaming) && i === turns.length - 1}
        />
      ))}
    </div>
  );
}
