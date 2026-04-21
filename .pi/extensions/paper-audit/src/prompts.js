/**
 * @typedef {Object} PromptPair
 * @property {string} systemPrompt
 * @property {string} user
 *
 * @typedef {Object} Chunk
 * @property {string} id
 * @property {string} title
 * @property {string} text
 *
 * @typedef {Object} OutlineItem
 * @property {string} id
 * @property {string} kind
 * @property {string} title
 * @property {string} text
 * @property {string[]} [dependencies]
 *
 * @typedef {Object} Outline
 * @property {OutlineItem[]} sections
 * @property {OutlineItem[]} theorems
 * @property {OutlineItem[]} definitions
 * @property {OutlineItem[]} notation
 *
 * @typedef {Object} ChunkNote
 * @property {string} chunkId
 * @property {string} chunkTitle
 * @property {string} claim
 * @property {string[]} dependencies
 * @property {string} proofSketch
 * @property {string} potentialGap
 * @property {"none" | "minor" | "major"} severity
 * @property {number} confidence
 */

/**
 * @param {string} paperText
 * @returns {PromptPair}
 */
export function outlinePrompt(paperText) {
	return {
		systemPrompt: [
			"You are a meticulous mathematics paper reader.",
			"Your task is to extract the structural outline of a paper.",
			"Reply with JSON only - no prose, no markdown fences.",
		].join(" "),
		user: [
			"Read the paper below and return a JSON object matching this TypeScript type:",
			"",
			"```ts",
			"type OutlineItemKind = 'section' | 'theorem' | 'lemma' | 'proposition' | 'corollary' | 'definition' | 'notation';",
			"interface OutlineItem { id: string; kind: OutlineItemKind; title: string; text: string; dependencies?: string[] }",
			"interface Outline { sections: OutlineItem[]; theorems: OutlineItem[]; definitions: OutlineItem[]; notation: OutlineItem[] }",
			"```",
			"",
			"Rules:",
			"- `id` must be a short stable slug unique across the whole outline.",
			"- `text` is a short paraphrase (1-3 sentences), NOT a full quote.",
			"- `dependencies` lists ids of prior outline items this item explicitly invokes.",
			"- Put lemmas, propositions, corollaries under `theorems` (kind tags them).",
			"- Include any distinctive notation that will be reused in proofs.",
			"- Return a single JSON object, nothing else.",
			"",
			"Paper:",
			"```",
			paperText,
			"```",
		].join("\n"),
	};
}

/**
 * @param {Chunk} chunk
 * @param {Outline} outline
 * @returns {PromptPair}
 */
export function chunkAuditPrompt(chunk, outline) {
	const outlineSummary = summarizeOutlineForContext(outline);
	return {
		systemPrompt: [
			"You are a mathematics proof reviewer.",
			"Audit one chunk of a paper at a time and return JSON only - no prose, no markdown fences.",
		].join(" "),
		user: [
			"Outline of the overall paper (for context):",
			"```json",
			outlineSummary,
			"```",
			"",
			"Audit the following chunk. Return a JSON object with this exact shape:",
			"",
			"```ts",
			"interface ChunkNote {",
			"  chunkId: string;        // must equal the chunk id provided below",
			"  chunkTitle: string;     // must equal the chunk title provided below",
			"  claim: string;          // what is being proved or established",
			"  dependencies: string[]; // outline ids of results invoked",
			"  proofSketch: string;    // paraphrase of the proof steps in plain language",
			"  potentialGap: string;   // empty string if none; otherwise describe the suspicious or unjustified step",
			"  severity: 'none' | 'minor' | 'major';",
			"  confidence: number;     // 0 (no confidence) to 1 (fully confident)",
			"}",
			"```",
			"",
			"Chunk:",
			`- id: ${chunk.id}`,
			`- title: ${chunk.title}`,
			"- text:",
			"```",
			chunk.text,
			"```",
		].join("\n"),
	};
}

/**
 * @param {Outline} outline
 * @param {ChunkNote[]} notes
 * @returns {PromptPair}
 */
export function finalReportPrompt(outline, notes) {
	return {
		systemPrompt: [
			"You write concise, faithful summaries of mathematical paper audits.",
			"You only use the outline and chunk notes you are given.",
			"Do not invent claims, theorems, or gaps that are not in the input.",
		].join(" "),
		user: [
			"Write a markdown audit report with these sections, in order:",
			"",
			"# Overall Summary",
			"# Main Theorems",
			"# Proofs That Appear Coherent",
			"# Proofs With Possible Gaps",
			"# Unclear Definitions or Notation",
			"# Suggested Manual Review",
			"",
			"Rules:",
			"- Reference items by outline id in backticks, e.g. `thm-1`.",
			"- 'Possible Gaps' must list every note with severity != 'none', quoting the note's `potentialGap` field.",
			"- Keep each bullet short and factual.",
			"- Output pure markdown only (no JSON, no code fences around the whole thing).",
			"",
			"Outline:",
			"```json",
			JSON.stringify(outline, null, 2),
			"```",
			"",
			"Chunk notes:",
			"```json",
			JSON.stringify(notes, null, 2),
			"```",
		].join("\n"),
	};
}

/** @param {Outline} outline */
function summarizeOutlineForContext(outline) {
	const compact = {
		sections: outline.sections.map((s) => ({ id: s.id, title: s.title })),
		theorems: outline.theorems.map((t) => ({ id: t.id, kind: t.kind, title: t.title })),
		definitions: outline.definitions.map((d) => ({ id: d.id, title: d.title })),
		notation: outline.notation.map((n) => ({ id: n.id, title: n.title })),
	};
	return JSON.stringify(compact, null, 2);
}
