import { useEffect, useState } from "react";
import { api, type MemoryAtom, type MemoryStats } from "../lib/api";
import { MemoryList, type MemoryListFilters } from "../components/memory/MemoryList";
import { MemoryDetail } from "../components/memory/MemoryDetail";
import { MemorySearchTester } from "../components/memory/MemorySearchTester";

export function MemoryPage() {
  const [atoms, setAtoms] = useState<MemoryAtom[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<MemoryListFilters>({
    types: [],
    archived: "active",
    tag: "",
    q: "",
  });
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 3s polling fetch atoms + stats
  useEffect(() => {
    let alive = true;
    const fetchAll = async () => {
      try {
        const [list, s] = await Promise.all([
          api.memory.list({
            archived: filters.archived,
            type: filters.types.join(",") || undefined,
            tag: filters.tag || undefined,
            q: filters.q || undefined,
          }),
          api.memory.stats(),
        ]);
        if (alive) {
          setAtoms(list);
          setStats(s);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void fetchAll();
    const interval = setInterval(() => void fetchAll(), 3000);
    return () => { alive = false; clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const handleArchive = async (id: string) => {
    try {
      // optimistic: 立即从列表移除
      setAtoms((prev) => prev.filter((a) => a.id !== id));
      await api.memory.archive(id, true);
      // 重新拉 stats
      void api.memory.stats().then((s) => setStats(s));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // 失败回滚: 重新拉
      void api.memory.list({}).then((list) => setAtoms(list));
    }
  };

  const handleRefresh = () => {
    void api.memory.list({}).then((list) => setAtoms(list));
    void api.memory.stats().then((s) => setStats(s));
  };

  return (
    <div className="flex flex-col h-full">
      {error && <div className="bg-red-100 text-red-800 px-3 py-1 text-xs">{error}</div>}
      <div className="border-b border-gray-200 px-3 py-1 text-xs flex gap-3 items-center">
        <span className="font-medium">Memory</span>
        {stats && (
          <>
            <span>total: {stats.total}</span>
            <span>archived: {stats.archived}</span>
            <span>by type: {Object.entries(stats.byType).map(([t, n]) => `${t}=${n}`).join(", ") || "—"}</span>
          </>
        )}
      </div>
      <div className="flex-1 flex min-h-0">
        {/* 左 30%: list */}
        <div className="w-[30%] border-r border-gray-200 min-h-0">
          <MemoryList
            atoms={atoms}
            selectedId={selectedId ?? undefined}
            onSelect={(id) => setSelectedId(id)}
            onArchive={handleArchive}
            filters={filters}
            onFilterChange={setFilters}
            onRefresh={handleRefresh}
          />
        </div>
        {/* 右 70%: detail */}
        <div className="w-[70%] min-h-0">
          {selectedId ? (
            <MemoryDetail id={selectedId} onArchive={handleArchive} onListRefresh={handleRefresh} />
          ) : (
            <div className="p-4 text-sm text-gray-500">Select an atom from the list</div>
          )}
        </div>
      </div>
      {/* bottom: search tester */}
      <div className="max-h-64 overflow-auto">
        <MemorySearchTester onSelectAtom={(id) => setSelectedId(id)} />
      </div>
    </div>
  );
}
