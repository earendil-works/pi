import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { Type } from "typebox";

const CASE_ROOT = ".osint/cases";
const DEFAULT_CASE = "default";
const LOCAL_PROVIDER = "local-openai";
const DEFAULT_MODEL = process.env.PI_OSINT_MODEL ?? "qwythos-9b";
const DEFAULT_BASE_URL = process.env.PI_OSINT_BASE_URL ?? "http://localhost:11434/v1";

interface EvidenceRecord {
	id: string;
	type: "webpage" | "note" | "artifact";
	title: string;
	sourceUrl?: string;
	retrievedAt: string;
	sha256: string;
	textPath: string;
	rawPath?: string;
	summary?: string;
	entities: string[];
	claims: string[];
	confidence: "unreviewed" | "low" | "medium" | "high";
}

interface CaseIndex {
	name: string;
	createdAt: string;
	updatedAt: string;
	evidence: EvidenceRecord[];
}

function slugify(value: string): string {
	const slug = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || DEFAULT_CASE;
}

function caseDir(cwd: string, name: string): string {
	return join(cwd, CASE_ROOT, slugify(name));
}

function indexPath(cwd: string, name: string): string {
	return join(caseDir(cwd, name), "case.json");
}

function nowIso(): string {
	return new Date().toISOString();
}

function ensureCase(cwd: string, name: string): CaseIndex {
	const dir = caseDir(cwd, name);
	const evidenceDir = join(dir, "evidence");
	mkdirSync(evidenceDir, { recursive: true });
	const path = indexPath(cwd, name);
	if (existsSync(path)) {
		return JSON.parse(readFileSync(path, "utf-8")) as CaseIndex;
	}
	const createdAt = nowIso();
	const index: CaseIndex = { name: slugify(name), createdAt, updatedAt: createdAt, evidence: [] };
	writeIndex(cwd, name, index);
	return index;
}

function writeIndex(cwd: string, name: string, index: CaseIndex): void {
	index.updatedAt = nowIso();
	writeFileSync(indexPath(cwd, name), `${JSON.stringify(index, null, 2)}\n`, "utf-8");
}

function nextEvidenceId(index: CaseIndex): string {
	return `ev-${String(index.evidence.length + 1).padStart(4, "0")}`;
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function extractTextFromHtml(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\s+/g, " ")
		.trim();
}

function guessTitle(source: string, text: string): string {
	const firstLine = text.split("\n").find((line) => line.trim());
	return firstLine?.slice(0, 120) || basename(source) || "Untitled evidence";
}

function writeEvidence(
	cwd: string,
	caseName: string,
	record: Omit<EvidenceRecord, "id" | "retrievedAt" | "sha256">,
	raw: string,
	text: string,
): EvidenceRecord {
	const index = ensureCase(cwd, caseName);
	const id = nextEvidenceId(index);
	const dir = join(caseDir(cwd, caseName), "evidence");
	const hash = sha256(raw || text);
	const textPath = `${id}.text.md`;
	const rawPath = raw ? `${id}.raw.txt` : undefined;
	writeFileSync(join(dir, textPath), text, "utf-8");
	if (rawPath) {
		writeFileSync(join(dir, rawPath), raw, "utf-8");
	}
	const evidence: EvidenceRecord = {
		...record,
		id,
		retrievedAt: nowIso(),
		sha256: hash,
		textPath,
		rawPath,
	};
	index.evidence.push(evidence);
	writeIndex(cwd, caseName, index);
	return evidence;
}

function readEvidenceText(cwd: string, caseName: string, record: EvidenceRecord): string {
	return readFileSync(join(caseDir(cwd, caseName), "evidence", record.textPath), "utf-8");
}

function tokenizeQuery(query: string): string[] {
	return query
		.toLowerCase()
		.split(/\W+/)
		.filter((token) => token.length > 2);
}

function renderEvidence(record: EvidenceRecord): string {
	const source = record.sourceUrl ? `\nSource: ${record.sourceUrl}` : "";
	return `${record.id}: ${record.title}${source}\nRetrieved: ${record.retrievedAt}\nSHA-256: ${record.sha256}\nConfidence: ${record.confidence}`;
}

