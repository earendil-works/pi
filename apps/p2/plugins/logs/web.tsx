import { defineFacet, whenLive } from "@p2/app/v1";
import {
	closeLayers,
	openLayer,
	Sheet,
	Slots,
	useNavigation,
	useObject,
	useOwner,
	useReadable,
	useSheet,
	useStatus,
} from "@p2/app/v1/web";
import { useEffect, useRef, useState } from "react";
import { Logs } from "./contract.ts";
import "./style.css";
import { contribute } from "@p2/app/v1";

function sourceLabel(source: string): string {
	if (source.startsWith("session:")) return `Worker ${source.slice(8)}`;
	return source === "dev" ? "Dev supervisor" : source === "terminals" ? "Terminal host" : "Server";
}

function LogsSheet({ source }: { source: string }) {
	const logs = useObject(Logs, { source });
	const status = useStatus(logs);
	const sources = useReadable(logs?.sources) ?? [];
	const lines = useReadable(logs?.lines) ?? [];
	const [filter, setFilter] = useState("");
	const [follow, setFollow] = useState(true);
	const [message, setMessage] = useState<string>();
	const area = useRef<HTMLPreElement>(null);
	const nav = useNavigation();
	const query = filter.toLowerCase();
	const shown = lines.filter((line) => line.text.toLowerCase().includes(query));
	const text = shown.map((line) => `${new Date(line.time).toISOString()} [${line.level}] ${line.text}`).join("\n");
	// biome-ignore lint/correctness/useExhaustiveDependencies: New rendered lines must trigger tail-following after the DOM updates.
	useEffect(() => {
		if (follow && area.current) area.current.scrollTop = area.current.scrollHeight;
	}, [follow, text]);
	useEffect(() => {
		let current = true;
		void (logs ? whenLive(logs) : Promise.resolve()).catch((error: unknown) => {
			if (current) setMessage(error instanceof Error ? error.message : String(error));
		});
		return () => {
			current = false;
		};
	}, [logs]);
	const choices = [...new Set(["server", "terminals", "dev", source, ...sources.map((entry) => entry.id)])];
	return (
		<Sheet title="Logs" onClose={closeLayers} className="logs-sheet">
			<div className="logs-controls">
				<label className="label" htmlFor="logs-source">
					Source
				</label>
				<select
					id="logs-source"
					className="input"
					value={source}
					onChange={(event) => {
						const value = event.target.value;
						void nav.replace({
							...nav.route,
							layers: nav.route.layers.map((layer, index) =>
								index === nav.route.layers.length - 1 ? { kind: "sheet", name: "logs", locator: value } : layer,
							),
						});
					}}
				>
					{choices.map((id) => (
						<option key={id} value={id}>
							{sourceLabel(id)}
						</option>
					))}
				</select>
				<input
					className="input"
					aria-label="Filter logs"
					placeholder="Filter logs"
					value={filter}
					onChange={(event) => setFilter(event.target.value)}
				/>
				<div className="logs-actions">
					<label>
						<input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />{" "}
						Follow tail
					</label>
					<button
						type="button"
						className="text-action"
						onClick={() => {
							void (
								navigator.clipboard?.writeText(text) ?? Promise.reject(new Error("Clipboard unavailable"))
							).then(
								() => setMessage("Copied"),
								() => setMessage("Could not copy logs"),
							);
						}}
					>
						Copy
					</button>
				</div>
			</div>
			{message && <output className="notice">{message}</output>}
			<pre ref={area} className="logs-output" title="Log lines">
				{text || (status === "live" ? "No log lines" : status === "gone" ? "Logs unavailable" : "Loading logs…")}
			</pre>
		</Sheet>
	);
}

function LogsButton() {
	const sheet = useSheet("logs");
	if (!useOwner()) return null;
	return (
		<>
			<button
				type="button"
				className="foot-button"
				onClick={() => openLayer({ kind: "sheet", name: "logs" }, { fromDrawer: true })}
			>
				Logs
			</button>
			{sheet && <LogsSheet source={sheet.locator ?? "server"} />}
		</>
	);
}

export default defineFacet((host) => {
	contribute(host, "p2.web-logs", (self) => {
		self.contribute(Slots, { "sidebar-foot:logs": LogsButton });
	});
});
