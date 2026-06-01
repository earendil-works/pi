import type { Message } from "../lib/api";
import { User, Bot } from "lucide-react";

interface ChatMessagesProps {
  messages: Message[];
  streamingContent?: string;
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";

  return (
    <div
      className={`flex gap-3 px-4 py-3 ${
        isUser ? "bg-blue-50" : "bg-white"
      }`}
    >
      <div className="shrink-0">
        {isUser ? (
          <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center">
            <User className="w-4 h-4 text-white" />
          </div>
        ) : (
          <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center">
            <Bot className="w-4 h-4 text-gray-600" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium text-gray-500">
            {isUser ? "You" : "Assistant"}
          </span>
          <span className="text-xs text-gray-400">
            {new Date(message.timestamp).toLocaleTimeString()}
          </span>
        </div>
        <div className="text-sm text-gray-800 whitespace-pre-wrap break-words">
          {message.content}
        </div>
      </div>
    </div>
  );
}

function StreamingBubble({ content }: { content: string }) {
  return (
    <div className="flex gap-3 px-4 py-3 bg-white">
      <div className="shrink-0">
        <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center">
          <Bot className="w-4 h-4 text-gray-600" />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium text-gray-500">Assistant</span>
          <span className="text-xs text-gray-400">streaming...</span>
        </div>
        <div className="text-sm text-gray-800 whitespace-pre-wrap break-words">
          {content}
          <span className="inline-block w-2 h-4 bg-blue-600 animate-pulse ml-1 align-middle" />
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-gray-400">
      <Bot className="w-12 h-12" />
      <p className="text-sm">No messages yet</p>
      <p className="text-xs">Send a message to start the conversation</p>
    </div>
  );
}

export default function ChatMessages({ messages, streamingContent }: ChatMessagesProps) {
  if (messages.length === 0 && !streamingContent) {
    return <EmptyState />;
  }

  return (
    <div className="flex flex-col gap-1">
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}
      {streamingContent !== undefined && streamingContent !== "" && (
        <StreamingBubble content={streamingContent} />
      )}
    </div>
  );
}