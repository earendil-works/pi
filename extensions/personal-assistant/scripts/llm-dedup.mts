#!/usr/bin/env tsx
// One-shot LLM-driven dedup sweep.
//
// The extraction pipeline embeds atoms with bge-m3 and dedups at 0.65
// cosine. That threshold misses a class of duplicate the corpus has
// accumulated: rephrased translations (Chinese vs English) and
// semantically-equivalent content with low vector overlap. This script
// asks the configured extraction LLM to judge the full active corpus
// (title + summary only, not the .md body) and decide which atoms are
// duplicates. Losers are marked `is_latest = 0` with `parent_id`
// pointing at the KEEP atom (the first id in each group) — same shape
// as the post-supersede state produced by `markSupersededTx`, so the
// rest of the system (recall, format, audit) handles them uniformly.
//
// CLI:
//   --apply           actually mutate memory_index; default is dry-run
//   --help, -h        print usage
//   --model=ID        override extraction model (default: settings.json)
//
// Dry-run prints the planned merge groups; --apply commits them.

import { copyFile, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { MemoryIndex } from "../storage.ts";
import { DEFAULT_ATOMS_DIR, DEFAULT_DB_PATH, loadConfig } from "../memory.ts";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { z } from "zod";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: npx tsx scripts/llm-dedup.mts [options]

Options:
  --apply            Mutate memory_index (default: dry-run)
  --help, -h         Show this help
  --model=ID         Override extraction model (default: settings.json extraction)

Dry-run prints the planned merge groups; --apply commits them. A backup of
memory.db is written next to it before any mutation.
`;

function parseArgs(argv: string[]): { apply: boolean; help: boolean; modelOverride?: string } {
	let apply = false;
	let help = false;
	let modelOverride: string | undefined;
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		if (arg === "--apply") apply = true;
		else if (arg === "--help" || arg === "-h") help = true;
		else if (arg.startsWith("--model=")) modelOverride = arg.slice("--model=".length);
	}
	return { apply, help, modelOverride };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface LlmConfig {
	provider: string;
	model: string;
	apiKey: string;
	baseUrl?: string;
	api: string;
}

async function loadLlmConfig(modelOverride?: string): Promise<LlmConfig> {
	// settings.json holds the configured provider/model for extraction.
	const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
	const settings = JSON.parse(await readFile(settingsPath, "utf8"));
	const ext = settings.personalAssistant?.memory?.extraction;
	if (!ext?.provider || !ext?.model) {
		throw new Error("settings.json missing personalAssistant.memory.extraction.{provider,model}");
	}

	// models.json holds the per-provider connection + key.
	const modelsPath = join(homedir(), ".pi", "agent", "models.json");
	const modelsDoc = JSON.parse(await readFile(modelsPath, "utf8"));
	const providerCfg = modelsDoc.providers?.[modelOverride ? ext.provider : ext.provider];
	if (!providerCfg) throw new Error(`provider ${ext.provider} not in models.json`);
	const apiKey = providerCfg.apiKey;
	const baseUrl = providerCfg.baseUrl;
	const api = providerCfg.api;
	if (!apiKey || !baseUrl || !api) {
		throw new Error(`provider ${ext.provider} missing apiKey/baseUrl/api in models.json`);
	}

	// --model=foo overrides the model id but keeps the provider config.
	const modelId = modelOverride ?? ext.model;
	return { provider: ext.provider, model: modelId, apiKey, baseUrl, api };
}

// ---------------------------------------------------------------------------
// LLM dedup judge
// ---------------------------------------------------------------------------

const judgeResponseSchema = z.object({
	groups: z.array(z.array(z.string())).describe(
		"Each group is a list of atom ids that are duplicates of each other. " +
		"The FIRST id in each group is the KEEP atom; the rest will be superseded. " +
		"Atoms that have no duplicates should NOT appear in any group.",
	),
});

type JudgeResponse = z.infer<typeof judgeResponseSchema>;

function buildJudgePrompt(
	atoms: Array<{ id: string; type: string; title: string; summary: string }>,
): string {
	const list = atoms
		.map((a, i) => `${i + 1}. [${a.type}] id=${a.id}\n   title: ${a.title}\n   summary: ${a.summary}`)
		.join("\n\n");
	return `You are a deduplication judge for a knowledge atom corpus.

Your response MUST be a single JSON object and nothing else. No prose, no preamble, no markdown fence, no explanation before or after. Start your reply with \`{\` and end with \`}\`.

## Task

Below are ${atoms.length} atoms from the same corpus. Identify groups of atoms that represent the SAME underlying knowledge and should be merged.

Rules:
- A "duplicate" means they convey the same fact / rule / process — not just that they share a topic.
- Rephrased translations (e.g. Chinese vs English versions of the same rule) are duplicates.
- Atoms that share a project but cover DIFFERENT aspects (e.g. one about the project structure, another about its statistics) are NOT duplicates.
- Be CONSERVATIVE: when in doubt, do NOT group. False positives (merging unrelated atoms) are worse than false negatives.
- Atoms with no duplicates should not appear in any group.

## Output Schema (strict JSON)

{
  "groups": [
    ["<keepId1>", "<dupId1>", "<dupId2>"],
    ["<keepId2>", "<dupId3>"]
  ]
}

- Each group is an array of atom ids that are duplicates of each other.
- The FIRST id in each group is the KEEP atom; the rest will be superseded.
- Atoms not in any group have no duplicates.

## Atoms

${list}
`;
}

