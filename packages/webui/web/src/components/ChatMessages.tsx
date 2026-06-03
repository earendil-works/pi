import type { Message } from "../lib/api";
import { MessageBubble } from "./message/MessageBubble";

interface ChatMessagesProps {
  messages: Message[];
}

function mergeMessages(messages: Message[]): Message[] {
  const result: Message[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      // Collect consecutive toolResult messages that follow this assistant message
      const merged = { ...msg, parts: [...msg.parts] };
      let j = i + 1;
      while (j < messages.length && messages[j].role === "toolResult") {
        merged.parts.push(...messages[j].parts);
        j++;
      }
      result.push(merged);
      i = j;
    } else {
      result.push(msg);
      i++;
    }
  }
  return result;
}

export default function ChatMessages({ messages }: ChatMessagesProps) {
  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-stone-400">
        <p className="text-sm">No messages yet</p>
        <p className="text-xs">Send a message to start the conversation</p>
      </div>
    );
  }

  const merged = mergeMessages(messages);

  return (
    <div className="flex flex-col">
      {merged.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}
    </div>
  );
}
