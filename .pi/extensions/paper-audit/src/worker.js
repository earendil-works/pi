import * as fs from "node:fs";
import * as path from "node:path";
import { completeSimple, getEnvApiKey, getModel } from "@mariozechner/pi-ai";
import {
	appendLog,
	getTaskDir,
	readStatus,
	updateStatus,
	writeArtifact,
} from "./task-manager.js";
import { chunkAuditPrompt, finalReportPrompt, outlinePrompt } from "./prompts.js";

/** @typedef {import("./prompts.js").PromptPair} PromptPair */
/** @typedef {import("./prompts.js").Chunk} Chunk */
/** @typedef {import("./prompts.js").Outline} Outline */
/** @typedef {import("./prompts.js").ChunkNote} ChunkNote */
/** @typedef {import("./task-manager.js").TaskStatus} TaskStatus */

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL_ID = "claude-sonnet-4-5";
const DEFAULT_CHUNK_CHAR_TARGET = 3500;

/**
 * @typedef {Object} ResolvedModel
 * @property {any} model
 * @property {string} provider
 * @property {string} id
 *
 * @typedef {Object} WorkerOptions
 * @property {string} cwd
 * @property {string} taskId
 */

/**
 * @param {WorkerOptions} opts
 */
export async function runWorker(opts) {
	const { cwd, taskId } = opts;
	try {
		const status = await readStatus(cwd, taskId);
		if (!status) throw new Error(`status.json not found for ${taskId}`);
		await appendLog(cwd, taskId, `worker pid=${process.pid} starting`);

		await updateStatus(cwd, taskId, { state: "running", stage: "extract-text", progress: 0.05 });
		const extracted = await stageExtractText(cwd, taskId, status);

		const resolved = resolveModel();
		await appendLog(cwd, taskId, `using model ${resolved.provider}/${resolved.id}`);

		await updateStatus(cwd, taskId, { stage: "build-outline", progress: 0.15 });
		const outline = await stageBuildOutline(cwd, taskId, resolved, extracted);

		const chunks = splitIntoChunks(extracted, outline);
		await appendLog(cwd, taskId, `split into ${chunks.length} chunks`);

		const notes = await stageAuditChunks(cwd, taskId, resolved, chunks, outline);

		await updateStatus(cwd, taskId, { stage: "write-report", progress: 0.95 });
		await stageWriteReport(cwd, taskId, resolved, outline, notes);

		await updateStatus(cwd, taskId, { state: "completed", stage: "done", progress: 1 });
		await appendLog(cwd, taskId, "task completed");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await appendLog(cwd, taskId, `FAILED: ${message}`);
		await updateStatus(cwd, taskId, { state: "failed", error: message });
		throw err;
	}
}

/**
 * @param {string} cwd
 * @param {string} taskId
 * @param {TaskStatus} status
 */
async function stageExtractText(cwd, taskId, status) {
	const inputAbs = path.isAbsolute(status.input) ? status.input : path.join(cwd, status.input);
	if (!fs.existsSync(inputAbs)) throw new Error(`input file missing: ${inputAbs}`);
	const raw = await fs.promises.readFile(inputAbs, "utf-8");
	const normalized = normalizeText(raw);

	const inputBase = path.basename(inputAbs);
	const ext = path.extname(inputBase).toLowerCase();
	const inputArtifact = ext === ".md" || ext === ".markdown" ? "input.md" : "input.txt";
	await writeArtifact(cwd, taskId, inputArtifact, raw);
	await writeArtifact(cwd, taskId, "extracted.txt", normalized);
	await appendLog(cwd, taskId, `extracted ${normalized.length} chars from ${inputBase}`);
	return normalized;
}

/**
 * @param {string} cwd
 * @param {string} taskId
 * @param {ResolvedModel} resolved
 * @param {string} paperText
 * @returns {Promise<Outline>}
 */
async function stageBuildOutline(cwd, taskId, resolved, paperText) {
	const prompt = outlinePrompt(paperText);
	const outline = /** @type {Outline} */ (await askJson(resolved, prompt, isOutline));
	await writeArtifact(cwd, taskId, "outline.json", `${JSON.stringify(outline, null, 2)}\n`);
	await appendLog(
		cwd,
		taskId,
		`outline: ${outline.sections.length} sections, ${outline.theorems.length} theorem-like, ${outline.definitions.length} definitions`,
	);
	return outline;
}

/**
 * @param {string} cwd
 * @param {string} taskId
 * @param {ResolvedModel} resolved
 * @param {Chunk[]} chunks
 * @param {Outline} outline
 * @returns {Promise<ChunkNote[]>}
 */
