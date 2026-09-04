/**
 * Runnable illustrations of the two things that are easy to get wrong.
 *
 *   node --experimental-strip-types delta.examples.ts
 *
 * Nothing here is a test — `delta.test.ts` covers the same ground with
 * assertions. This exists to be read.
 */
import { apply, decoder, encoder, isBase, track, type Op } from "./delta-impl.ts";

const show = (label: string, ops: Op[]) => {
	console.log(`  ${label.padEnd(22)} ${ops.length} op(s), base=${isBase(ops)}`);
	for (const op of ops) console.log(`      ${trunc(JSON.stringify(op), 66)}`);
};
const trunc = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}…`);

// ─────────────────────────────────────────────────────────────────────────
// 1. Replacing the whole value
// ─────────────────────────────────────────────────────────────────────────
console.log("\n1. REPLACING THE WHOLE VALUE\n");

const before = { user: { id: "u1", name: "ada" }, items: ["a", "b"], note: "n".repeat(120) };
const after = { user: { id: "u2", name: "bob" }, items: ["x"], note: "m".repeat(120) };

{
	// The wrong way. `state` is a property of the TRACKER, not of the tracked
	// object. Without a setter this swaps the proxy for a plain object and every
	// later mutation is silently untracked — no error, no ops.
	//
	// The implementation defines `state` as a setter precisely so this works.
	const t = track<Record<string, unknown>>(structuredClone(before));
	t.flush();                              // drain the opening base batch
	t.state.items = ["changed first"];      // recorded…
	t.state = structuredClone(after);       // …then discarded: it described a dead value
	show("assign to .state", t.flush());

	t.state.user = { id: "u3" };            // still tracked afterwards
	show("  and still tracked", t.flush());
}

{
	// Dead-op elimination: a field written three times emits one op, and a parent
	// replaced after its child emits one. Object key order is not preserved by
	// this pass — see delta.md §5.1.
	const t = track<Record<string, any>>(structuredClone(before));
	t.flush();                              // drain the opening base batch
	t.state.items = ["first"];
	t.state.items = ["second"];
	t.state.user.name = "dropped";
	t.state.user = { id: "u9" };
	show("4 writes, 2 survive", t.flush());
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Why checkpointing exists
// ─────────────────────────────────────────────────────────────────────────
console.log("\n2. RECOVERY LENGTH\n");

/**
 * A bash-shaped workload: output arrives continuously and the sink writes
 * durably on an interval. Each flush is one batch appended to a list.
 * On resume the reader folds back to the last BASE batch, so that distance is
 * the cost of recovery.
 */
function simulate(writes: number, checkpointEvery: number | null) {
	const CAP = 50_000;
	const t = track({ out: "" });
	const isBaseBatch: boolean[] = [];

	for (let i = 0; i < writes; i++) {
		const next = `${t.state.out}[${i}] cc -c src/file${i}.c -o build/file${i}.o\n`;
		t.state.out = next.length > CAP ? next.slice(next.length - CAP) : next;

		if (checkpointEvery !== null && i % checkpointEvery === checkpointEvery - 1) t.rebase();

		const ops = t.flush();
		if (ops.length > 0) isBaseBatch.push(isBase(ops));
	}

	const lastBase = isBaseBatch.lastIndexOf(true);
	return { written: isBaseBatch.length, replay: isBaseBatch.length - lastBase - 1 };
}

for (const [label, every] of [["never", null], ["rebase() every 50", 50]] as const) {
	const r = simulate(500, every);
	console.log(`  ${label.padEnd(18)} ${r.written} batches written → ${r.replay} to replay on recovery`);
}

console.log(`
  Nothing produces a base batch on its own: flush() emits ops, and a replacement
  happens only when the producer asks for one. So a stream of appends stays a
  stream of deltas indefinitely, and recovery grows without bound.

  Two callers need rebase():
    - pendingToolOutput, during a long-running command. Without it a ten-minute
      build leaves hundreds of batches to fold on resume.
    - a facet host on resubscribe. facets.md §9.2 requires the first batch of a
      subscription to be a base batch, and the host must be able to produce one
      on demand.
`);

// ─────────────────────────────────────────────────────────────────────────
// 3. A replica always agrees
// ─────────────────────────────────────────────────────────────────────────
console.log("3. PRODUCER AND REPLICA AGREE\n");
{
	// The whole loop: tracker -> encode -> [boundary] -> decode -> apply.
	const t = track<Record<string, unknown>>(structuredClone(before));
	const enc = encoder();
	const dec = decoder();
	let replica: unknown;

	const step = (label: string, mutate: () => void) => {
		mutate();
		const ops = dec.decode(enc.encode(t.flush()));
		if (ops.length === 0) return;
		// No base-batch branch: apply handles `r` by replacing, and tolerates an
		// undefined target because a root op never reads it.
		replica = apply(replica, ops);
		const same = JSON.stringify(replica) === JSON.stringify(t.target);
		console.log(`  ${label.padEnd(22)} ${ops.length} op(s)  ${isBase(ops) ? "BASE " : "delta"}  matches: ${same}`);
	};

	step("opening base batch", () => {});

	step("append to a string", () => { (t.state.note as string); t.state.note = `${t.state.note}!`; });
	step("push", () => { (t.state.items as string[]).push("c"); });
	step("nested set", () => { (t.state.user as Record<string, unknown>).name = "cy"; });
	step("delete", () => { delete t.state.note; });
	step("whole replacement", () => { t.state = structuredClone(after); });
	step("rebase", () => { t.rebase(); });
}
console.log();
