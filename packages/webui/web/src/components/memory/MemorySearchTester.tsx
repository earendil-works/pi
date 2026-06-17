import { useState } from "react";
import { api, type MemorySearchResult } from "../../lib/api";
import { MemoryTypeBadge } from "./MemoryTypeBadge";

interface MemorySearchTesterProps {
  onSelectAtom: (id: string) => void;
}

export function MemorySearchTester({ onSelectAtom }: MemorySearchTesterProps) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<MemorySearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.memory.search(query.trim(), 10);
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <details className="border-t border-gray-200 p-2">
      <summary className="cursor-pointer text-sm font-medium">Search Tester (real pipeline)</summary>
      <div className="mt-2 space-y-2">
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Query..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }}
            className="border border-gray-300 rounded px-2 py-0.5 flex-1 text-sm"
          />
          <button
            type="button"
            onClick={() => void runSearch()}
            disabled={loading || !query.trim()}
            className="border border-gray-300 rounded px-3 py-0.5 text-sm hover:bg-gray-100 disabled:opacity-50"
          >
            {loading ? "Searching..." : "Search"}
          </button>
        </div>
        {error && <div className="text-xs text-red-600">error: {error}</div>}
        {result && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2 text-xs">
              <div className="flex flex-wrap gap-1 items-center">
                <span className="font-medium">keywords:</span>
                {result.rewritten.keywords.map((k) => (
                  <span key={k} className="bg-gray-100 text-gray-800 rounded px-1.5 py-0.5">{k}</span>
                ))}
              </div>
              <div className="flex flex-wrap gap-1 items-center">
                <span className="font-medium">target_types:</span>
                {result.rewritten.target_types.map((t) => (
                  <span key={t} className="bg-gray-100 text-gray-800 rounded px-1.5 py-0.5">{t}</span>
                ))}
              </div>
              <div>
                <span className={`text-xs rounded px-2 py-0.5 ${result.embedding_available ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-600"}`}>
                  {result.embedding_available ? "embedding available" : "embedding unavailable"}
                </span>
              </div>
            </div>
            <div className="text-xs text-gray-500">{result.results.length} results</div>
            <div className="space-y-1">
              {result.results.map((r) => (
                <div
                  key={r.atom.id}
                  data-result-id={r.atom.id}
                  onClick={() => onSelectAtom(r.atom.id)}
                  className="border border-gray-100 rounded p-2 cursor-pointer hover:bg-gray-50"
                  title={`fts=${r.fts_score.toFixed(2)} cos=${r.cosine_score.toFixed(2)} hybrid=${r.hybrid_score.toFixed(2)} str=${r.atom.strength.toFixed(2)} imp=${r.atom.importance.toFixed(2)}`}
                >
                  <div className="flex items-center gap-2">
                    <MemoryTypeBadge type={r.atom.type} />
                    <span className="font-medium text-sm">{r.atom.title}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}