const fetchUrlTool = defineTool({
	name: "osint_fetch_url",
	label: "OSINT Fetch URL",
	description: "Fetch a public URL, extract readable text, and store it as case evidence with timestamp and SHA-256.",
	promptSnippet: "Fetch public URLs into the local OSINT evidence store",
	promptGuidelines: [
		"Use OSINT tools for source-grounded investigations instead of relying on memory.",
		"Treat stored evidence IDs as citations and separate facts from inferences.",
	],
	parameters: Type.Object({
		url: Type.String({ description: "HTTP or HTTPS URL to fetch" }),
		caseName: Type.Optional(Type.String({ description: "Case name; defaults to default" })),
		summary: Type.Optional(Type.String({ description: "Short analyst note about why this source matters" })),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const url = new URL(params.url);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return {
				content: [{ type: "text", text: "Only http:// and https:// URLs are supported." }],
				details: undefined,
				isError: true,
			};
		}
		const response = await fetch(url, { signal, headers: { "user-agent": "pi-osint/0.1" } });
		const raw = await response.text();
		const contentType = response.headers.get("content-type") ?? "";
		const text = contentType.includes("html") ? extractTextFromHtml(raw) : raw;
		const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
		const title = titleMatch?.[1]?.replace(/\s+/g, " ").trim() || guessTitle(url.hostname, text);
		const evidence = writeEvidence(
			ctx.cwd,
			params.caseName ?? DEFAULT_CASE,
			{
				type: "webpage",
				title,
				sourceUrl: url.toString(),
				textPath: "",
				summary: params.summary,
				entities: [],
				claims: [],
				confidence: "unreviewed",
			},
			raw,
			`# ${title}\n\nSource: ${url.toString()}\nFetched: ${nowIso()}\n\n${text}\n`,
		);
		return { content: [{ type: "text", text: `Stored evidence.\n${renderEvidence(evidence)}` }], details: evidence };
	},
});

