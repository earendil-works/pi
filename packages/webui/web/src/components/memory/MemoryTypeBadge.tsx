import type { MemoryAtomType } from "../../lib/api";

interface MemoryTypeBadgeProps {
  type: MemoryAtomType;
}

const TYPE_COLOR: Record<MemoryAtomType, { bg: string; text: string; label: string }> = {
  rule:    { bg: "bg-red-100", text: "text-red-800", label: "rule" },
  fact:    { bg: "bg-blue-100", text: "text-blue-800", label: "fact" },
  process: { bg: "bg-purple-100", text: "text-purple-800", label: "process" },
};

export function MemoryTypeBadge({ type }: MemoryTypeBadgeProps) {
  const c = TYPE_COLOR[type];
  return (
    <span className={`inline-flex items-center ${c.bg} ${c.text} rounded px-2 py-0.5 text-xs font-medium`}>
      {c.label}
    </span>
  );
}
