// The todo app's trace reader: a script reading the telemetry store of a data directory (`telemetry.sqlite`) through
// the store's read interface, while the app runs or after. Without a trace id it prints the newest traces (those whose
// first span is `--name`, when given) and the bytes on the links; with one, that trace as the renderer prints it.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/61-tutorial/trace.ts <data directory> [--name <span>]
//   node --conditions=source --experimental-strip-types test/examples/61-tutorial/trace.ts <data directory> <trace id>
import { parseArgs } from "node:util";
import { renderTrace } from "@earendil-works/pi-telemetry/render";
import { openTelemetry, telemetryFile } from "./src/telemetry.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { name: { type: "string" } } });
const [dataDir, id] = positionals;
if (dataDir === undefined) throw new Error("usage: trace.ts <data directory> [--name <span>] [<trace id>]");
// A recorder of this process on the shared file, which records nothing: the reads are what the script uses.
const telemetry = await openTelemetry(telemetryFile(dataDir));
try {
	if (id !== undefined) {
		const trace = await telemetry.store.getTrace(id);
		console.log(trace === undefined ? `no trace ${id}` : renderTrace(trace.spans));
	} else {
		// Complete traces, newest first; a trace's first span (its root, by start time) names it.
		const { traces } = await telemetry.store.findTraces({ name: values.name, limit: 10 });
		for (const { traceId, spans } of traces) {
			const start = Math.min(...spans.map((span) => span.startedMs));
			const length = Math.max(...spans.map((span) => span.endedMs)) - start;
			const failed = spans.some((span) => span.status.status === "error") ? "  error" : "";
			console.log(`${traceId}  ${spans[0]!.name}  ${spans.length} spans  ${length.toFixed(2)} ms${failed}`);
		}
		// Metrics are stored per series and 10 s: a series is one set of attributes, here the direction.
		for (const direction of ["sent", "received"]) {
			const rows = await telemetry.store.findMetrics({ name: "chord.link.bytes", attributes: { direction } });
			const bytes = rows.reduce((sum, row) => sum + row.sum, 0);
			const messages = rows.reduce((sum, row) => sum + row.count, 0);
			console.log(`chord.link.bytes ${direction}: ${bytes} bytes in ${messages} messages`);
		}
	}
} finally {
	await telemetry.close();
}
