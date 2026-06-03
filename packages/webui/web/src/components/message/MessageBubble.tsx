import type { JSX } from "react";
import type { Message } from "../../lib/api";
import { MessageHeader } from "./MessageHeader";
import { MessageParts } from "./MessageParts";
import { MessageFooter } from "./MessageFooter";

export function MessageBubble({ message }: { message: Message }): JSX.Element | null {
  if (message.role === "user") {
    const textParts = message.parts.filter((p) => p.type === "text");
    const imageParts = message.parts.filter((p) => p.type === "image");
    const combinedText = textParts.map((p) => (p as { type: "text"; text: string }).text).join("");

    return (
      <div className="flex justify-end px-4 py-2">
        <div className="max-w-[70%] space-y-1">
          {imageParts.length > 0 && (
            <div className="flex gap-1 justify-end">
              {imageParts.map((p, i) => {
                const img = p as { type: "image"; mediaType: string; data: string };
                return (
                  <img
                    key={i}
                    src={`data:${img.mediaType};base64,${img.data}`}
                    alt="image"
                    className="w-10 h-10 object-cover rounded"
                    role="img"
                  />
                );
              })}
            </div>
          )}
          {combinedText && (
            <div className="bg-blue-500 text-white rounded-lg px-3 py-2 text-sm">
              {combinedText}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (message.role === "assistant") {
    return (
      <div className="px-4 py-3">
        <MessageHeader name="pi" timestamp={message.timestamp} model={message.model} />
        <MessageParts parts={message.parts} />
        <MessageFooter usage={message.usage} />
      </div>
    );
  }

  if (message.role === "toolResult") {
    const toolPart = message.parts.find((p) => p.type === "toolResult");
    const toolCallId = toolPart && "toolCallId" in toolPart ? toolPart.toolCallId : "unknown";
    return (
      <div className="px-4 py-2 text-xs text-stone-500">
        {toolCallId} result
      </div>
    );
  }

  return null;
}
