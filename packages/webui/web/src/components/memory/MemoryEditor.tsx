import { useMemo, useState } from "react";
import type { MemoryAtom, MemoryAtomType } from "../../lib/api";
import { Markdown } from "../Markdown";

interface MemoryEditorProps {
  atom: MemoryAtom;
  onSave: (patch: Partial<MemoryAtom>) => Promise<void>;
  onArchive: () => void;
  /**
   * Immediate flush — bypasses the 3s debounce. Wired to the "Save now" button
   * so that clicking it actually persists right away. Per-keystroke saves still
   * flow through `onSave` → parent → useAutoSave debounce; this prop is for
   * the explicit-save path only.
   */
  onFlush?: () => Promise<void>;
}

const TYPES: MemoryAtomType[] = ["rule", "fact", "process"];

export function MemoryEditor({ atom, onSave, onArchive, onFlush }: MemoryEditorProps) {
  // 本地编辑态 (parent 通过重新传 atom 触发 reset)
  const [title, setTitle] = useState(atom.title);
  const [type, setType] = useState<MemoryAtomType>(atom.type);
  const [importance, setImportance] = useState(atom.importance);
  const [tagsText, setTagsText] = useState(atom.tags.join(", "));
  const [summary, setSummary] = useState(atom.summary);
  const [content, setContent] = useState(atom.content);
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 同步 prop 变化 (父组件轮询拿新 atom 时)
  const initialKey = useMemo(() => atom.id + "@" + atom.updated_at, [atom.id, atom.updated_at]);
  const [lastResetKey, setLastResetKey] = useState(initialKey);
  if (lastResetKey !== initialKey) {
    setTitle(atom.title);
    setType(atom.type);
    setImportance(atom.importance);
    setTagsText(atom.tags.join(", "));
    setSummary(atom.summary);
    setContent(atom.content);
    setLastResetKey(initialKey);
  }

  const reportChange = (patch: Partial<MemoryAtom>) => {
    if (Object.keys(patch).length === 0) return;
    void onSave(patch);
  };

  const handleTitleChange = (v: string) => {
    setTitle(v);
    if (v !== atom.title) reportChange({ title: v });
  };
  const handleTypeChange = (v: MemoryAtomType) => {
    setType(v);
    if (v !== atom.type) reportChange({ type: v });
  };
  const handleImportanceChange = (v: number) => {
    setImportance(v);
    if (v !== atom.importance) reportChange({ importance: v });
  };
  const handleTagsChange = (v: string) => {
    setTagsText(v);
    const tags = v.split(",").map((s) => s.trim()).filter(Boolean);
    const tagsSame =
      tags.length === atom.tags.length && tags.every((t, i) => t === atom.tags[i]);
    if (!tagsSame) reportChange({ tags });
  };
  const handleSummaryChange = (v: string) => {
    setSummary(v);
    if (v !== atom.summary) reportChange({ summary: v });
  };
  const handleContentChange = (v: string) => {
    setContent(v);
    if (v !== atom.content) reportChange({ content: v });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      // Save now bypasses the 3s debounce — it flushes the parent's
      // useAutoSave buffer directly. The patch itself was already pushed via
      // onSave on each keystroke; flush just makes it land immediately.
      await onFlush?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* metadata form */}
      <div className="p-3 space-y-2 border-b border-gray-200">
        <div>
          <label className="text-xs text-gray-500 block">title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            data-field="title"
            className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
          />
        </div>
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-xs text-gray-500 block">type</label>
            <select
              value={type}
              onChange={(e) => handleTypeChange(e.target.value as MemoryAtomType)}
              className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className="text-xs text-gray-500 block">
              importance {importance.toFixed(2)}
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={importance}
              onChange={(e) => handleImportanceChange(Number(e.target.value))}
              className="w-full"
            />
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-500 block">tags (comma-separated)</label>
          <input
            type="text"
            value={tagsText}
            onChange={(e) => handleTagsChange(e.target.value)}
            className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-gray-500 block">summary</label>
          <textarea
            value={summary}
            onChange={(e) => handleSummaryChange(e.target.value)}
            rows={2}
            className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
          />
        </div>
      </div>
      {/* body editor */}
      <div className="flex-1 flex flex-col min-h-0">
        {atom.hash_mismatch && (
          <div
            data-testid="memory-error"
            className="bg-red-50 border-b border-red-200 px-3 py-2 text-xs text-red-800"
          >
            <strong>file hash mismatch</strong> — another atom with the same
            title overwrote this file. The original body is no longer
            recoverable; restoring requires manual git/recovery of the
            underlying markdown.
          </div>
        )}
        <div className="flex gap-1 border-b border-gray-200 px-3 py-1 text-xs">
          <button
            type="button"
            onClick={() => setTab("edit")}
            className={`px-2 py-0.5 ${tab === "edit" ? "bg-gray-900 text-white" : "text-gray-600"} rounded`}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => setTab("preview")}
            className={`px-2 py-0.5 ${tab === "preview" ? "bg-gray-900 text-white" : "text-gray-600"} rounded`}
          >
            Preview
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {tab === "edit" ? (
            <textarea
              value={content}
              onChange={(e) => handleContentChange(e.target.value)}
              data-field="content"
              className="w-full h-full p-3 font-mono text-sm border-0 resize-none focus:outline-none"
            />
          ) : (
            <div className="p-3 prose prose-sm max-w-none"><Markdown text={content} /></div>
          )}
        </div>
      </div>
      {/* footer */}
      <div className="border-t border-gray-200 p-2 flex justify-between items-center text-xs">
        <div className="text-red-600">{error}</div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onArchive}
            className="border border-gray-300 rounded px-3 py-0.5 hover:bg-gray-100"
          >
            {atom.archived ? "Restore" : "Archive"}
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="border border-gray-900 bg-gray-900 text-white rounded px-3 py-0.5 hover:bg-gray-700 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save now"}
          </button>
        </div>
      </div>
    </div>
  );
}
