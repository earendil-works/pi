import type { Message } from "../lib/api";
import { MessageBubble } from "./message/MessageBubble";

interface ChatMessagesProps {
  messages: Message[];
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

  return (
    <div className="flex flex-col">
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}
    </div>
  );
}
