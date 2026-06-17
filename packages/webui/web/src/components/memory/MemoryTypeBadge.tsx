import type { MemoryAtomType } from "../../lib/api";

interface MemoryTypeBadgeProps {
  type: MemoryAtomType;
}

const TYPE_COLOR: Record<MemoryAtomType, { bg: string; text: string; label: string }> = {
  constraint: { bg: "bg-red-100", text: "text-red-800", label: "constraint" },
  preference: { bg: "bg-blue-100", text: "text-blue-800", label: "preference" },
  workflow:   { bg: "bg-purple-100", text: "text-purple-800", label: "workflow" },
  knowledge:  { bg: "bg-green-100", text: "text-green-800", label: "knowledge" },
  event:      { bg: "bg-amber-100", text: "text-amber-800", label: "event" },
  solution:   { bg: "bg-indigo-100", text: "text-indigo-800", label: "solution" },
  insight:    { bg: "bg-pink-100", text: "text-pink-800", label: "insight" },
  // 8th type — see task 6.7 / review-fail MEDIUM.
  bug:        { bg: "bg-yellow-100", text: "text-yellow-800", label: "bug" },
};

export function MemoryTypeBadge({ type }: MemoryTypeBadgeProps) {
  const c = TYPE_COLOR[type];
  return (
    <span className={`inline-flex items-center ${c.bg} ${c.text} rounded px-2 py-0.5 text-xs font-medium`}>
      {c.label}
    </span>
  );
}
