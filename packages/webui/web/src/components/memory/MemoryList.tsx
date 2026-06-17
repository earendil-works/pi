import { useMemo } from "react";
import type { MemoryAtom, MemoryAtomType } from "../../lib/api";
import { MemoryTypeBadge } from "./MemoryTypeBadge";

export interface MemoryListFilters {
  types: MemoryAtomType[];          // empty = all types
  archived: "active" | "archived" | "all";
  tag: string;
  q: string;
}

interface MemoryListProps {
  atoms: MemoryAtom[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onArchive: (id: string) => void;
  filters: MemoryListFilters;
  onFilterChange: (f: MemoryListFilters) => void;
  onRefresh: () => void;
}

const TYPES: MemoryAtomType[] = ["constraint", "preference", "workflow", "knowledge", "event", "solution", "insight", "bug"];

function timeAgo(iso: string): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diffMs)) return "—";
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 1) return "<1h ago";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function MemoryList({ atoms, selectedId, onSelect, onArchive, filters, onFilterChange, onRefresh }: MemoryListProps) {
  // 客户端再做一次过滤 (server 已 filter 过; 这里用于乐观更新)
  const filtered = useMemo(() => {
    let list = atoms;
    if (filters.types.length > 0) {
      list = list.filter((a) => filters.types.includes(a.type));
    }
    if (filters.archived === "active") list = list.filter((a) => !a.archived);
    if (filters.archived === "archived") list = list.filter((a) => a.archived);
    if (filters.tag.trim()) list = list.filter((a) => a.tags.includes(filters.tag.trim()));
    if (filters.q.trim()) {
      const q = filters.q.toLowerCase();
      list = list.filter((a) =>
        a.title.toLowerCase().includes(q) || a.summary.toLowerCase().includes(q),
      );
    }
    return list;
  }, [atoms, filters]);

  const toggleType = (t: MemoryAtomType) => {
    const next = filters.types.includes(t)
      ? filters.types.filter((x) => x !== t)
      : [...filters.types, t];
    onFilterChange({ ...filters, types: next });
  };

  return (
    <div className="flex flex-col h-full">
      {/* 过滤栏 */}
      <div className="border-b border-gray-200 p-2 space-y-2 text-xs">
        {/* type 多选 chips */}
        <div className="flex flex-wrap gap-1">
          {TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => toggleType(t)}
              className={`px-2 py-0.5 rounded border ${filters.types.includes(t) ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-700 border-gray-300"}`}
            >
              {t}
            </button>
          ))}
        </div>
        {/* archived radio */}
        <div className="flex gap-3">
          {(["active", "archived", "all"] as const).map((mode) => (
            <label key={mode} className="flex items-center gap-1">
              <input
                type="radio"
                name="archived"
                checked={filters.archived === mode}
                onChange={() => onFilterChange({ ...filters, archived: mode })}
              />
              <span>{mode}</span>
            </label>
          ))}
        </div>
        {/* tag input + q input + refresh */}
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="tag"
            value={filters.tag}
            onChange={(e) => onFilterChange({ ...filters, tag: e.target.value })}
            className="border border-gray-300 rounded px-2 py-0.5 flex-1"
          />
          <input
            type="text"
            placeholder="search title/summary"
            value={filters.q}
            onChange={(e) => onFilterChange({ ...filters, q: e.target.value })}
            className="border border-gray-300 rounded px-2 py-0.5 flex-1"
          />
          <button
            type="button"
            onClick={onRefresh}
            className="border border-gray-300 rounded px-2 py-0.5 hover:bg-gray-100"
          >
            Refresh
          </button>
        </div>
        {/* count */}
        <div className="text-gray-500">{filtered.length} / {atoms.length} atoms</div>
      </div>
      {/* 列表 */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-4 text-sm text-gray-500">No matches</div>
        ) : (
          filtered.map((a) => (
            <div
              key={a.id}
              data-atom-id={a.id}
              onClick={() => onSelect(a.id)}
              className={`p-2 border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${selectedId === a.id ? "bg-blue-50" : ""}`}
            >
              <div className="flex items-center gap-2 mb-1">
                <MemoryTypeBadge type={a.type} />
                <span className="font-medium text-sm truncate flex-1">{a.title}</span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onArchive(a.id); }}
                  className="text-xs text-red-600 hover:underline px-1"
                >
                  {a.archived ? "Restore" : "Archive"}
                </button>
              </div>
              <div className="text-xs text-gray-500">
                str={a.strength.toFixed(2)} imp={a.importance.toFixed(2)} last={timeAgo(a.updated_at || a.created_at)}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
