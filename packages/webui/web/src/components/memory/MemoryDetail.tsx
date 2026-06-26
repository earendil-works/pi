import { useEffect, useState } from "react";
import { api, type MemoryAtom } from "../../lib/api";
import { useAutoSave } from "../../lib/useAutoSave";
import { MemoryEditor } from "./MemoryEditor";

interface MemoryDetailProps {
  id: string;
  onArchive: (id: string, currentlyArchived: boolean) => void;
  onListRefresh: () => void;
}

function timeAgo(iso: string | number | null | undefined): string {
  if (iso === null || iso === undefined || iso === "") return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diffMs)) return "—";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// Server-managed fields: never patched by the client, never part of a diff
const SERVER_FIELDS: ReadonlySet<keyof MemoryAtom> = new Set<keyof MemoryAtom>([
  "id",
  "version",
  "created_at",
  "updated_at",
  "strength",
  "access_count",
  "last_access",
  "archived",
]);

function computePatch(server: MemoryAtom, local: MemoryAtom): Partial<MemoryAtom> {
  const patch: Partial<MemoryAtom> = {};
  for (const key of Object.keys(local) as (keyof MemoryAtom)[]) {
    if (SERVER_FIELDS.has(key)) continue;
    if (JSON.stringify(local[key]) !== JSON.stringify(server[key])) {
      (patch as Record<string, unknown>)[key] = local[key];
    }
  }
  return patch;
}

export function MemoryDetail({ id, onArchive, onListRefresh }: MemoryDetailProps) {
  const [atom, setAtom] = useState<MemoryAtom | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  // localAtom = user's edit state. SSE + initial fetch preserve it when the
  // server version is unchanged; replace it when the server returns a newer
  // version.
  const [localAtom, setLocalAtom] = useState<MemoryAtom | null>(null);

  // Initial fetch + SSE subscription for live atom updates
  useEffect(() => {
    let alive = true;
    const fetchAtom = async () => {
      try {
        const a = await api.memory.get(id);
        if (alive) {
          setAtom(a);
          setLocalAtom((prev) => {
            // 同版本, 保留本地编辑
            if (prev && prev.version === a.version) return prev;
            return a;
          });
          setLoadError(null);
        }
      } catch (e) {
        if (alive) setLoadError(e instanceof Error ? e.message : String(e));
      }
    };
    void fetchAtom();

    const eventSource = new EventSource(`/api/memory/${id}/stream`);
    eventSource.addEventListener("atom", (event: MessageEvent) => {
      try {
        const incoming = JSON.parse(event.data) as MemoryAtom;
        // 单调递增防护: 仅当 incoming.version 严格大于当前版本才接受推送
        const accept = (prev: MemoryAtom | null) =>
          prev && incoming.version <= prev.version ? prev : incoming;
        setAtom(accept);
        setLocalAtom(accept);
        setSseConnected(true);
      } catch {
        // Ignore malformed messages
      }
    });
    eventSource.onerror = () => {
      // EventSource 自动重连; 仅标记状态让 UI 提示
      setSseConnected(false);
    };

    return () => {
      alive = false;
      eventSource.close();
    };
  }, [id]);

  const { status, error, savedValue, flush } = useAutoSave(localAtom, {
    delay: 3000,
    onSave: async (latest) => {
      if (!latest || !atom) return;
      const diff = computePatch(atom, latest);
      if (Object.keys(diff).length === 0) return;
      try {
        await api.memory.patch(id, diff, { ifMatch: latest.version });
        onListRefresh();
      } catch (err) {
        if (
          err instanceof Error &&
          "status" in err &&
          (err as { status: number }).status === 409
        ) {
          const fresh = await api.memory.get(id);
          setAtom(fresh);
          setLocalAtom((prev) =>
            prev ? { ...prev, version: fresh.version } : prev,
          );
          setLoadError("远端已更新,已刷新最新版本,请重新编辑");
        } else {
          throw err;
        }
      }
    },
  });

  if (loadError) {
    return (
      <div className="p-4 text-sm text-red-600">
        error loading atom: {loadError}
      </div>
    );
  }
  if (!atom || !localAtom) {
    return <div className="p-4 text-sm text-gray-500">Loading...</div>;
  }

  const handleEditorSave = async (patch: Partial<MemoryAtom>) => {
    setLocalAtom((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  return (
    <div className="flex flex-col h-full">
      {/* header: status + read-only metadata + archive */}
      <div className="border-b border-gray-200 p-2 space-y-1 text-xs">
        <div className="flex justify-between items-center">
          <span
            data-status={status}
            className={`font-medium ${
              status === "error"
                ? "text-red-600"
                : status === "saving"
                  ? "text-amber-600"
                  : status === "saved"
                    ? "text-green-600"
                    : "text-gray-500"
            }`}
          >
            {status === "idle" && "idle"}
            {status === "saving" && "Saving..."}
            {status === "saved" &&
              `Saved ${timeAgo(savedValue?.updated_at)}`}
            {status === "error" && `error: ${error?.message ?? "unknown"}`}
          </span>
          <button
            type="button"
            onClick={() => onArchive(atom.id, atom.archived)}
            className="border border-gray-300 rounded px-2 py-0.5 hover:bg-gray-100"
          >
            {atom.archived ? "Restore" : "Archive"}
          </button>
        </div>
        <div className="text-gray-500 grid grid-cols-2 gap-x-2 gap-y-0.5">
          <div>
            id: <span className="font-mono">{atom.id}</span>
          </div>
          <div>version: {atom.version}</div>
          <div>strength: {atom.strength.toFixed(2)}</div>
          <div>importance: {atom.importance.toFixed(2)}</div>
          <div>access_count: {atom.access_count}</div>
          <div>created: {atom.created_at}</div>
          <div>updated: {atom.updated_at}</div>
          <div>last_access: {atom.last_access || "—"}</div>
        </div>
        {!sseConnected && (
          <div
            data-testid="memory-sse-status"
            className="text-amber-600"
          >
            连接中断,正在重连...
          </div>
        )}
      </div>
      {/* editor */}
      <div className="flex-1 min-h-0">
        <MemoryEditor
          atom={localAtom}
          onSave={handleEditorSave}
          onArchive={() => onArchive(atom.id, atom.archived)}
          onFlush={flush}
        />
      </div>
    </div>
  );
}
