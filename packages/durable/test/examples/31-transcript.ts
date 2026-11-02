// A client's transcript over the windowed conversation view: `ConversationTranscript` merges every value of a watch
// into the client's whole transcript, marks entries a stall skipped as a gap, and loads them, and earlier pages, on
// demand. A client that drops resumes after the newest entry it has.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/31-transcript.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	ConversationTranscript,
	createRegistry,
	Harness,
	MemoryStorage,
	type TranscriptItem,
	type TranscriptView,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;
const harness = await Harness.open(
	new MemoryStorage(),
	{ models: createModels(), registry: createRegistry() },
	context,
);
const root = await harness.root(context);
let count = 0;
/** Commit `n` chat lines, one entry each. */
const chat = async (n: number): Promise<void> => {
	for (let index = 0; index < n; index++) {
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "chat", data: `line ${++count}` }), context);
	}
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** One line per item: ranges of entries, gaps, and the "load earlier" marker. */
function render(label: string, view: TranscriptView): void {
	const rows: string[] = [];
	let run: [number, number] | undefined;
	const flush = () => {
		if (run !== undefined) rows.push(run[0] === run[1] ? `${run[0]}` : `${run[0]}..${run[1]}`);
		run = undefined;
	};
	for (const item of view.items) {
		if (item.kind === "entry") {
			const line = Number(String(item.entry.data).slice("line ".length));
			run = run === undefined ? [line, line] : [run[0], line];
			continue;
		}
		flush();
		rows.push(item.kind === "gap" ? "[load more]" : "[load earlier]");
	}
	flush();
	console.log(`${label.padEnd(28)} ${rows.join(" ")}`);
}

const firstGap = (view: TranscriptView) =>
	view.items.find((item): item is Extract<TranscriptItem, { kind: "gap" }> => item.kind === "gap");

await chat(200);

// Attach: the window holds the newest `min` entries; the transcript shows "load earlier" above them.
const transcript = new ConversationTranscript((query, limit, ctx) => root.entries(query, limit, undefined, ctx), {
	pageSize: 20,
});
const window = { min: 10, max: 20 };
let watch = await root.watch(context, window);
let view = transcript.merge(watch.value);
render("attach", view);
watch.start(async (call) => {
	if (call.kind !== "value") return;
	const { value } = call;
	view = transcript.merge(value);
});

// Live: appends. The window drops its oldest past `max`; the transcript keeps them.
await chat(15);
await settle();
render("15 more, live", view);

// The user scrolls up: one page.
view = await transcript.loadEarlier(context);
render("load earlier", view);

// A drop: the client misses 40 entries, more than `max`, and resumes after the newest it has. The window starts at the
// newest `min` again, and `before` shows the transcript a gap.
await watch.stop();
await chat(40);
watch = await root.watch(context, { ...window, ...transcript.resume });
view = transcript.merge(watch.value);
render("resume after 40 missed", view);
watch.start(async (call) => {
	if (call.kind !== "value") return;
	const { value } = call;
	view = transcript.merge(value);
});

// "load more" fills the gap a page at a time.
for (let gap = firstGap(view); gap !== undefined; gap = firstGap(view)) {
	view = await transcript.fillGap(gap, context);
	render("fill gap", view);
}

// A short drop resumes without a gap: the window starts right after the newest entry.
await watch.stop();
await chat(3);
watch = await root.watch(context, { ...window, ...transcript.resume });
console.log(`${"resume after 3 missed".padEnd(28)} window: ${watch.value.entries.length} entries`);
view = transcript.merge(watch.value);
render("", view);

await watch.stop();
await harness.close(context);
