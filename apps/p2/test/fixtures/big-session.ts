// A long synthetic conversation as Durable entry drafts (Node tests and scripts/measure-view.ts): turns of a person's
// input, a thinking answer that calls tools, the tools' results (some large, as reads and builds produce) and a closing
// answer. Deterministic, so sizes compare across runs.
import type { EntryDraft } from "@earendil-works/pi-durable";

const usage = (input: number) => ({
	input,
	output: 400,
	cacheRead: input * 4,
	cacheWrite: 200,
	totalTokens: input * 5 + 600,
	cost: { input: 0.001, output: 0.002, cacheRead: 0.0005, cacheWrite: 0.0002, total: 0.0037 },
});

/** A deterministic pseudo-random generator, so text compresses about as well as real code and logs do. */
let seed = 1;
const random = () => {
	seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
	return seed / 2_147_483_648;
};
const word = () => {
	const length = 2 + Math.floor(random() * 9);
	let text = "";
	for (let index = 0; index < length; index++) text += String.fromCharCode(97 + Math.floor(random() * 26));
	return random() < 0.1 ? `${text}(${Math.floor(random() * 1000)})` : text;
};
const vocabulary = Array.from({ length: 3000 }, word);
const lines = (count: number, prefix: string) =>
	Array.from(
		{ length: count },
		(_, index) =>
			`${prefix} ${index}: ${Array.from({ length: 8 + Math.floor(random() * 6) }, () => vocabulary[Math.floor(random() * vocabulary.length)]).join(" ")}`,
	).join("\n");

/** About `count` entries; every fifth tool result is large (`bigBytes`), the others a few lines. */
export function bigSessionEntries(count: number, bigBytes = 24_000): EntryDraft[] {
	seed = 1;
	const entries: EntryDraft[] = [];
	const author = { kind: "owner", id: "owner", name: "Owner" };
	let turn = 0;
	let time = 1_700_000_000_000;
	while (entries.length < count) {
		turn++;
		const text = `Please look at module ${turn} and fix what is broken.`;
		entries.push({
			kind: "p2.input",
			data: { author, text, attachments: [] },
			model: [{ role: "user", content: [{ type: "text", text }], timestamp: time++ }],
		} as EntryDraft);
		for (let call = 0; call < 3; call++) {
			const id = `call-${turn}-${call}`;
			const big = (turn * 3 + call) % 5 === 0;
			entries.push({
				kind: "pi.assistant",
				model: [
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: lines(8, `Thinking about step ${call}`) },
							{ type: "text", text: `Step ${call}: reading the file.` },
							{
								type: "toolCall",
								id,
								name: call === 2 ? "bash" : "read",
								arguments: { path: `src/m${turn}.ts` },
							},
						],
						api: "faux",
						provider: "faux",
						model: "faux-1",
						usage: usage(10_000 + turn * 50),
						stopReason: "toolUse",
						timestamp: time++,
					},
				],
			} as EntryDraft);
			const output = big ? lines(Math.ceil(bigBytes / 100), `line`) : lines(4, "ok");
			entries.push({
				kind: "pi.tool-result",
				model: [
					{
						role: "toolResult",
						toolCallId: id,
						toolName: call === 2 ? "bash" : "read",
						content: [{ type: "text", text: output }],
						isError: false,
						timestamp: time++,
					},
				],
			} as EntryDraft);
		}
		entries.push({
			kind: "pi.assistant",
			model: [
				{
					role: "assistant",
					content: [{ type: "text", text: `Fixed module ${turn}. ${"Explanation. ".repeat(20)}` }],
					api: "faux",
					provider: "faux",
					model: "faux-1",
					usage: usage(12_000 + turn * 50),
					stopReason: "stop",
					timestamp: time++,
				},
			],
		} as EntryDraft);
	}
	return entries;
}