async function stageAuditChunks(cwd, taskId, resolved, chunks, outline) {
	/** @type {ChunkNote[]} */
	const notes = [];
	const total = Math.max(1, chunks.length);
	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		const stageId = `audit-chunk-${(i + 1).toString().padStart(2, "0")}`;
		await updateStatus(cwd, taskId, { stage: stageId, progress: 0.2 + 0.7 * (i / total) });
		await appendLog(cwd, taskId, `auditing chunk ${i + 1}/${chunks.length}: ${chunk.title}`);

		const prompt = chunkAuditPrompt(chunk, outline);
		const note = /** @type {ChunkNote} */ (await askJson(resolved, prompt, isChunkNote));
		note.chunkId = chunk.id;
		note.chunkTitle = chunk.title;
		notes.push(note);

		const rel = `notes/chunk-${(i + 1).toString().padStart(2, "0")}.md`;
		await writeArtifact(cwd, taskId, rel, renderNoteAsMarkdown(note));
		await updateStatus(cwd, taskId, { progress: 0.2 + 0.7 * ((i + 1) / total) });
	}
	await writeArtifact(cwd, taskId, "notes/index.json", `${JSON.stringify(notes, null, 2)}\n`);
	return notes;
}

/**
 * @param {string} cwd
 * @param {string} taskId
 * @param {ResolvedModel} resolved
 * @param {Outline} outline
 * @param {ChunkNote[]} notes
 */
async function stageWriteReport(cwd, taskId, resolved, outline, notes) {
	const prompt = finalReportPrompt(outline, notes);
	const report = await askText(resolved, prompt);
	const cleaned = stripCodeFenceWrapper(report).trim();
	await writeArtifact(cwd, taskId, "report.md", `${cleaned}\n`);
	await appendLog(cwd, taskId, `report written (${cleaned.length} chars)`);
}

/** @returns {ResolvedModel} */
function resolveModel() {
	const provider = process.env.PI_AUDIT_PROVIDER ?? DEFAULT_PROVIDER;
	const id = process.env.PI_AUDIT_MODEL ?? DEFAULT_MODEL_ID;
	const model = /** @type {any} */ (getModel(/** @type {any} */ (provider), /** @type {any} */ (id)));
	if (!model) throw new Error(`Unknown model: provider=${provider}, id=${id}`);
	const apiKey = getEnvApiKey(provider);
	if (!apiKey) {
		throw new Error(
			`No API key found for provider ${provider}. Set the provider env var (e.g. ANTHROPIC_API_KEY) before running /audit-paper.`,
		);
	}
	return { model, provider, id };
}

/**
 * @param {ResolvedModel} resolved
 * @param {PromptPair} prompt
 * @returns {Promise<string>}
 */
async function askText(resolved, prompt) {
	const message = await completeSimple(resolved.model, {
		systemPrompt: prompt.systemPrompt,
		messages: [{ role: "user", content: prompt.user, timestamp: Date.now() }],
	});
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		throw new Error(message.errorMessage ?? `model ${message.stopReason}`);
	}
	const text = message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	if (!text) throw new Error("model returned no text");
	return text;
}

/**
 * @param {ResolvedModel} resolved
 * @param {PromptPair} prompt
 * @param {(value: unknown) => boolean} validator
 * @param {number} [maxRetries]
 * @returns {Promise<unknown>}
 */
async function askJson(resolved, prompt, validator, maxRetries = 2) {
	/** @type {Error | undefined} */
	let lastError;
	let lastText = "";
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const userPrompt =
			attempt === 0
				? prompt.user
				: `${prompt.user}\n\n(Previous attempt returned invalid JSON: ${lastError?.message ?? "unknown"}. Output valid JSON only.)`;
		const text = await askText(resolved, { systemPrompt: prompt.systemPrompt, user: userPrompt });
		lastText = text;
		const extracted = extractJsonBlock(text);
		try {
			const parsed = JSON.parse(extracted);
			if (!validator(parsed)) {
				lastError = new Error("JSON did not match expected shape");
				continue;
			}
			return parsed;
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
		}
	}
	throw new Error(
		`failed to parse JSON after ${maxRetries + 1} attempts: ${lastError?.message}. Last text: ${lastText.slice(0, 200)}`,
	);
}

/** @param {string} text */
function extractJsonBlock(text) {
	const trimmed = text.trim();
	const fence = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
	if (fence) return fence[1].trim();
	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		return trimmed.slice(firstBrace, lastBrace + 1);
	}
	return trimmed;
}

/** @param {string} text */
function stripCodeFenceWrapper(text) {
	const match = text.trim().match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
	return match ? match[1] : text;
}

/** @param {string} raw */
function normalizeText(raw) {
	return raw.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n");
}