const saveEvidenceTool = defineTool({
	name: "osint_save_evidence",
	label: "OSINT Save Evidence",
	description: "Save analyst-provided text, claims, and entities as a local case evidence item.",
	promptSnippet: "Save notes or pasted source text into the OSINT evidence store",
	parameters: Type.Object({
		text: Type.String({ description: "Evidence text or analyst note" }),
		title: Type.Optional(Type.String({ description: "Evidence title" })),
		caseName: Type.Optional(Type.String({ description: "Case name; defaults to default" })),
		sourceUrl: Type.Optional(Type.String({ description: "Optional source URL" })),
		entities: Type.Optional(Type.Array(Type.String(), { description: "Known entities in this evidence" })),
		claims: Type.Optional(Type.Array(Type.String(), { description: "Claims supported by this evidence" })),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const evidence = writeEvidence(
			ctx.cwd,
			params.caseName ?? DEFAULT_CASE,
			{
				type: "note",
				title: params.title ?? guessTitle("note", params.text),
				sourceUrl: params.sourceUrl,
				textPath: "",
				entities: params.entities ?? [],
				claims: params.claims ?? [],
				confidence: "unreviewed",
			},
			params.text,
			params.text,
		);
		return { content: [{ type: "text", text: `Stored evidence.\n${renderEvidence(evidence)}` }], details: evidence };
	},
});

const searchEvidenceTool = defineTool({
	name: "osint_search_evidence",
	label: "OSINT Search Evidence",
	description: "Search evidence in a local OSINT case and return matching evidence IDs with snippets.",
	promptSnippet: "Search local case evidence before answering investigative questions",
	parameters: Type.Object({
		query: Type.String({ description: "Search query" }),
		caseName: Type.Optional(Type.String({ description: "Case name; defaults to default" })),
		limit: Type.Optional(Type.Number({ description: "Maximum matches to return" })),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const caseName = params.caseName ?? DEFAULT_CASE;
		const index = ensureCase(ctx.cwd, caseName);
		const tokens = tokenizeQuery(params.query);
		const matches = index.evidence
			.map((record) => {
				const text = readEvidenceText(ctx.cwd, caseName, record);
				const haystack = `${record.title}\n${record.sourceUrl ?? ""}\n${text}`.toLowerCase();
				const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
				const firstToken = tokens.find((token) => haystack.includes(token));
				const offset = firstToken ? Math.max(0, haystack.indexOf(firstToken) - 80) : 0;
				return { record, score, snippet: text.slice(offset, offset + 360).replace(/\s+/g, " ") };
			})
			.filter((match) => match.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, params.limit ?? 10);
		const body = matches.length
			? matches.map((match) => `${renderEvidence(match.record)}\nSnippet: ${match.snippet}`).join("\n\n")
			: "No matching evidence found.";
		return { content: [{ type: "text", text: body }], details: matches.map((match) => match.record) };
	},
});

const caseSummaryTool = defineTool({
	name: "osint_case_summary",
	label: "OSINT Case Summary",
	description: "Summarize the local case inventory: evidence, entities, claims, and source URLs.",
	promptSnippet: "List the current OSINT case inventory and evidence IDs",
	parameters: Type.Object({
		caseName: Type.Optional(Type.String({ description: "Case name; defaults to default" })),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const caseName = params.caseName ?? DEFAULT_CASE;
		const index = ensureCase(ctx.cwd, caseName);
		const entities = Array.from(new Set(index.evidence.flatMap((record) => record.entities))).sort();
		const claims = index.evidence.flatMap((record) => record.claims.map((claim) => `${record.id}: ${claim}`));
		const sources = index.evidence.flatMap((record) =>
			record.sourceUrl ? [`${record.id}: ${record.sourceUrl}`] : [],
		);
		const text = [
			`Case: ${index.name}`,
			`Evidence items: ${index.evidence.length}`,
			"",
			"Evidence:",
			...index.evidence.map(renderEvidence),
			"",
			"Entities:",
			...(entities.length ? entities : ["None recorded"]),
			"",
			"Claims:",
			...(claims.length ? claims : ["None recorded"]),
			"",
			"Sources:",
			...(sources.length ? sources : ["None recorded"]),
		].join("\n");
		return { content: [{ type: "text", text }], details: index };
	},
});

function writeReport(cwd: string, caseName: string): string {
	const index = ensureCase(cwd, caseName);
	const lines = [
		`# OSINT Report: ${index.name}`,
		"",
		`Generated: ${nowIso()}`,
		"",
		"## Evidence Register",
		"",
		...index.evidence.flatMap((record) =>
			[
				`### ${record.id}: ${record.title}`,
				"",
				record.sourceUrl ? `Source: ${record.sourceUrl}` : "Source: local note",
				`Retrieved: ${record.retrievedAt}`,
				`SHA-256: ${record.sha256}`,
				`Confidence: ${record.confidence}`,
				record.summary ? `Analyst note: ${record.summary}` : undefined,
				record.entities.length ? `Entities: ${record.entities.join(", ")}` : undefined,
				record.claims.length ? `Claims: ${record.claims.join("; ")}` : undefined,
				"",
			].filter((line): line is string => line !== undefined),
		),
		"## Analyst Guidance",
		"",
		"Separate verified facts from inferences. Cite evidence IDs for every material claim.",
	];
	const path = join(caseDir(cwd, caseName), "report.md");
	writeFileSync(path, `${lines.join("\n")}\n`, "utf-8");
	return path;
}

export default async function osintWorkstation(pi: ExtensionAPI) {
	let models = [{ id: DEFAULT_MODEL, name: `QwythOS 9B (${DEFAULT_MODEL})` }];
	try {
		const response = await fetch(`${DEFAULT_BASE_URL.replace(/\/$/, "")}/models`);
		const payload = (await response.json()) as { data?: Array<{ id: string; name?: string }> };
		if (payload.data?.length) {
			models = payload.data.map((model) => ({ id: model.id, name: model.name ?? model.id }));
		}
	} catch {
		models = [{ id: DEFAULT_MODEL, name: `QwythOS 9B (${DEFAULT_MODEL})` }];
	}

	pi.registerProvider(LOCAL_PROVIDER, {
		name: "Local OSINT OpenAI-compatible",
		baseUrl: DEFAULT_BASE_URL,
		apiKey: process.env.PI_OSINT_API_KEY ?? "osint-local",
		api: "openai-completions",
		models: models.map((model) => ({
			id: model.id,
			name: model.name,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: Number(process.env.PI_OSINT_CONTEXT_WINDOW ?? 32768),
			maxTokens: Number(process.env.PI_OSINT_MAX_TOKENS ?? 4096),
		})),
	});

	pi.registerTool(fetchUrlTool);
	pi.registerTool(saveEvidenceTool);
	pi.registerTool(searchEvidenceTool);
	pi.registerTool(caseSummaryTool);

	pi.registerCommand("osint-case", {
		description: "Create or inspect an OSINT case: /osint-case [name]",
		handler: async (args, ctx) => {
			const caseName = args.trim() || DEFAULT_CASE;
			const index = ensureCase(ctx.cwd, caseName);
			ctx.ui.notify(`Case ${index.name}: ${index.evidence.length} evidence items`, "info");
		},
	});

	pi.registerCommand("osint-report", {
		description: "Write the case evidence register report: /osint-report [name]",
		handler: async (args, ctx) => {
			const caseName = args.trim() || DEFAULT_CASE;
			const path = writeReport(ctx.cwd, caseName);
			ctx.ui.notify(`Wrote ${path}`, "info");
		},
	});

	pi.registerCommand("osint-cases", {
		description: "List OSINT cases in this workspace",
		handler: async (_args, ctx) => {
			const root = join(ctx.cwd, CASE_ROOT);
			if (!existsSync(root)) {
				ctx.ui.notify("No OSINT cases found", "info");
				return;
			}
			ctx.ui.notify(
				readdirSync(root, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => entry.name)
					.join("\n"),
				"info",
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus("osint", `OSINT ${LOCAL_PROVIDER}/${DEFAULT_MODEL}`);
	});

	pi.on("before_agent_start", () => ({
		systemPrompt: [
			"You are pi-osint, a local-first OSINT analyst workstation optimized for small local models.",
			"Use evidence tools before making factual claims. Treat evidence IDs as citations.",
			"Separate Verified, Likely, Unclear, and Unsupported statements.",
			"Do not invent facts, identities, relationships, dates, or sources.",
			"Prefer concise plans, source-grounded extraction, timelines, entity lists, and reports.",
			"Respect legal and ethical OSINT boundaries. Avoid doxxing, credential discovery, bypassing access controls, or harassment.",
			"For every material claim in a final report, include the supporting evidence ID.",
		].join("\n"),
	}));
}
