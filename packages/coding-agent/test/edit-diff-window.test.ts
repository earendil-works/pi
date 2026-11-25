import { execFileSync } from "child_process";
import { applyPatch } from "diff";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { describe, expect, it } from "vitest";
import {
	generateDiffString,
	generateEditDiff,
	generateUnifiedPatch,
	type TextReplacement,
} from "../src/core/tools/edit-diff.ts";

/** Small deterministic generator (mulberry32), using the high bits. */
function createRandom(seed: number): (max: number) => number {
	let state = seed;
	return (max) => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
	};
}

function applyReplacements(content: string, replacements: TextReplacement[]): string {
	let result = "";
	let position = 0;
	for (const replacement of replacements) {
		result += content.slice(position, replacement.matchIndex) + replacement.newText;
		position = replacement.matchIndex + replacement.matchLength;
	}
	return result + content.slice(position);
}

/** Random content and sorted, disjoint, non-empty replacements; `distinct` makes every line unique. */
function randomCase(random: (max: number) => number, distinct: boolean) {
	const lineCount = random(400);
	const lines = Array.from({ length: lineCount }, (_, i) => (distinct ? `line ${i}` : ["a", "b", "", "}"][random(4)]));
	const content = lines.join("\n") + (random(2) === 0 ? "\n" : "");
	const replacements: TextReplacement[] = [];
	let position = 0;
	const count = 1 + random(4);
	for (let i = 0; i < count && position < content.length; i++) {
		const matchIndex = position + random(Math.min(content.length - position, 300));
		if (matchIndex >= content.length) break;
		const matchLength = 1 + random(Math.min(content.length - matchIndex, 120));
		const newLines = Array.from({ length: random(4) }, (_, j) => `new ${i} ${j}`);
		const newText = random(3) === 0 ? "" : newLines.join("\n") + (random(2) === 0 ? "\n" : "");
		replacements.push({ matchIndex, matchLength, newText });
		position = matchIndex + matchLength;
	}
	return { content, replacements, newContent: applyReplacements(content, replacements) };
}

describe("generateEditDiff", () => {
	it("matches the whole-file diff and patch when lines are distinct", () => {
		const random = createRandom(1);
		for (let run = 0; run < 2000; run++) {
			const { content, replacements, newContent } = randomCase(random, true);
			if (content === newContent) continue;
			const windowed = generateEditDiff("f.txt", content, newContent, replacements);
			const whole = generateDiffString(content, newContent);
			expect(windowed, `run ${run}`).toEqual({
				diff: whole.diff,
				patch: generateUnifiedPatch("f.txt", content, newContent),
				firstChangedLine: whole.firstChangedLine,
			});
		}
	});

	it("produces a patch that applies when lines repeat", () => {
		const random = createRandom(2);
		for (let run = 0; run < 2000; run++) {
			const { content, replacements, newContent } = randomCase(random, false);
			if (content === newContent) continue;
			const { patch } = generateEditDiff("f.txt", content, newContent, replacements);
			expect(applyPatch(content, patch), `run ${run}`).toBe(newContent);
		}
	});

	it("handles a replacement of many lines", () => {
		const newText = "x\n".repeat(150000);
		const replacements = [{ matchIndex: 0, matchLength: 2, newText }];
		const { patch } = generateEditDiff("f.txt", "a\nb\n", `${newText}b\n`, replacements);
		expect(applyPatch("a\nb\n", patch)).toBe(`${newText}b\n`);
	});

	it("diffs a small change in a 20 MB file with a 96 MB heap", () => {
		// A child process, so a regression to diffing the whole file runs out of memory instead of passing.
		const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
		const editDiffUrl = pathToFileURL(resolve(__dirname, "../src/core/tools/edit-diff.ts")).href;
		const script = `
			import { generateEditDiff } from ${JSON.stringify(editDiffUrl)};
			const filler = "x".repeat(99) + "\\n";
			const half = filler.repeat(100000);
			const base = half + "TARGET = 1\\n" + half;
			const replacement = { matchIndex: half.length, matchLength: 10, newText: "TARGET = 2" };
			const changed = half + "TARGET = 2\\n" + half;
			const { diff } = generateEditDiff("big.txt", base, changed, [replacement]);
			process.stdout.write(diff.split("\\n").filter((line) => /^[+-]/.test(line)).join("\\n"));
		`;
		const output = execFileSync(
			process.execPath,
			["--max-old-space-size=96", "--import", sourceResolverUrl, "--input-type=module", "--eval", script],
			{ encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
		);
		expect(output).toBe("-100001 TARGET = 1\n+100001 TARGET = 2");
	});
});
