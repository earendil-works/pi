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
  // committedFilters lags filters by 300ms; used by the server fetch + 3s
  // polling so every keystroke in the search/tag inputs does not re-fetch.
  const [committedFilters, setCommittedFilters] = useState<MemoryListFilters>({
    types: [],
    archived: "active",
    tag: "",
    q: "",
  });
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Clicking the active item (selectedId === id) is a no-op for setState, so
  // we bump refreshKey on every click and feed it into MemoryDetail's key prop.
  // When the key changes React unmounts + remounts, which re-runs the
  // `useEffect(..., [id])` fetcher inside MemoryDetail. This gives users
  // explicit control over when they want a fresh server read of the same atom.
  const [refreshKey, setRefreshKey] = useState(0);

  const handleSelect = (id: string) => {
    setSelectedId(id);
    setRefreshKey((k) => k + 1);
  };

  // Commit filter changes after 300ms idle so we batch rapid keystrokes.
  useEffect(() => {
    const t = setTimeout(() => setCommittedFilters(filters), 300);
    return () => clearTimeout(t);
  }, [filters]);

  // 3s polling fetch atoms + stats — uses committedFilters (debounced) to avoid
  // racing responses from rapid filter changes.
  useEffect(() => {
    let alive = true;
    const fetchAll = async () => {
      try {
        const [list, s] = await Promise.all([
          api.memory.list({
            archived: committedFilters.archived,
            type: committedFilters.types.join(",") || undefined,
            tag: committedFilters.tag || undefined,
            q: committedFilters.q || undefined,
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
  }, [committedFilters]);

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
            onSelect={handleSelect}
            onArchive={handleArchive}
            filters={filters}
            onFilterChange={setFilters}
            onRefresh={handleRefresh}
            isEmptyDb={
              atoms.length === 0 &&
              filters.types.length === 0 &&
              filters.tag === "" &&
              filters.q === "" &&
              filters.archived === "active"
            }
          />
        </div>
        {/* 右 70%: detail */}
        <div className="w-[70%] min-h-0">
          {selectedId ? (
            <MemoryDetail
              key={`${selectedId}:${refreshKey}`}
              id={selectedId}
              onArchive={handleArchive}
              onListRefresh={handleRefresh}
            />
          ) : (
            <div className="p-4 text-sm text-gray-500">Select an atom from the list</div>
          )}
        </div>
      </div>
      {/* bottom: search tester */}
      <div className="max-h-64 overflow-auto">
        <MemorySearchTester onSelectAtom={handleSelect} />
      </div>
    </div>
  );
}
