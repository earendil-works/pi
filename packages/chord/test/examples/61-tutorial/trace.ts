// The todo app's trace reader: a script reading the telemetry store of a data directory (`telemetry.sqlite`) through
// the store's read interface, while the app runs or after. Without a trace id it prints the newest traces (those whose
// first span is `--name`, and with a span for `--principal`, when given) and the bytes on the links; with one, that
// trace as the renderer prints it.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/61-tutorial/trace.ts <data directory> [--name <span>] [--principal <key>]
//   node --conditions=source --experimental-strip-types test/examples/61-tutorial/trace.ts <data directory> <trace id>
import { parseArgs } from "node:util";
import { renderTrace } from "@earendil-works/pi-telemetry/render";
import { openTelemetryStore } from "../../../src/telemetry-sqlite/node.ts";
import { telemetryFile } from "./src/telemetry.ts";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { name: { type: "string" }, principal: { type: "string" } },
});
const [dataDir, id] = positionals;
if (dataDir === undefined) {
	throw new Error("usage: trace.ts <data directory> [--name <span>] [--principal <key>] [<trace id>]");
}
// The shared file, read-only: the app's processes may be writing it meanwhile.
const store = await openTelemetryStore(telemetryFile(dataDir));
try {
	if (id !== undefined) {
		const trace = await store.getTrace(id);
		console.log(trace === undefined ? `no trace ${id}` : renderTrace(trace.spans));
	} else {
		// Complete traces, newest first; a trace's first span (its root, by start time) names it, and the app's
		// `principalAttributes` hook named whom each span was for.
		const attributes = values.principal === undefined ? undefined : { "chord.principal": values.principal };
		const { traces } = await store.findTraces({ name: values.name, attributes, limit: 10 });
		for (const { traceId, spans } of traces) {
			const start = Math.min(...spans.map((span) => span.startedMs));
			const length = Math.max(...spans.map((span) => span.endedMs)) - start;
			const failed = spans.some((span) => span.status.status === "error") ? "  error" : "";
			console.log(`${traceId}  ${spans[0]!.name}  ${spans.length} spans  ${length.toFixed(2)} ms${failed}`);
		}
		// Metrics are stored per series and 10 s: a series is one set of attributes, here the direction.
		for (const direction of ["sent", "received"]) {
			const rows = await store.findMetrics({ name: "chord.link.bytes", attributes: { direction } });
			const bytes = rows.reduce((sum, row) => sum + row.sum, 0);
			const messages = rows.reduce((sum, row) => sum + row.count, 0);
			console.log(`chord.link.bytes ${direction}: ${bytes} bytes in ${messages} messages`);
		}
	}
} finally {
	await store.close();
}
