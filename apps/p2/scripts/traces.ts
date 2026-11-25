// Prints traces from p2's telemetry store (`<data>/telemetry.sqlite`, src/runtime/host-dirs.ts), newest first, each as
// Chord's renderer prints it (a forest of spans, lengths to the microsecond). Read-only: safe while the server runs (it
// is the store's only writer).
//
//   node --import ./src/source.ts scripts/traces.ts [--data <dir>] [--name <first span's name>] [--attr key=value]...
//     [--errors] [--since <minutes>] [--limit <traces>]

import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openTelemetryStore } from "@earendil-works/chord/telemetry-sqlite/node";
import { renderTrace } from "@earendil-works/pi-telemetry/render";
import { telemetryStore } from "../src/runtime/host-dirs.ts";

const { values } = parseArgs({
	options: {
		data: { type: "string" },
		name: { type: "string" },
		attr: { type: "string", multiple: true },
		errors: { type: "boolean" },
		since: { type: "string" },
		limit: { type: "string" },
	},
});

const dataDir = values.data ?? process.env.P2_DATA_DIR ?? join(homedir(), ".pi", "p2");
const attributes = Object.fromEntries(
	(values.attr ?? []).map((pair) => {
		const at = pair.indexOf("=");
		if (at < 1) throw new Error(`--attr ${pair}: expected key=value`);
		return [pair.slice(0, at), pair.slice(at + 1)];
	}),
);
const store = await openTelemetryStore(telemetryStore(dataDir));
try {
	const { traces } = await store.findTraces({
		...(values.name === undefined ? {} : { name: values.name }),
		...(Object.keys(attributes).length === 0 ? {} : { attributes }),
		...(values.errors ? { errors: true } : {}),
		...(values.since === undefined ? {} : { startMin: Date.now() - Number(values.since) * 60_000 }),
		limit: values.limit === undefined ? 10 : Number(values.limit),
	});
	for (const trace of traces) console.log(`trace ${trace.traceId}\n${renderTrace(trace.spans)}\n`);
} finally {
	await store.close();
}
