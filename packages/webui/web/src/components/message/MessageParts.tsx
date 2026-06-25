import { useEffect, useReducer, useState } from "react";
import {
  Brain, Database, Terminal, Globe, FolderOpen, ListTodo,
  Wrench, Image as ImageIcon, ChevronRight, Wrench as ToolsIcon
} from "lucide-react";
import type {
  TextPart, ThinkingPart, ToolCallPart, ToolResultPart, ImagePart, Part
} from "../../lib/api";
import { Markdown } from "../Markdown";
import { AskUserQuestionCard } from "../AskUserQuestionCard";
import type { CardState } from "../AskUserQuestionCard";

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
        <div className="mt-1 max-h-96 overflow-auto bg-gray-50 p-2 rounded border border-gray-200">
          <Markdown text={part.text} />
        </div>
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
  // The assistant emits GitHub-flavored markdown: bold, italic, lists,
  // tables, code blocks, etc. Render as HTML so the user sees proper
  // structure (the alternative — raw `**foo**` and `|---|---|` — is
  // unreadable for long reports).
  return <Markdown text={part.text} />;
}

// ToolGroup: collect all tool calls + tool results + images into one container with separators.
// When the group is large (> COLLAPSE_THRESHOLD items), default to a
// collapsed summary so a single turn that fired 10+ tools doesn't flood
// the bubble vertically. The user can click to expand and see all rows.
const COLLAPSE_THRESHOLD = 4;

function summarizeToolGroup(parts: Part[]): { total: number; text: string } {
  // Count tool calls by name. The intent is "read what the agent did at a
  // glance" without scrolling through 14 rows. The total is the number of
  // distinct tool invocations (not parts.length which would double-count
  // each toolResult), and the text is a per-name breakdown.
  const counts = new Map<string, number>();
  let images = 0;
  let total = 0;
  for (const p of parts) {
    if (p.type === "toolCall") {
      counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
      total += 1;
    } else if (p.type === "image") {
      images += 1;
      total += 1;
    }
  }
  const segments: string[] = [];
  for (const [name, n] of counts) segments.push(`${name} ×${n}`);
  if (images > 0) segments.push(`image${images > 1 ? "s" : ""} ×${images}`);
  return { total, text: segments.join(", ") };
}