async function callJudge(
	llm: LlmConfig,
	atoms: Array<{ id: string; type: string; title: string; summary: string }>,
): Promise<JudgeResponse> {
	const prompt = buildJudgePrompt(atoms);

	// Build a minimal model object. completeSimple only needs the fields
	// the chosen api implementation reads. anthropic-messages needs id, name,
	// api, provider, baseUrl; others similar. We pass through the same shape
	// that pi's own modelRegistry builds.
	if (!llm.baseUrl) throw new Error("provider missing baseUrl");
	const model = {
		id: llm.model,
		name: llm.model,
		api: llm.api as "anthropic-messages",
		provider: llm.provider,
		baseUrl: llm.baseUrl,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
	};

	// Anthropic-messages expects x-api-key; openai-completions expects
	// Authorization. Match the same convention the extraction hook uses
	// in memory.ts:446-453.
	const headers: Record<string, string> = {};
	if (llm.api === "anthropic-messages") {
		headers["x-api-key"] = llm.apiKey;
		headers["anthropic-version"] = "2023-06-01";
	} else {
		headers["Authorization"] = `Bearer ${llm.apiKey}`;
	}

	const response = await completeSimple(
		model,
		{
			systemPrompt: "You are a deduplication judge. Respond with a single JSON object only — no prose, no markdown fence, no preamble. Start with { and end with }.",
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		},
		{ apiKey: llm.apiKey, headers, maxTokens: 8192 },
	);

	// completeSimple may return thinking + text content. Prefer text; fall
	// back to stripping <think> blocks from the thinking field if text is
	// empty (same pattern as extraction.ts:497-507).
	const textParts: string[] = [];
	const thinkingParts: string[] = [];
	for (const c of response.content ?? []) {
		if (c.type === "text" && "text" in c) textParts.push(c.text);
		else if (c.type === "thinking" && "thinking" in c) thinkingParts.push(c.thinking);
	}
	let text: string | undefined;
	if (textParts.length > 0) text = textParts.join("");
	else if (thinkingParts.length > 0) {
		const stripped = thinkingParts.join("").replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
		if (stripped.length > 0) text = stripped;
	}
	if (!text) {
		throw new Error(
			`LLM returned no text content. raw content types: ${(response.content ?? []).map((c) => c.type).join(",")}`,
		);
	}

	// Strip any markdown wrapper the model might have added.
	const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

	let raw: unknown;
	try {
		raw = JSON.parse(cleaned);
	} catch (err) {
		throw new Error(`LLM response not valid JSON: ${cleaned.slice(0, 500)}`);
	}

	const result = judgeResponseSchema.safeParse(raw);
	if (!result.success) {
		throw new Error(`LLM response failed schema: ${result.error.message}\nraw: ${cleaned.slice(0, 500)}`);
	}
	return result.data;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const { apply, help, modelOverride } = parseArgs(process.argv);
	if (help) {
		console.log(USAGE);
		return;
	}

	const config = loadConfig();
	const dbPath =
		process.env.PERSONAL_ASSISTANT_DB_PATH ?? config.memory?.dbPath ?? DEFAULT_DB_PATH;
	const atomsDir =
		process.env.PERSONAL_ASSISTANT_ATOMS_DIR ?? config.memory?.atomsDir ?? DEFAULT_ATOMS_DIR;

	const llm = await loadLlmConfig(modelOverride);
	console.log(`LLM: ${llm.provider}/${llm.model} (api=${llm.api})`);

	const index = new MemoryIndex(dbPath);
	await index.init();
	try {
		const active = index.listAtoms();
		console.log(`active atoms: ${active.length}`);

		// Build the judge input.
		const judgeInput = active.map((a) => ({
			id: a.id,
			type: a.type,
			title: a.title,
			summary: a.summary,
		}));

		console.log("calling LLM dedup judge...");
		const judgment = await callJudge(llm, judgeInput);
		console.log(`LLM returned ${judgment.groups.length} duplicate groups`);

		// Validate: every id must be an active atom; every group needs >=2.
		const activeIds = new Set(active.map((a) => a.id));
		const validGroups: Array<{ keep: string; dups: string[] }> = [];
		const skipped: Array<{ reason: string; ids: string[] }> = [];
		for (const group of judgment.groups) {
			if (group.length < 2) {
				skipped.push({ reason: "group has <2 members", ids: group });
				continue;
			}
			const keep = group[0]!;
			const dups = group.slice(1);
			if (!activeIds.has(keep)) {
				skipped.push({ reason: `keep id ${keep} not active`, ids: group });
				continue;
			}
			const invalidDups = dups.filter((d) => !activeIds.has(d));
			if (invalidDups.length > 0) {
				skipped.push({ reason: `dup ids not active: ${invalidDups.join(",")}`, ids: group });
				continue;
			}
			validGroups.push({ keep, dups });
		}

		console.log(`valid groups: ${validGroups.length}, skipped: ${skipped.length}`);
		for (const s of skipped) {
			console.warn(`  SKIP: ${s.reason} [${s.ids.join(", ")}]`);
		}

		// Print the plan.
		console.log("\n--- merge plan ---");
		for (const g of validGroups) {
			const keepAtom = active.find((a) => a.id === g.keep);
			console.log(`\nKEEP: [${keepAtom?.type}] ${keepAtom?.title} (${g.keep.slice(0, 12)})`);
			for (const dup of g.dups) {
				const dupAtom = active.find((a) => a.id === dup);
				console.log(`  DUP: [${dupAtom?.type}] ${dupAtom?.title} (${dup.slice(0, 12)})`);
			}
		}

		// Persist the report regardless of dry-run / apply.
		const report = {
			timestamp: new Date().toISOString(),
			mode: apply ? "apply" : "dry-run",
			totalActiveAtoms: active.length,
			groupCount: validGroups.length,
			mergeCount: validGroups.reduce((n, g) => n + g.dups.length, 0),
			groups: validGroups,
			skipped,
		};
		const reportPath = join(atomsDir, "..", "llm-dedup-report.json");
		await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
		console.log(`\nreport: ${reportPath}`);

		if (!apply) {
			console.log("\nDRY RUN. Re-run with --apply to commit.");
			return;
		}

		// Backup before mutating.
		const backupPath = `${dbPath}.bak.${new Date().toISOString().slice(0, 10)}-${Date.now()}`;
		await copyFile(dbPath, backupPath);
		console.log(`\nbackup: ${backupPath}`);

		// Apply. markSupersededNoInsert sets is_latest=0 + parent_id=keep.id
		// in a single UPDATE; that's exactly the post-supersede state we want.
		// Vector rows for losers become orphan; deleteVector keeps the
		// memory_vectors table tidy.
		const now = Date.now();
		let merged = 0;
		for (const g of validGroups) {
			for (const dup of g.dups) {
				index.markSupersededNoInsert(dup, g.keep, now);
				index.deleteVector(dup);
				index.insertAudit(dup, "llm_dedup_merged", { keepId: g.keep });
				merged++;
			}
		}
		console.log(`\napplied: ${merged} atoms marked superseded (parent=${validGroups.length} keepers)`);
		console.log(`final active count: ${active.length - merged}`);
	} finally {
		index.close();
	}
}

const isDirectInvocation =
	process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectInvocation) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
