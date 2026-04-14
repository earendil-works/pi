/**
 * Memory Hooks Extension
 *
 * Two hooks for Neo4j-backed project memory:
 *
 * 1. session_shutdown: Analyzes the session for save-worthy context (code changes,
 *    bug fixes, decisions) and writes a Memory node into the palace graph.
 *
 * 2. before_agent_start (first message only): Queries Neo4j for rooms matching
 *    keywords in the user's prompt and injects recalled memories into the system
 *    prompt. Fires once per new session, not on every message.
 *
 * Neo4j connection uses the HTTP transaction API (default port 7474).
 * Set NEO4J_HTTP_URL, NEO4J_USERNAME, NEO4J_PASSWORD env vars to override defaults.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const NEO4J_URL = process.env.NEO4J_HTTP_URL || "http://localhost:7474";
const NEO4J_USER = process.env.NEO4J_USERNAME || "neo4j";
const NEO4J_PASS = process.env.NEO4J_PASSWORD || "password";

const STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"can",
	"shall",
	"must",
	"need",
	"to",
	"of",
	"in",
	"for",
	"on",
	"with",
	"at",
	"by",
	"from",
	"as",
	"into",
	"through",
	"then",
	"here",
	"there",
	"when",
	"where",
	"why",
	"how",
	"all",
	"each",
	"both",
	"more",
	"most",
	"other",
	"some",
	"no",
	"not",
	"only",
	"so",
	"than",
	"too",
	"very",
	"just",
	"and",
	"or",
	"if",
	"but",
	"about",
	"this",
	"that",
	"these",
	"those",
	"i",
	"me",
	"my",
	"we",
	"our",
	"you",
	"your",
	"it",
	"its",
	"they",
	"them",
	"their",
	"what",
	"which",
	"who",
	"up",
	"also",
	"let",
	"make",
	"like",
	"get",
	"got",
	"use",
	"using",
	"used",
	"please",
	"help",
	"want",
	"check",
	"look",
	"see",
	"try",
	"think",
]);

type TaskType = "bug-fix" | "feature" | "refactor" | "config" | "exploration" | "unknown";

interface SessionAnalysis {
	isWorthSaving: boolean;
	topic: string;
	hall: string;
	summary: string;
	filesChanged: string[];
	taskType: TaskType;
}

interface CypherResponse {
	columns: string[];
	rows: unknown[][];
}

async function runCypher(
	exec: ExtensionAPI["exec"],
	query: string,
	params: Record<string, unknown> = {},
): Promise<CypherResponse> {
	const body = JSON.stringify({
		statements: [{ statement: query, parameters: params }],
	});

	const { stdout, code } = await exec("curl", [
		"-s",
		"-f",
		"-X",
		"POST",
		`${NEO4J_URL}/db/neo4j/tx/commit`,
		"-H",
		"Content-Type: application/json",
		"-u",
		`${NEO4J_USER}:${NEO4J_PASS}`,
		"-d",
		body,
	]);

	if (code !== 0) return { columns: [], rows: [] };

	try {
		const parsed = JSON.parse(stdout);
		if (parsed.errors?.length > 0) return { columns: [], rows: [] };
		const result = parsed.results?.[0];
		if (!result) return { columns: [], rows: [] };
		return {
			columns: result.columns || [],
			rows: (result.data || []).map((d: { row: unknown[] }) => d.row),
		};
	} catch {
		return { columns: [], rows: [] };
	}
}

function extractKeywords(text: string): string[] {
	return [
		...new Set(
			text
				.toLowerCase()
				.replace(/[^a-z0-9_\-./]/g, " ")
				.split(/\s+/)
				.filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
		),
	].slice(0, 10);
}

function classifyTask(text: string): { type: TaskType; hall: string } {
	const lower = text.toLowerCase();
	if (/\b(bug|fix|broken|crash|error|regression|issue)\b/.test(lower)) {
		return { type: "bug-fix", hall: "hall_events" };
	}
	if (/\b(refactor|clean|rename|move|extract|simplify)\b/.test(lower)) {
		return { type: "refactor", hall: "hall_facts" };
	}
	if (/\b(config|setup|install|deploy|ci|cd)\b/.test(lower)) {
		return { type: "config", hall: "hall_facts" };
	}
	if (/\b(add|implement|create|build|feature|new|hook|extend)\b/.test(lower)) {
		return { type: "feature", hall: "hall_facts" };
	}
	return { type: "unknown", hall: "hall_events" };
}

function getTextFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(c: unknown): c is { type: "text"; text: string } =>
				typeof c === "object" && c !== null && (c as { type: string }).type === "text",
		)
		.map((c) => c.text)
		.join("\n");
}

function analyzeSession(entries: any[]): SessionAnalysis {
	const noSave: SessionAnalysis = {
		isWorthSaving: false,
		topic: "",
		hall: "hall_events",
		summary: "",
		filesChanged: [],
		taskType: "unknown",
	};

	let firstUserMessage = "";
	let lastAssistantMessage = "";
	const filesChanged = new Set<string>();
	let hasEdits = false;
	let toolCallCount = 0;

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg) continue;

		const text = getTextFromContent(msg.content);

		if (msg.role === "user" && !firstUserMessage) {
			firstUserMessage = text;
		}

		if (msg.role === "assistant") {
			lastAssistantMessage = text;
			if (Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (part.type === "toolCall") {
						toolCallCount++;
						if (part.name === "edit" || part.name === "write") {
							hasEdits = true;
							const fp = part.arguments?.file_path || part.arguments?.path;
							if (typeof fp === "string") filesChanged.add(fp);
						}
					}
				}
			}
		}
	}

	if (!hasEdits && toolCallCount < 5) return noSave;
	if (!firstUserMessage) return noSave;

	const { type: taskType, hall } = classifyTask(firstUserMessage);
	const topicWords = extractKeywords(firstUserMessage).slice(0, 4);
	const topic = topicWords.length > 0 ? `${taskType}-${topicWords.join("-")}` : `${taskType}-${Date.now()}`;

	const fileList = [...filesChanged].slice(0, 10);
	const parts = [`Task: ${firstUserMessage.slice(0, 200)}`];
	parts.push(`Type: ${taskType}`);
	if (fileList.length > 0) parts.push(`Files: ${fileList.join(", ")}`);
	if (lastAssistantMessage) {
		parts.push(`Outcome: ${lastAssistantMessage.slice(-300).trim()}`);
	}

	return {
		isWorthSaving: true,
		topic,
		hall,
		summary: parts.join("\n"),
		filesChanged: fileList,
		taskType,
	};
}

async function recallMemories(exec: ExtensionAPI["exec"], projectName: string, keywords: string[]): Promise<string> {
	const result = await runCypher(
		exec,
		`MATCH (r:Room)-[:HAS_DRAWER]->(d)
		 WHERE any(k IN $keywords WHERE toLower(r.name) CONTAINS k)
		 WITH r, collect(d.content)[0..3] AS contents
		 RETURN r.name AS topic, r.wing AS wing, r.hall AS hall, contents
		 ORDER BY CASE WHEN r.wing = $project THEN 0 ELSE 1 END
		 LIMIT 5`,
		{ keywords, project: projectName },
	);

	if (result.rows.length === 0) return "";

	const sections: string[] = [];
	for (const row of result.rows) {
		const [topic, wing, , contents] = row as [string, string, string, string[]];
		if (!contents || contents.length === 0) continue;
		sections.push(`### ${wing}/${topic}\n${contents.join("\n---\n")}`);
	}
	return sections.join("\n\n");
}

async function saveToNeo4j(
	exec: ExtensionAPI["exec"],
	projectName: string,
	analysis: SessionAnalysis,
): Promise<boolean> {
	const result = await runCypher(
		exec,
		`MERGE (w:Wing {name: $project})
		 ON CREATE SET w.type = 'project', w.createdAt = datetime()
		 MERGE (r:Room {name: $topic, wing: $project})
		 ON CREATE SET r.hall = $hall, r.drawerCount = 0, r.createdAt = datetime()
		 MERGE (w)-[:HAS_ROOM]->(r)
		 CREATE (m:Memory {
		   content: $content, topic: $topic, source: $project,
		   taskType: $taskType, createdAt: datetime()
		 })
		 MERGE (r)-[:HAS_DRAWER]->(m)
		 SET r.drawerCount = r.drawerCount + 1
		 WITH r
		 OPTIONAL MATCH (other:Room {name: r.name})
		 WHERE other.wing <> r.wing AND NOT (r)-[:TUNNEL]-(other)
		 FOREACH (o IN collect(other) | MERGE (r)-[:TUNNEL]->(o))
		 RETURN r.name AS room`,
		{
			project: projectName,
			topic: analysis.topic,
			hall: analysis.hall,
			content: analysis.summary,
			taskType: analysis.taskType,
		},
	);
	return result.rows.length > 0;
}

export default function (pi: ExtensionAPI) {
	let isFirstMessage = false;

	pi.on("session_start", (event) => {
		if (event.reason === "startup") {
			isFirstMessage = true;
		}
	});

	// Recall: inject related memories on first message of a new session
	pi.on("before_agent_start", async (event, ctx) => {
		if (!isFirstMessage) return;
		isFirstMessage = false;

		const prompt = event.prompt;
		if (!prompt.trim()) return;

		const projectName = path.basename(ctx.cwd);
		const keywords = extractKeywords(prompt);
		if (keywords.length === 0) return;

		try {
			const memories = await recallMemories(pi.exec, projectName, keywords);
			if (!memories.trim()) return;

			const count = memories.split("###").length - 1;
			ctx.ui.notify(`Recalled ${count} related memory room${count !== 1 ? "s" : ""}`, "info");
			return {
				systemPrompt: `${event.systemPrompt}\n\n## Recalled Project Memories (from Neo4j)\n${memories}`,
			};
		} catch {
			// Neo4j unavailable — skip silently
		}
	});

	// Save: analyze session and persist worthy context on shutdown
	pi.on("session_shutdown", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const projectName = path.basename(ctx.cwd);
		const analysis = analyzeSession(entries);
		if (!analysis.isWorthSaving) return;

		try {
			const saved = await saveToNeo4j(pi.exec, projectName, analysis);
			if (saved && ctx.hasUI) {
				ctx.ui.notify(`Saved memory: ${analysis.topic} [${analysis.hall}]`, "info");
			}
		} catch {
			// Neo4j unavailable — skip silently
		}
	});
}
