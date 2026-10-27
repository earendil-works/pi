/**
 * Appending to a list, one commit per item: one array in one document against one family member per item, as a
 * journal can be stored. Reports milliseconds and microseconds per append at each size. An append costs one copy of the
 * array for the next immutable value; the family's cost stays flat.
 *
 *   node --conditions=source --experimental-strip-types test/document-append-bench.ts [N,...]
 */
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineDoc, defineDocFamily } from "../src/documents.ts";
import { MemoryStorage } from "../src/index.ts";
import { createSession } from "../src/session/session.ts";

type Entry = { key: string; issued: number; at: number };

const Journal = defineDoc<{ entries: Entry[] }>({
	checkpointWhen: () => false,
	kind: "bench.journal",
	version: 1,
	scope: "session",
	initial: () => ({ entries: [] }),
});

const Member = defineDocFamily<{ issued: number; at: number }, null>({
	checkpointWhen: () => false,
	kind: "bench.member",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ issued: 0, at: 0 }),
});

async function run(kind: "array" | "family", n: number): Promise<number> {
	const session = createSession(new MemoryStorage());
	const started = performance.now();
	for (let i = 0; i < n; i++) {
		await session.commit(async (tx) => {
			if (kind === "array") (await tx.doc(Journal)).entries.push({ key: `c${i}`, issued: i, at: i });
			else Object.assign(await tx.doc(Member, `c${i}`, null), { issued: i, at: i });
		}, context);
	}
	const ms = performance.now() - started;
	await session.close(context);
	return ms;
}

const sizes = (process.argv[2] ?? "1000,8000,16000,32000").split(",").map(Number);
for (const n of sizes) {
	const array = await run("array", n);
	const family = await run("family", n);
	const per = (ms: number) => `${((ms / n) * 1000).toFixed(0)} µs`;
	console.log(
		`n=${n}: array ${array.toFixed(0)} ms (${per(array)}/append), family ${family.toFixed(0)} ms (${per(family)}/append)`,
	);
}
