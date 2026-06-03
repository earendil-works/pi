import { useState } from "react";
import {
  Brain, Database, Terminal, Globe, FolderOpen, ListTodo,
  Wrench, Image as ImageIcon, ChevronRight
} from "lucide-react";
import type {
  TextPart, ThinkingPart, ToolCallPart, ToolResultPart, ImagePart, Part
} from "../../lib/api";

// Helper: pick icon for tool name
function toolIcon(name: string) {
  switch (name) {
    case "read": return FolderOpen;
    case "bash": return Terminal;
    case "web_search":
    case "web_fetch": return Globe;
    case "todowrite":
    case "todoread": return ListTodo;
    case "read_image":
    case "image_read": return ImageIcon;
    default: return Wrench;
  }
}

// Helper: friendly summary for tool call
function summarizeToolCall(part: ToolCallPart): string {
  const a = part.args as Record<string, unknown>;
  if (typeof a.path === "string") return a.path;
  if (typeof a.query === "string") return a.query;
  if (typeof a.command === "string") return a.command.split("\n")[0].slice(0, 80);
  if (typeof a.prompt === "string") return a.prompt.slice(0, 80);
  if (typeof a.name === "string") return a.name;
  // First string arg
  for (const v of Object.values(a)) {
    if (typeof v === "string") return v.slice(0, 80);
  }
  return "";
}

// Helper: friendly summary for tool result (first non-empty line)
function summarizeToolResult(content: string): { text: string; bytes: number } {
  const lines = content.split("\n");
  const first = lines.find((l) => l.trim().length > 0) ?? "";
  return {
    text: first.slice(0, 80),
    bytes: new TextEncoder().encode(content).length,
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

// Thinking item
function ThinkingItem({ part, defaultOpen = false }: { part: ThinkingPart; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="text-sm">
      <button
        onClick={() => setOpen(!open)}
        className="text-gray-500 hover:text-gray-700 inline-flex items-center gap-1.5"
      >
        <Brain className="w-3.5 h-3.5" />
        <span className="italic">思考</span>
        {open ? <span className="text-xs">(收起)</span> : <span className="text-xs">(展开)</span>}
      </button>
      {open && (
        <pre className="mt-1 text-xs bg-gray-50 p-2 rounded border border-gray-200 max-h-96 overflow-auto whitespace-pre-wrap font-mono text-gray-700">
          {part.text}
        </pre>
      )}
    </div>
  );
}

// Tool call item (collapsible summary + full args)
function ToolCallItem({ part }: { part: ToolCallPart }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(part.name);
  const summary = summarizeToolCall(part);
  return (
    <div className="text-sm">
      <button
        onClick={() => setOpen(!open)}
        className="w-full text-left flex items-center gap-2 text-gray-800 hover:bg-gray-50 py-1 px-1 rounded"
      >
        <Icon className="w-3.5 h-3.5 text-gray-500 shrink-0" />
        <span className="font-medium">{part.name}</span>
        {summary && (
          <span className="text-gray-500 text-xs truncate flex-1">{summary}</span>
        )}
        <ChevronRight className={`w-3 h-3 text-gray-400 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <pre className="ml-5 mt-1 text-xs bg-gray-50 p-2 rounded border border-gray-200 font-mono whitespace-pre-wrap break-all">
          {JSON.stringify(part.args, null, 2)}
        </pre>
      )}
    </div>
  );
}

// Tool result item (collapsible summary + full content)
function ToolResultItem({ part }: { part: ToolResultPart }) {
  const [open, setOpen] = useState(false);
  const { text, bytes } = summarizeToolResult(part.content);
  return (
    <div className="text-sm">
      <button
        onClick={() => setOpen(!open)}
        className="w-full text-left flex items-center gap-2 text-gray-700 hover:bg-gray-50 py-1 pl-5 pr-1 rounded"
      >
        <span className="text-gray-400 text-xs">↪</span>
        <span className="text-gray-700 text-xs truncate flex-1">
          {text || "(empty)"}
        </span>
        <span className="text-gray-400 text-xs shrink-0">{formatBytes(bytes)}</span>
        <ChevronRight className={`w-3 h-3 text-gray-400 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <pre className="ml-5 mt-1 text-xs bg-gray-50 p-2 rounded border border-gray-200 max-h-96 overflow-auto font-mono whitespace-pre-wrap break-all text-gray-800">
          {part.content}
        </pre>
      )}
    </div>
  );
}

// Image item
function ImageItem({ part }: { part: ImagePart }) {
  return (
    <div className="my-1">
      <img
        src={`data:${part.mediaType};base64,${part.data}`}
        alt="image"
        className="max-w-full max-h-96 rounded border border-gray-200"
      />
    </div>
  );
}

// Text item
function TextItem({ part }: { part: TextPart }) {
  return (
    <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">
      {part.text}
    </p>
  );
}

// ToolGroup: collect all tool calls + tool results + images into one container with separators
function ToolGroup({ parts }: { parts: Part[] }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 flex flex-col">
      {parts.map((part, i) => {
        switch (part.type) {
          case "toolCall":
            return <ToolCallItem key={`tc-${i}`} part={part} />;
          case "toolResult":
            return <ToolResultItem key={`tr-${i}`} part={part} />;
          case "image":
            return <ImageItem key={`img-${i}`} part={part} />;
          default:
            return null;
        }
      })}
    </div>
  );
}

// Main exported component: group parts into thinking / toolgroup / text
export function MessageParts({ parts }: { parts: Part[] }) {
  if (parts.length === 0) {
    return <div className="text-xs text-gray-400 italic">(empty turn)</div>;
  }

  const thinkingParts: ThinkingPart[] = [];
  const toolParts: Part[] = [];
  const textParts: TextPart[] = [];

  for (const p of parts) {
    if (p.type === "thinking") {
      if (p.text.trim()) thinkingParts.push(p);
    } else if (p.type === "toolCall" || p.type === "toolResult" || p.type === "image") toolParts.push(p);
    else if (p.type === "text") textParts.push(p);
  }

  return (
    <div className="flex flex-col gap-2">
      {thinkingParts.length > 0 && (
        <div className="flex flex-col gap-1">
          {thinkingParts.map((p, i) => (
            <ThinkingItem key={`th-${i}`} part={p} />
          ))}
        </div>
      )}
      {toolParts.length > 0 && <ToolGroup parts={toolParts} />}
      {textParts.length > 0 && (
        <div className="flex flex-col gap-1">
          {textParts.map((p, i) => (
            <TextItem key={`tx-${i}`} part={p} />
          ))}
        </div>
      )}
    </div>
  );
}
