import { useEffect, useRef, useState } from "react";
import { Sheet } from "../runtime/web.tsx";
import type { AssistantCost } from "./transcript.ts";

function preciseCost(value: number): string {
	return `$${value.toFixed(value >= 0.01 ? 4 : 6)}`;
}

function axisCost(value: number): string {
	if (value === 0) return "$0";
	return `$${value.toFixed(value >= 1 ? 2 : value >= 0.01 ? 3 : 5)}`;
}

function percent(value: number | undefined): string {
	return value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

/** The cost sheet; `load` fetches every response of the conversation's active range (the view holds only the newest). */
export function CostPanel({
	load,
	onClose,
}: {
	load: () => Promise<readonly (Omit<AssistantCost, "cacheHit"> & { cacheHit?: number })[]>;
	onClose: () => void;
}) {
	const [loaded, setLoaded] = useState<{ costs: AssistantCost[] } | { error: string }>();
	// biome-ignore lint/correctness/useExhaustiveDependencies: fetched once per opening, not on every render's new `load`.
	useEffect(() => {
		let current = true;
		load()
			.then((rows) => current && setLoaded({ costs: rows.map((row) => ({ ...row, cacheHit: row.cacheHit })) }))
			.catch(
				(error: unknown) => current && setLoaded({ error: error instanceof Error ? error.message : String(error) }),
			);
		return () => {
			current = false;
		};
	}, []);
	const costs = loaded && "costs" in loaded ? loaded.costs : [];
	const maximum = Math.max(0, ...costs.map((entry) => entry.cost));
	const total = costs.reduce((sum, entry) => sum + entry.cost, 0);
	const rows = useRef(new Map<string, HTMLTableRowElement>());
	const [selected, setSelected] = useState<string>();
	return (
		<Sheet title="Cost" onClose={onClose} className="cost-sheet">
			<p className="muted small">
				Viewed conversation · committed assistant messages. The session footer can also include subagents and tools.
			</p>
			{!loaded ? (
				<p className="muted">Loading…</p>
			) : "error" in loaded ? (
				<p className="error">{loaded.error}</p>
			) : costs.length ? (
				<>
					<div className="cost-summary">
						<span>{costs.length} responses</span>
						<strong>{preciseCost(total)}</strong>
					</div>
					{/* Two charts on one shared x axis instead of tabs or a dual y axis: a cost
					    spike sits directly above its cache hit rate, and each chart keeps its own unit. */}
					<figure className="cost-chart" aria-label="Assistant response costs in US dollars and cache hit rates">
						<figcaption>Cost (USD)</figcaption>
						<div className="cost-chart-body">
							<div className="cost-y-axis" aria-hidden="true">
								<span>{axisCost(maximum)}</span>
								<span>{axisCost(maximum / 2)}</span>
								<span>$0</span>
							</div>
							<span className="cost-chart-caption">Cache hit rate</span>
							<div className="cost-y-axis cache-y-axis" aria-hidden="true">
								<span>100%</span>
								<span>50%</span>
								<span>0%</span>
							</div>
							<div className="cost-plot">
								<div className="cost-bars">
									{costs.map((entry, index) => {
										const height = maximum > 0 ? Math.max(2, (entry.cost / maximum) * 100) : 2;
										return (
											<button
												type="button"
												className={`cost-column ${selected === entry.entryId ? "selected" : ""}`}
												key={entry.entryId}
												title={`${index + 1}: ${preciseCost(entry.cost)} · cache hit rate ${percent(entry.cacheHit)}`}
												onClick={() => {
													setSelected(entry.entryId);
													rows.current
														.get(entry.entryId)
														?.scrollIntoView({ behavior: "smooth", block: "center" });
												}}
											>
												<span className="cost-bar-track">
													<span className="cost-bar" style={{ height: `${height}%` }} />
												</span>
												{/* No bar at all without prompt tokens; a 0% hit still shows a stub. */}
												<span className="cost-bar-track cache-bar-track">
													{entry.cacheHit !== undefined && (
														<span
															className="cost-bar"
															style={{ height: `${Math.max(2, entry.cacheHit * 100)}%` }}
														/>
													)}
												</span>
												<small>{index + 1}</small>
											</button>
										);
									})}
								</div>
							</div>
						</div>
					</figure>
					<div className="cost-table-wrap">
						<table className="cost-table">
							<thead>
								<tr>
									<th>#</th>
									<th>Timestamp</th>
									<th>Model</th>
									<th>Result</th>
									<th title="Cache hit rate: cache read / (input + cache read + cache write)">Cache</th>
									<th>Cost</th>
								</tr>
							</thead>
							<tbody>
								{costs.map((entry, index) => (
									<tr
										key={entry.entryId}
										className={selected === entry.entryId ? "selected" : undefined}
										ref={(element) => {
											if (element) rows.current.set(entry.entryId, element);
											else rows.current.delete(entry.entryId);
										}}
									>
										<td>{index + 1}</td>
										<td>{new Date(entry.timestamp).toLocaleString()}</td>
										<td title={`${entry.provider}/${entry.model}`}>{entry.model}</td>
										<td>{entry.stopReason}</td>
										<td>{percent(entry.cacheHit)}</td>
										<td>{preciseCost(entry.cost)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</>
			) : (
				<p className="empty-note">No committed assistant cost data in this conversation.</p>
			)}
		</Sheet>
	);
}