function ToolGroup({
  parts,
  cardStates,
  onCardSubmit,
  onCardCancel,
}: {
  parts: Part[];
  cardStates?: Map<string, CardState>;
  onCardSubmit?: (id: string, value: string) => void;
  onCardCancel?: (id: string) => void;
}) {
  const summary = summarizeToolGroup(parts);
  const [open, setOpen] = useState(summary.total <= COLLAPSE_THRESHOLD);
  const tooMany = summary.total > COLLAPSE_THRESHOLD;
  const Icon = ToolsIcon;
  if (tooMany && !open) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white px-3 py-2">
        <button
          onClick={() => setOpen(true)}
          className="w-full text-left flex items-center gap-2 text-gray-700 hover:bg-gray-50 py-1 px-1 rounded text-sm"
        >
          <Icon className="w-3.5 h-3.5 text-gray-500 shrink-0" />
          <span className="font-medium">{summary.total} tool calls</span>
          <span className="text-gray-500 text-xs truncate flex-1">
            {summary.text}
          </span>
          <ChevronRight className="w-3 h-3 text-gray-400 shrink-0" />
        </button>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 flex flex-col">
      {tooMany && (
        <button
          onClick={() => setOpen(false)}
          className="text-xs text-gray-500 hover:text-gray-700 self-end mb-1 inline-flex items-center gap-1"
        >
          <ChevronRight className="w-3 h-3 rotate-90" />
          <span>收起 ({summary.total} tools)</span>
        </button>
      )}
      {parts.map((part, i) => {
        switch (part.type) {
          case "toolCall":
            // ask_user_question cards are rendered from CardState data,
            // not as raw ToolCallItem. If the card state exists, show the
            // interactive card; otherwise fall back to the generic tool item.
            if (part.name === "ask_user_question") {
              const cardState = cardStates?.get(part.id);
              if (cardState) {
                return (
                  <AskUserQuestionCard
                    key={`card-${part.id}`}
                    question={cardState.question}
                    options={cardState.options}
                    multiSelect={cardState.multiSelect}
                    status={cardState.status}
                    selected={cardState.selected}
                    onSubmit={(value) => onCardSubmit?.(part.id, value)}
                    onCancel={() => onCardCancel?.(part.id)}
                  />
                );
              }
            }
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

// StepHeader: status row above the body. Shows streaming/completed icon,
// status text, elapsed seconds (ticks every 1s), and a chevron. Clicking
// the header toggles the body's visibility; the parent decides how to
// interpret the toggle.
interface StepHeaderProps {
  isStreaming: boolean;
  startedAt: Date;
  open: boolean;
  onToggle: () => void;
}

function StepHeader({ isStreaming, startedAt, open, onToggle }: StepHeaderProps) {
  const [, forceTick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const id = setInterval(forceTick, 1000);
    return () => clearInterval(id);
  }, []);
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000));
  const icon = isStreaming ? "\u25CF" : "\u2713";
  const iconColor = isStreaming ? "text-blue-500" : "text-green-600";
  const statusText = isStreaming ? "Executing" : "Completed";
  const chevron = open ? "\u25BC" : "\u25B2";
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-gray-50 rounded"
    >
      <span className={`font-bold ${iconColor}`}>{icon}</span>
      <span className="font-medium">{statusText}</span>
      <span className="text-gray-500">({seconds}s)</span>
      <span className="ml-auto text-gray-400">{chevron}</span>
    </button>
  );
}

// Main exported component: render parts in chronological order so the
// user sees: thinking → text → toolCall → toolResult → thinking → text
// → toolCall → toolResult → ... → final text. Consecutive tool-related
// parts (toolCall + toolResult + image) are wrapped in a single bordered
// box via ToolGroup for visual cohesion.
//
// When the turn contains step-shaped content (thinking, tool calls,
// tool results, or images), the whole thing is wrapped in a collapsible
// step container with a StepHeader above the body. Pure-text turns skip
// the wrapper so a plain reply doesn't gain visual chrome.
export function MessageParts({
  parts,
  isStreaming = true,
  timestamp,
  cardStates,
  onCardSubmit,
  onCardCancel,
}: {
  parts: Part[];
  isStreaming?: boolean;
  timestamp?: string;
  cardStates?: Map<string, CardState>;
  onCardSubmit?: (id: string, value: string) => void;
  onCardCancel?: (id: string) => void;
}) {
  if (parts.length === 0) {
    return <div className="text-xs text-gray-400 italic">(empty turn)</div>;
  }

  const hasStepContent = parts.some(
    (p) =>
      p.type === "thinking" ||
      p.type === "toolCall" ||
      p.type === "toolResult" ||
      p.type === "image",
  );

  // Walk parts and build a list of "chunks" — each chunk is either
  // (a) a sequence of consecutive toolCall/toolResult/image parts, or
  // (b) a single thinking or text item.
  //
  // Each `kind` narrows its payload so downstream consumers don't need
  // runtime type checks: `chunk.kind === "text"` ⇒ `chunk.part: TextPart`,
  // `chunk.kind === "thinking"` ⇒ `chunk.part: ThinkingPart`, etc.
  type Chunk =
    | { kind: "tools"; parts: Part[] }
    | { kind: "thinking"; part: ThinkingPart }
    | { kind: "text"; part: TextPart };
  const chunks: Chunk[] = [];
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (p.type === "toolCall" || p.type === "toolResult" || p.type === "image") {
      const toolChunk: Part[] = [];
      while (
        i < parts.length &&
        (parts[i].type === "toolCall" ||
          parts[i].type === "toolResult" ||
          parts[i].type === "image")
      ) {
        toolChunk.push(parts[i]);
        i++;
      }
      chunks.push({ kind: "tools", parts: toolChunk });
    } else if (p.type === "thinking") {
      if (p.text.trim()) chunks.push({ kind: "thinking", part: p });
      i++;
    } else {
      // p.type === "text" by elimination (Part = text | thinking | toolCall | toolResult | image)
      chunks.push({ kind: "text", part: p });
      i++;
    }
  }

  // Split chunks into inference (wrapped in the fold) and text (rendered
  // outside the fold, always visible). The fold auto-collapses on
  // `isStreaming=false` so the user can hide long CoT / tool chains, but
  // the agent's reply text stays visible below the fold so it is never
  // hidden inside a collapsed step.
  const inferenceChunks = chunks.filter(
    (c): c is Exclude<Chunk, { kind: "text" }> => c.kind !== "text",
  );
  const textChunks = chunks.filter(
    (c): c is Extract<Chunk, { kind: "text" }> => c.kind === "text",
  );

  if (!hasStepContent) {
    return (
      <div className="flex flex-col gap-2">
        {textChunks.map((chunk, i) => (
          <TextItem key={`tx-${i}`} part={chunk.part} />
        ))}
      </div>
    );
  }

  // `userOverride` is the user's last click on the header. Null means
  // "follow isStreaming". This makes the body auto-collapse when the
  // stream ends (isStreaming → false) without losing a deliberate user
  // expansion: a clicked-open step stays open across stream transitions.
  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  // If any toolCall in this step has an active AskUserQuestionCard state,
  // force the body open so the card stays visible. When the agent pauses
  // on `ask_user_question`, isStreaming is false (waiting for user input),
  // and without this override the body would auto-collapse, hiding the
  // card. Re-evaluated on every render: when the card leaves cardStates
  // (user answered or tool_execution_end arrived), normal behavior resumes.
  const hasActiveCard = parts.some(
    (p) => p.type === "toolCall" && cardStates?.has(p.id),
  );
  const open = hasActiveCard ? true : (userOverride ?? isStreaming);
  const startedAt = timestamp ? new Date(timestamp) : new Date();

  return (
    <>
      {inferenceChunks.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 flex flex-col gap-2">
          <StepHeader
            isStreaming={isStreaming}
            startedAt={startedAt}
            open={open}
            onToggle={() => setUserOverride(!open)}
          />
          {open && (
            <div className="flex flex-col gap-2 border-t border-gray-100 pt-2">
              {inferenceChunks.map((chunk, i) =>
                chunk.kind === "tools" ? (
                  <ToolGroup
                    key={`tg-${i}`}
                    parts={chunk.parts}
                    cardStates={cardStates}
                    onCardSubmit={onCardSubmit}
                    onCardCancel={onCardCancel}
                  />
                ) : (
                  // chunk.kind === "thinking" — inferenceChunks excludes text
                  <ThinkingItem key={`th-${i}`} part={chunk.part} />
                ),
              )}
            </div>
          )}
        </div>
      )}
      {textChunks.map((chunk, i) => (
        <TextItem key={`tx-${i}`} part={chunk.part} />
      ))}
    </>
  );
}
