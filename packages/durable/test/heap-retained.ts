// For benchmarks: the bytes live objects hold, from a heap snapshot. `heapUsed` after `gc()` also counts what the
// collector has not compacted yet, which hides a small leak or invents a large one.
import { Session } from "node:inspector/promises";

/** Sum of the self sizes of every object in a fresh heap snapshot, which collects garbage first. */
export async function retainedBytes(): Promise<number> {
	const inspector = new Session();
	inspector.connect();
	const chunks: string[] = [];
	inspector.on("HeapProfiler.addHeapSnapshotChunk", (message) => chunks.push(message.params.chunk));
	try {
		await inspector.post("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
	} finally {
		inspector.disconnect();
	}
	const snapshot = JSON.parse(chunks.join("")) as {
		snapshot: { meta: { node_fields: string[] } };
		nodes: number[];
	};
	const fields = snapshot.snapshot.meta.node_fields;
	const width = fields.length;
	const size = fields.indexOf("self_size");
	let total = 0;
	for (let index = size; index < snapshot.nodes.length; index += width) total += snapshot.nodes[index]!;
	return total;
}