/**
 * @param {string} text
 * @param {Outline} outline
 * @param {number} [target]
 * @returns {Chunk[]}
 */
export function splitIntoChunks(text, outline, target = DEFAULT_CHUNK_CHAR_TARGET) {
	const bySection = splitBySectionHeadings(text);
	const raw = bySection.length > 0 ? bySection : [{ title: "paper", body: text }];

	/** @type {Chunk[]} */
	const chunks = [];
	for (const section of raw) {
		const pieces = splitLongBody(section.body, target);
		for (let i = 0; i < pieces.length; i++) {
			const idBase = slugify(section.title) || `chunk-${chunks.length + 1}`;
			const id = pieces.length === 1 ? idBase : `${idBase}-${i + 1}`;
			const title = pieces.length === 1 ? section.title : `${section.title} (part ${i + 1})`;
			chunks.push({ id, title, text: pieces[i].trim() });
		}
	}
	annotateWithOutlineHits(chunks, outline);
	return chunks.filter((c) => c.text.length > 0);
}

/**
 * @param {string} text
 * @returns {{ title: string; body: string }[]}
 */
function splitBySectionHeadings(text) {
	const lines = text.split("\n");
	/** @type {{ title: string; body: string[] }[]} */
	const sections = [];
	/** @type {{ title: string; body: string[] } | null} */
	let current = null;
	for (const line of lines) {
		const heading = line.match(/^(#{1,6})\s+(.*)$/);
		if (heading) {
			if (current) sections.push(current);
			current = { title: heading[2].trim(), body: [] };
			continue;
		}
		if (!current) current = { title: "preamble", body: [] };
		current.body.push(line);
	}
	if (current) sections.push(current);
	return sections
		.map((s) => ({ title: s.title, body: s.body.join("\n").trim() }))
		.filter((s) => s.body.length > 0);
}

/**
 * @param {string} body
 * @param {number} target
 * @returns {string[]}
 */
function splitLongBody(body, target) {
	if (body.length <= target * 1.5) return [body];
	const paragraphs = body.split(/\n{2,}/);
	/** @type {string[]} */
	const chunks = [];
	let buf = "";
	for (const para of paragraphs) {
		if (buf.length + para.length + 2 > target && buf.length > 0) {
			chunks.push(buf);
			buf = "";
		}
		buf = buf.length === 0 ? para : `${buf}\n\n${para}`;
	}
	if (buf.length > 0) chunks.push(buf);
	return chunks;
}

/**
 * @param {Chunk[]} chunks
 * @param {Outline} outline
 */
function annotateWithOutlineHits(chunks, outline) {
	const ids = [...outline.theorems.map((t) => t.id), ...outline.definitions.map((d) => d.id)];
	for (const chunk of chunks) {
		const hits = ids.filter((id) => chunk.text.toLowerCase().includes(id.toLowerCase()));
		if (hits.length > 0) chunk.title = `${chunk.title} [${hits.slice(0, 3).join(", ")}]`;
	}
}

/** @param {string} s */
function slugify(s) {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
}

/** @param {ChunkNote} note */
function renderNoteAsMarkdown(note) {
	const lines = [
		`# ${note.chunkTitle}`,
		"",
		`Claim reviewed: ${note.claim}`,
		`Dependencies used: ${note.dependencies.length > 0 ? note.dependencies.join(", ") : "(none listed)"}`,
		"",
		"Proof sketch in plain language:",
		note.proofSketch,
		"",
		`Potential gap: ${note.potentialGap || "(none)"}`,
		`Severity: ${note.severity}`,
		`Confidence: ${note.confidence.toFixed(2)}`,
		"",
	];
	return lines.join("\n");
}

/** @param {unknown} value */
function isOutline(value) {
	if (!value || typeof value !== "object") return false;
	const v = /** @type {Record<string, unknown>} */ (value);
	return (
		Array.isArray(v.sections) &&
		Array.isArray(v.theorems) &&
		Array.isArray(v.definitions) &&
		Array.isArray(v.notation)
	);
}

/** @param {unknown} value */
function isChunkNote(value) {
	if (!value || typeof value !== "object") return false;
	const v = /** @type {Record<string, unknown>} */ (value);
	return (
		typeof v.claim === "string" &&
		Array.isArray(v.dependencies) &&
		typeof v.proofSketch === "string" &&
		typeof v.potentialGap === "string" &&
		(v.severity === "none" || v.severity === "minor" || v.severity === "major") &&
		typeof v.confidence === "number"
	);
}

/**
 * @param {string} cwd
 * @param {string} taskId
 */
export function taskAbsolutePath(cwd, taskId) {
	return getTaskDir(cwd, taskId);
}
