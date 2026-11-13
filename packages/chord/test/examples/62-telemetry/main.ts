// Telemetry across hosts (slice 9): a kit app (`start.ts`) whose server records to a SQLite telemetry store in the
// data directory, and whose tally workers send what they record to the server. The owner's client host calls a tally's counter: the call goes from the client
// over the server's relay into the worker's method, which checks its argument in a span of its own (`ctx.trace`) and
// commits through a local store object. Each host starts its spans with its own adapter; the carriers on the wire make
// them one trace. The example prints that trace as the store renders it, and a metric the server recorded.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/62-telemetry/main.ts
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTrace } from "@earendil-works/pi-telemetry/render";
import { WebSocket } from "ws";
import { BACKGROUND_CONTEXT as context, withTelemetry } from "../../../src/context/index.ts";
import { createHost, type WebSocketLike, webSocketLink } from "../../../src/index.ts";
import type { TallyPrincipal } from "./app/principals.ts";
import { Counter } from "./app/v1.ts";
import { openTelemetry, startTally, telemetryFile } from "./start.ts";

const dataDir = join(await mkdtemp(join(tmpdir(), "tally-")), "data");

// 1. The server records to the store in its data directory; each tally's worker sends its spans to the server.
await mkdir(dataDir, { mode: 0o700 });
const telemetry = await openTelemetry(telemetryFile(dataDir));
const app = await startTally(dataDir, telemetry, context);
const url = new URL(app.ownerLink()).origin;
console.log("1. tally app at", url, "recording to", "telemetry.sqlite");

// 2. The owner's client host (a terminal client, a page) connects over the links endpoint with the owner token. It
//    records to the same adapter here (it runs in this process); a page would export to its own.
const token = (await readFile(app.ownerTokenFile, "utf8")).trim();
const client = createHost<TallyPrincipal>({ telemetry, onError: (error) => console.error("client:", error) });
await client.load([], context);
const socket = new WebSocket(`${url.replace(/^http/, "ws")}/chord`, { headers: { authorization: `Bearer ${token}` } });
client.connect(webSocketLink(socket as unknown as WebSocketLike), { principal: { kind: "server" } }, context);
console.log("2. the owner's client connected over /chord");

// 3. One click in the client is one trace: its root span, then the call through the relay into the worker's method.
const total = await telemetry.startSpan({ name: "tally.click" }, async (span) => {
	const clicked = withTelemetry(span, context);
	const counter = await client.get(Counter, { id: "t1" }, clicked);
	return counter.add(3, clicked);
});
console.log("3. the tally's total:", total);

// 4. A worker sends its settled spans every second, the server writes every second: read until the worker's method is
//    in the click's trace (the newest trace whose first span is the click).
const clicked = async () => {
	await telemetry.flush();
	return (await telemetry.findTraces({ name: "tally.click", limit: 1 })).traces;
};
let traces = await clicked();
while (!traces[0]?.spans.some(({ name }) => name === "tally.check")) {
	await new Promise((resolve) => setTimeout(resolve, 100));
	traces = await clicked();
}
console.log("4. the trace across the client, the server and the worker (links name the root span they point to):");
// The roots a trace links to (the worker's start, an object's activation) are traces of their own: named here.
const names = new Map<string, string>();
for (const trace of (await telemetry.findTraces({ limit: 100 })).traces) {
	for (const span of trace.spans) names.set(span.id, span.name);
}
const rendered = renderTrace(traces[0]?.spans ?? [])
	.replaceAll(/ \(\+?[\d.]+ms\)/g, "")
	.replaceAll(/ duration=([\d.]+)/g, (_, ms: string) => ` duration=${Number(ms).toFixed(1)}`)
	.replaceAll(/link trace \S+ span (\S+)/g, (_, id: string) => `link to ${names.get(id) ?? id}`);
for (const line of rendered.split("\n")) console.log(`   ${line}`);

// 5. Metrics are aggregated per series and 10 s: the server's encoded bytes on its links, by direction.
await client.close(context);
await app.close(context);
await telemetry.close();
for (const direction of ["sent", "received"]) {
	const rows = await telemetry.findMetrics({ name: "chord.link.bytes", attributes: { direction } });
	const bytes = rows.reduce((sum, row) => sum + row.sum, 0);
	console.log(
		`5. chord.link.bytes ${direction}: ${bytes} bytes in ${rows.reduce((sum, row) => sum + row.count, 0)} messages`,
	);
}

// The cost counters count the work they guard through the host's adapter too: messages checked against the schema.
const checks = await telemetry.findMetrics({ name: "chord.link.checks" });
console.log(`5. chord.link.checks: ${checks.reduce((sum, row) => sum + row.sum, 0)} messages checked`);

await rm(join(dataDir, ".."), { recursive: true, force: true });
console.log("6. closed");
