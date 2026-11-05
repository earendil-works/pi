// Memory benchmark of the sync layer inside Durable Objects (RFC 0074's budget: 96 to 128 MB per isolate): workerd
// through Miniflare, the objects of `sync-worker.ts` on their own SQLite storage, and the isolate's V8 heap sampled
// through the inspector while each step runs. Steps per session size: fill the origin's store (commits with its
// outbox), upload (outbox to remote, bodies streamed into the remote's SQLite), pull (restore a replica through the
// origin's remote over RPC), fold (restore into scratch, export a snapshot back). Each step starts after a full GC; its
// baseline is the used heap then, and its peak the highest `usedSize` sampled until it answers.
//
// workerd runs with `--expose-gc` and `--max-old-space-size=128` (Cloudflare's per-isolate limit), so a step that
// needed more than 128 MB would fail, not just report a big number.
//
// Run by hand from packages/chord (not in CI; about three minutes):
//   node --conditions=source --experimental-strip-types test/bench/sync-memory.ts

import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import WebSocket from "ws";

/** Session histories: total MB of row text, and the size of each commit's row. */
const RUNS = [
	{ sizeMb: 8, rowBytes: 64 * 1024 },
	{ sizeMb: 32, rowBytes: 64 * 1024 },
	{ sizeMb: 128, rowBytes: 64 * 1024 },
	{ sizeMb: 256, rowBytes: 64 * 1024 },
	// Few large commits: each one close to a whole batch, the case that holds the most at once.
	{ sizeMb: 64, rowBytes: 4 * 1024 * 1024 },
];
const INSPECTOR_PORT = 9341;
const SAMPLE_MS = 10;
const MB = 1024 * 1024;

process.env.MINIFLARE_WORKERD_V8_FLAGS = "--expose-gc --max-old-space-size=128";

const bundled = await build({
	entryPoints: [new URL("./sync-worker.ts", import.meta.url).pathname],
	bundle: true,
	format: "esm",
	platform: "neutral",
	write: false,
	external: ["cloudflare:*"],
	conditions: ["source", "workerd", "worker"],
	mainFields: ["module", "main"],
	target: "es2023",
});

const mf = new Miniflare(
	convertV4MiniflareOptions({
		inspectorPort: INSPECTOR_PORT,
		workers: [
			{
				name: "sync-bench",
				compatibilityDate: "2026-10-01",
				compatibilityFlags: ["nodejs_compat"],
				modules: [{ type: "ESModule", path: "worker.mjs", contents: bundled.outputFiles[0]!.text }],
				durableObjects: {
					ORIGIN: { className: "Origin", useSQLite: true },
					REPLICA: { className: "Replica", useSQLite: true },
					FOLDER: { className: "Folder", useSQLite: true },
				},
			},
		],
	}),
);

try {
	await mf.ready;
	await mf.dispatchFetch("http://bench/unknown");
	const [target] = (await (await fetch(`http://127.0.0.1:${INSPECTOR_PORT}/json/list`)).json()) as {
		webSocketDebuggerUrl: string;
	}[];
	const inspector = await connect(target!.webSocketDebuggerUrl);

	const rows: string[] = [];
	for (const { sizeMb, rowBytes } of RUNS) {
		const run = `run${sizeMb}x${rowBytes}`;
		const count = (sizeMb * MB) / rowBytes;
		const label = `${sizeMb} MB in ${mb(rowBytes)} MB rows`;
		for (const step of ["fill", "upload", "pull", "fold"] as const) {
			const query = step === "fill" ? `&count=${count}&size=${rowBytes}` : "";
			const measured = await measure(inspector, () => mf.dispatchFetch(`http://bench/${step}?run=${run}${query}`));
			const body = (await measured.response.json()) as { ms: number; result: unknown };
			if (!measured.response.ok) throw new Error(`${step} ${label} failed: ${JSON.stringify(body)}`);
			rows.push(
				`| ${label} | ${step} | ${mb(measured.baseline)} | ${mb(measured.peak)} | ${mb(measured.peak - measured.baseline)} | ${body.ms} | ${summary(step, body.result)} |`,
			);
			console.log(rows.at(-1));
		}
	}
	inspector.close();
	console.log(
		[
			"",
			"| history | step | heap before (MB) | peak heap (MB) | peak above before (MB) | ms | result |",
			"|---|---|---|---|---|---|---|",
			...rows,
		].join("\n"),
	);
} finally {
	await mf.dispose();
}

/** What a step's answer must offer (Miniflare's own `Response` type, not the DOM one). */
type StepResponse = { readonly ok: boolean; json(): Promise<unknown>; text(): Promise<string> };

type Inspector = { call(method: string): Promise<{ result?: { usedSize?: number } }>; close(): void };

async function connect(url: string): Promise<Inspector> {
	const ws = new WebSocket(url);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	let id = 0;
	const pending = new Map<number, (value: never) => void>();
	ws.on("message", (raw) => {
		const message = JSON.parse(String(raw)) as { id?: number };
		if (message.id !== undefined) pending.get(message.id)?.(message as never);
		pending.delete(message.id ?? -1);
	});
	const inspector: Inspector = {
		call: (method) =>
			new Promise((resolve) => {
				const n = ++id;
				pending.set(n, resolve as (value: never) => void);
				ws.send(JSON.stringify({ id: n, method }));
			}),
		close: () => ws.close(),
	};
	await inspector.call("Runtime.enable");
	return inspector;
}

/**
 * Runs `step` from a settled heap: a full GC in the isolate first, its used heap then as the baseline, then samples
 * every `SAMPLE_MS` until the step answers; the peak is the highest sample.
 */
async function measure(
	inspector: Inspector,
	step: () => Promise<StepResponse>,
): Promise<{ response: StepResponse; baseline: number; peak: number }> {
	const used = async () => (await inspector.call("Runtime.getHeapUsage")).result?.usedSize ?? 0;
	await (await mf.dispatchFetch("http://bench/gc")).text();
	const baseline = await used();
	let peak = baseline;
	let running = true;
	const sampling = (async () => {
		while (running) {
			peak = Math.max(peak, await used());
			await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
		}
	})();
	const response = await step();
	running = false;
	await sampling;
	peak = Math.max(peak, await used());
	return { response, baseline, peak };
}

function mb(bytes: number): string {
	return (bytes / MB).toFixed(1);
}

function summary(step: string, result: unknown): string {
	const value = result as Record<string, unknown>;
	if (step === "upload") {
		const stored = value.stored as number;
		return `${value.slots} slots, ${mb(stored)} MB stored`;
	}
	return JSON.stringify(result);
}
