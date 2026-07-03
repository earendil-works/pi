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
						<div className="flex flex-wrap gap-2 text-xs text-gray-600">
							<span>{result.results.length} results</span>
							<span>recall: {result.recallTimeMs}ms</span>
						</div>
						<div className="space-y-1">
							{result.results.map((r) => (
								<div
									key={r.id}
									data-result-id={r.id}
									onClick={() => onSelectAtom(r.id)}
									className="border border-gray-100 rounded p-2 cursor-pointer hover:bg-gray-50"
								>
									<div className="flex items-center gap-2">
										<MemoryTypeBadge type={r.type} />
										<span className="font-medium text-sm">{r.title}</span>
										<span className="ml-auto text-xs text-gray-500">
											rrf {r.rrf.toFixed(4)} · cos {r.cosine.toFixed(3)} · sparse {r.sparseScore.toFixed(3)}
										</span>
									</div>
									<div className="text-xs text-gray-600 mt-1 line-clamp-2">{r.summary}</div>
									<div className="text-xs text-gray-400 mt-1 font-mono truncate">
										id: {r.id.slice(0, 8)}… · {r.tags.join(", ")}
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