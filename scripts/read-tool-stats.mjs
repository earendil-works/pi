#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const DEFAULT_SESSIONS_DIR = path.join(homedir(), ".pi/agent/sessions");
const DEFAULT_ACTIVE_READ_TOOL_PATH = path.join(process.cwd(), "packages/coding-agent/src/core/tools/read.ts");
const DEFAULT_TOP = 20;
const CHART_WIDTH = 40;
const REPORT_TIME_ZONE = "Europe/Berlin";

function parseArgs(argv) {
	const options = {
		sessionsDir: DEFAULT_SESSIONS_DIR,
		json: false,
		text: false,
		includeRecords: false,
		modelFilter: undefined,
		top: DEFAULT_TOP,
		help: false,
		allSessions: false,
		since: undefined,
		autoSincePath: DEFAULT_ACTIVE_READ_TOOL_PATH,
		bucket: "week",
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--text") options.text = true;
		else if (arg === "--include-records") options.includeRecords = true;
		else if (arg === "--model") options.modelFilter = argv[++i];
		else if (arg === "--top") {
			const value = Number.parseInt(argv[++i] ?? "", 10);
			if (!Number.isFinite(value) || value <= 0) throw new Error("--top must be a positive integer");
			options.top = value;
		} else if (arg === "--sessions-dir") options.sessionsDir = argv[++i];
		else if (arg === "--all-sessions") options.allSessions = true;
		else if (arg === "--since") options.since = argv[++i];
		else if (arg === "--auto-since-path") options.autoSincePath = argv[++i];
		else if (arg === "--bucket") {
			const value = argv[++i];
			if (value !== "day" && value !== "week") throw new Error("--bucket must be day or week");
			options.bucket = value;
		} else throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

function printHelp() {
	console.log(`Usage: node scripts/read-tool-stats.mjs [options]

Options:
  --sessions-dir <path>  Sessions directory (default: ~/.pi/agent/sessions)
  --model <substring>    Filter provider/model by substring
  --top <n>              Number of examples to show (default: ${DEFAULT_TOP})
  --since <iso>          Only scan session files created at or after this ISO time
  --all-sessions         Disable the automatic since filter
  --auto-since-path <p>  Use birth time of this file for the automatic since filter
  --bucket <day|week>    Time bucket for trend chart (default: week)
  --json                 Print JSON summary instead of HTML report
  --text                 Print plain text report instead of HTML
  --include-records      Include raw records in JSON output
  -h, --help             Show this help
`);
}

function parseSessionFileTimestamp(sessionFile) {
	const base = path.basename(sessionFile);
	const rawTimestamp = base.split("_")[0];
	if (!rawTimestamp) return null;
	const isoTimestamp = rawTimestamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
	const ms = Date.parse(isoTimestamp);
	return Number.isFinite(ms) ? ms : null;
}

function formatIso(ms) {
	return new Date(ms).toISOString();
}

function getTimeZoneParts(ms) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: REPORT_TIME_ZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		hourCycle: "h23",
		weekday: "short",
	}).formatToParts(new Date(ms));
	return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function formatDay(ms) {
	const parts = getTimeZoneParts(ms);
	return `${parts.year}-${parts.month}-${parts.day}`;
}

function startOfReportTimeZoneWeek(ms) {
	const parts = getTimeZoneParts(ms);
	const dayIndex = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday ?? "Mon");
	const localMidnightAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
	return localMidnightAsUtc - Math.max(dayIndex, 0) * 24 * 60 * 60 * 1000;
}

function getTimeBucket(ms, bucket) {
	if (!Number.isFinite(ms)) return "[unknown]";
	if (bucket === "day") return formatDay(ms);
	return formatDay(startOfReportTimeZoneWeek(ms));
}

function getHourOfDayBucket(ms) {
	if (!Number.isFinite(ms)) return "[unknown]";
	return `${getTimeZoneParts(ms).hour}:00`;
}

async function resolveAutoSinceMs(options) {
	if (options.allSessions) return null;
	if (options.since) {
		const ms = Date.parse(options.since);
		if (!Number.isFinite(ms)) throw new Error(`Invalid --since value: ${options.since}`);
		return { ms, source: `--since ${options.since}` };
	}
	if (!options.autoSincePath) return null;
	try {
		const stats = await fs.stat(options.autoSincePath);
		const ms = Number.isFinite(stats.birthtimeMs) && stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs;
		return Number.isFinite(ms) && ms > 0 ? { ms, source: `birth time of ${options.autoSincePath}` } : null;
	} catch {
		return null;
	}
}

async function* walkJsonlFiles(dir) {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* walkJsonlFiles(fullPath);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield fullPath;
	}
}

function formatInt(value) {
	return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(part, total) {
	return total === 0 ? "n/a" : `${((part / total) * 100).toFixed(1)}%`;
}

function formatRate(value) {
	return Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

function median(numbers) {
	const finite = numbers.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
	if (finite.length === 0) return null;
	const middle = Math.floor(finite.length / 2);
	return finite.length % 2 === 0 ? (finite[middle - 1] + finite[middle]) / 2 : finite[middle];
}

function bar(part, total) {
	const filled = total === 0 ? 0 : Math.round((part / total) * CHART_WIDTH);
	return `${"█".repeat(filled)}${"░".repeat(CHART_WIDTH - filled)}`;
}

function extractTextContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function classifyRead(args) {
	const normalizedArgs = args && typeof args === "object" ? args : {};
	const hasOffset = Object.hasOwn(normalizedArgs, "offset") && normalizedArgs.offset !== undefined && normalizedArgs.offset !== null;
	const hasLimit = Object.hasOwn(normalizedArgs, "limit") && normalizedArgs.limit !== undefined && normalizedArgs.limit !== null;
	return {
		path: typeof normalizedArgs.path === "string" ? normalizedArgs.path : "",
		offset: hasOffset ? normalizedArgs.offset : null,
		limit: hasLimit ? normalizedArgs.limit : null,
		mode: hasOffset || hasLimit ? "partial" : "full",
	};
}

function summarizeTimeBuckets(records, bucket) {
	return summarizeGroups(records, (record) => getTimeBucket(record.timestampMs, bucket)).sort((a, b) => a.key.localeCompare(b.key));
}

function summarizeNormalizedTimeBuckets(records, bucket) {
	return summarizeNormalizedTimeBucketsByKey(records, (record) => getTimeBucket(record.timestampMs, bucket));
}

function summarizeNormalizedTimeBucketsByKey(records, keyFn) {
	const bucketGroups = new Map();
	for (const record of records) {
		const bucketKey = keyFn(record);
		if (!bucketGroups.has(bucketKey)) bucketGroups.set(bucketKey, []);
		bucketGroups.get(bucketKey).push(record);
	}

	return [...bucketGroups.entries()]
		.map(([key, bucketRecords]) => {
			const sessionGroups = new Map();
			for (const record of bucketRecords) {
				if (!sessionGroups.has(record.sessionFile)) sessionGroups.set(record.sessionFile, []);
				sessionGroups.get(record.sessionFile).push(record);
			}
			const sessions = [...sessionGroups.values()].map((sessionRecords) => {
				const full = sessionRecords.filter((record) => record.mode === "full").length;
				const partial = sessionRecords.length - full;
				return { reads: sessionRecords.length, full, partial, partialRate: sessionRecords.length === 0 ? null : partial / sessionRecords.length };
			});
			const reads = bucketRecords.length;
			const full = bucketRecords.filter((record) => record.mode === "full").length;
			const partial = reads - full;
			const sessionCount = sessions.length;
			const medianSessionPartialRate = median(sessions.map((session) => session.partialRate));
			return {
				key,
				sessions: sessionCount,
				reads,
				full,
				partial,
				readsPerSession: sessionCount === 0 ? null : reads / sessionCount,
				fullPerSession: sessionCount === 0 ? null : full / sessionCount,
				partialPerSession: sessionCount === 0 ? null : partial / sessionCount,
				medianSessionPartialRate,
			};
		})
		.sort((a, b) => a.key.localeCompare(b.key));
}

function summarizeGroups(records, keyFn) {
	const groups = new Map();
	for (const record of records) {
		const key = keyFn(record);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(record);
	}
	return [...groups.entries()]
		.map(([key, group]) => {
			const full = group.filter((record) => record.mode === "full").length;
			const partial = group.length - full;
			const assistantMessages = new Set(group.map((record) => `${record.sessionFile}::${record.assistantEntryId}`)).size;
			return { key, reads: group.length, assistantMessages, full, partial, fullRate: group.length === 0 ? null : full / group.length, partialRate: group.length === 0 ? null : partial / group.length };
		})
		.sort((a, b) => b.reads - a.reads || a.key.localeCompare(b.key));
}

function buildSummary(records, meta, options) {
	const full = records.filter((record) => record.mode === "full").length;
	const partial = records.length - full;
	const providerStats = summarizeGroups(records, (record) => record.providerModel);
	const timeStats = summarizeTimeBuckets(records, options.bucket);
	const normalizedTimeStats = summarizeNormalizedTimeBuckets(records, options.bucket);
	const timeOfDayStats = summarizeGroups(records, (record) => getHourOfDayBucket(record.timestampMs)).sort((a, b) => a.key.localeCompare(b.key));
	const normalizedTimeOfDayStats = summarizeNormalizedTimeBucketsByKey(records, (record) => getHourOfDayBucket(record.timestampMs));
	const timeStatsByProvider = providerStats.map((provider) => ({
		providerModel: provider.key,
		...provider,
		timeStats: summarizeTimeBuckets(
			records.filter((record) => record.providerModel === provider.key),
			options.bucket
		),
		normalizedTimeStats: summarizeNormalizedTimeBuckets(
			records.filter((record) => record.providerModel === provider.key),
			options.bucket
		),
		timeOfDayStats: summarizeGroups(
			records.filter((record) => record.providerModel === provider.key),
			(record) => getHourOfDayBucket(record.timestampMs)
		).sort((a, b) => a.key.localeCompare(b.key)),
		normalizedTimeOfDayStats: summarizeNormalizedTimeBucketsByKey(
			records.filter((record) => record.providerModel === provider.key),
			(record) => getHourOfDayBucket(record.timestampMs)
		),
	}));
	return {
		filters: { model: options.modelFilter ?? null, bucket: options.bucket },
		scan: {
			sessionsDir: meta.sessionsDir,
			sessionFilesScanned: meta.sessionFilesScanned,
			sessionFilesIncluded: meta.sessionFilesIncluded,
			sessionFilesSkippedOlderThanSince: meta.sessionFilesSkippedOlderThanSince,
			sessionFilesWithReadCalls: meta.sessionFilesWithReadCalls,
			since: meta.since ? { ms: meta.since.ms, iso: formatIso(meta.since.ms), source: meta.since.source } : null,
			malformedLines: meta.malformedLines,
		},
		counts: {
			assistantMessagesWithReadCalls: new Set(records.map((record) => `${record.sessionFile}::${record.assistantEntryId}`)).size,
			totalReadCalls: records.length,
			full,
			partial,
			fullRate: records.length === 0 ? null : full / records.length,
			partialRate: records.length === 0 ? null : partial / records.length,
		},
		providerStats,
		timeStats,
		normalizedTimeStats,
		timeOfDayStats,
		normalizedTimeOfDayStats,
		timeStatsByProvider,
		examples: records.slice(0, options.top),
	};
}

function buildHumanReport(summary) {
	const lines = [];
	const originalLog = console.log;
	console.log = (line = "") => lines.push(String(line));
	try {
		printHumanReport(summary);
	} finally {
		console.log = originalLog;
	}
	return lines.join("\n") + "\n";
}

function escapeHtml(text) {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function printHtmlReport(summary) {
	const text = buildHumanReport(summary);
	console.log(`<!doctype html>
<meta charset="utf-8">
<title>Read tool stats</title>
<style>
body { margin: 24px; background: #fff; color: #111; }
pre { font: 13px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }
</style>
<pre>${escapeHtml(text)}</pre>`);
}

function printHumanReport(summary) {
	const { scan, counts, timeStats, normalizedTimeStats, timeOfDayStats, normalizedTimeOfDayStats, timeStatsByProvider, filters } = summary;
	console.log(`Scanned ${formatInt(scan.sessionFilesIncluded)} session files in ${scan.sessionsDir}`);
	console.log(`Report timezone: ${REPORT_TIME_ZONE} (CET/CEST)`);
	if (scan.since) {
		console.log(`Session filter: files created at or after ${scan.since.iso} (${scan.since.source})`);
		console.log(`Skipped older session files: ${formatInt(scan.sessionFilesSkippedOlderThanSince)} of ${formatInt(scan.sessionFilesScanned)}`);
	}
	console.log(`Found ${formatInt(counts.totalReadCalls)} read tool calls in ${formatInt(counts.assistantMessagesWithReadCalls)} assistant messages`);
	if (filters.model) console.log(`Filters: model contains "${filters.model}"`);

	console.log("\nFull vs partial reads");
	console.log(`  full:    ${formatInt(counts.full).padStart(8)}  ${formatPercent(counts.full, counts.totalReadCalls).padStart(6)}  ${bar(counts.full, counts.totalReadCalls)}`);
	console.log(`  partial: ${formatInt(counts.partial).padStart(8)}  ${formatPercent(counts.partial, counts.totalReadCalls).padStart(6)}  ${bar(counts.partial, counts.totalReadCalls)}`);

	console.log(`\nBy ${filters.bucket}`);
	for (const group of timeStats) {
		console.log(
			`  ${group.key} reads=${formatInt(group.reads).padStart(5)} full=${formatPercent(group.full, group.reads).padStart(6)} partial=${formatPercent(group.partial, group.reads).padStart(6)} ${bar(group.partial, group.reads)}`
		);
	}

	console.log("\nBy time of day");
	for (const group of timeOfDayStats) {
		console.log(
			`  ${group.key} reads=${formatInt(group.reads).padStart(5)} full=${formatPercent(group.full, group.reads).padStart(6)} partial=${formatPercent(group.partial, group.reads).padStart(6)} ${bar(group.partial, group.reads)}`
		);
	}

	console.log("\nBy time of day, session-normalized");
	for (const group of normalizedTimeOfDayStats) {
		console.log(
			`  ${group.key} sessions=${formatInt(group.sessions).padStart(4)} reads/session=${formatRate(group.readsPerSession).padStart(5)} full/session=${formatRate(group.fullPerSession).padStart(5)} partial/session=${formatRate(group.partialPerSession).padStart(5)} medianSessionPartial=${group.medianSessionPartialRate === null ? "n/a" : formatPercent(group.medianSessionPartialRate, 1).padStart(6)} ${bar(group.medianSessionPartialRate ?? 0, 1)}`
		);
	}

	console.log(`\nBy ${filters.bucket}, session-normalized`);
	for (const group of normalizedTimeStats) {
		console.log(
			`  ${group.key} sessions=${formatInt(group.sessions).padStart(4)} reads/session=${formatRate(group.readsPerSession).padStart(5)} full/session=${formatRate(group.fullPerSession).padStart(5)} partial/session=${formatRate(group.partialPerSession).padStart(5)} medianSessionPartial=${group.medianSessionPartialRate === null ? "n/a" : formatPercent(group.medianSessionPartialRate, 1).padStart(6)} ${bar(group.medianSessionPartialRate ?? 0, 1)}`
		);
	}

	console.log(`\nBy provider/model, then by ${filters.bucket}`);
	for (const group of timeStatsByProvider) {
		console.log(`\n${group.providerModel}`);
		console.log(`  total reads=${formatInt(group.reads)} assistantMessages=${formatInt(group.assistantMessages)}`);
		console.log(`  total full    ${formatInt(group.full).padStart(8)} ${formatPercent(group.full, group.reads).padStart(6)} ${bar(group.full, group.reads)}`);
		console.log(`  total partial ${formatInt(group.partial).padStart(8)} ${formatPercent(group.partial, group.reads).padStart(6)} ${bar(group.partial, group.reads)}`);
		console.log(`  By ${filters.bucket}`);
		for (const bucket of group.timeStats) {
			console.log(
				`    ${bucket.key} reads=${formatInt(bucket.reads).padStart(5)} full=${formatPercent(bucket.full, bucket.reads).padStart(6)} partial=${formatPercent(bucket.partial, bucket.reads).padStart(6)} ${bar(bucket.partial, bucket.reads)}`
			);
		}
		console.log(`  By ${filters.bucket}, session-normalized`);
		for (const bucket of group.normalizedTimeStats) {
			console.log(
				`    ${bucket.key} sessions=${formatInt(bucket.sessions).padStart(4)} reads/session=${formatRate(bucket.readsPerSession).padStart(5)} full/session=${formatRate(bucket.fullPerSession).padStart(5)} partial/session=${formatRate(bucket.partialPerSession).padStart(5)} medianSessionPartial=${bucket.medianSessionPartialRate === null ? "n/a" : formatPercent(bucket.medianSessionPartialRate, 1).padStart(6)} ${bar(bucket.medianSessionPartialRate ?? 0, 1)}`
			);
		}
		console.log("  By time of day");
		for (const bucket of group.timeOfDayStats) {
			console.log(
				`    ${bucket.key} reads=${formatInt(bucket.reads).padStart(5)} full=${formatPercent(bucket.full, bucket.reads).padStart(6)} partial=${formatPercent(bucket.partial, bucket.reads).padStart(6)} ${bar(bucket.partial, bucket.reads)}`
			);
		}
		console.log("  By time of day, session-normalized");
		for (const bucket of group.normalizedTimeOfDayStats) {
			console.log(
				`    ${bucket.key} sessions=${formatInt(bucket.sessions).padStart(4)} reads/session=${formatRate(bucket.readsPerSession).padStart(5)} full/session=${formatRate(bucket.fullPerSession).padStart(5)} partial/session=${formatRate(bucket.partialPerSession).padStart(5)} medianSessionPartial=${bucket.medianSessionPartialRate === null ? "n/a" : formatPercent(bucket.medianSessionPartialRate, 1).padStart(6)} ${bar(bucket.medianSessionPartialRate ?? 0, 1)}`
			);
		}
	}

	if (scan.malformedLines > 0) {
		console.log("\nParser notes");
		console.log(`  malformed lines skipped: ${formatInt(scan.malformedLines)}`);
	}
}

async function scanSessions(sessionsDir, since) {
	const records = [];
	const meta = { sessionsDir, sessionFilesScanned: 0, sessionFilesIncluded: 0, sessionFilesSkippedOlderThanSince: 0, sessionFilesWithReadCalls: 0, since, malformedLines: 0 };

	for await (const sessionFile of walkJsonlFiles(sessionsDir)) {
		meta.sessionFilesScanned++;
		const sessionTimestampMs = parseSessionFileTimestamp(sessionFile);
		if (since && sessionTimestampMs !== null && sessionTimestampMs < since.ms) {
			meta.sessionFilesSkippedOlderThanSince++;
			continue;
		}
		meta.sessionFilesIncluded++;
		let fileHadReadCall = false;
		const input = createReadStream(sessionFile, { encoding: "utf8" });
		const rl = createInterface({ input, crlfDelay: Infinity });

		for await (const line of rl) {
			if (!line.trim()) continue;
			let entry;
			try {
				entry = JSON.parse(line);
			} catch {
				meta.malformedLines++;
				continue;
			}
			if (entry?.type !== "message" || !entry.message) continue;
			const message = entry.message;
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (block?.type !== "toolCall" || block.name !== "read") continue;
				fileHadReadCall = true;
				records.push({
					sessionFile,
					assistantEntryId: entry.id,
					toolCallId: typeof block.id === "string" ? block.id : "",
					timestamp: entry.timestamp,
					timestampMs: Date.parse(entry.timestamp) || sessionTimestampMs || 0,
					api: typeof message.api === "string" ? message.api : null,
					provider: typeof message.provider === "string" ? message.provider : "[unknown]",
					model: typeof message.model === "string" ? message.model : "[unknown]",
					providerModel: `${typeof message.provider === "string" ? message.provider : "[unknown]"}/${typeof message.model === "string" ? message.model : "[unknown]"}`,
					...classifyRead(block.arguments),
				});
			}
		}
		if (fileHadReadCall) meta.sessionFilesWithReadCalls++;
	}
	return { records, meta };
}

function applyFilters(records, options) {
	return records.filter((record) => !options.modelFilter || record.providerModel.toLowerCase().includes(options.modelFilter.toLowerCase()));
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}
	const sessionsDir = path.resolve(options.sessionsDir);
	await fs.access(sessionsDir);
	const since = await resolveAutoSinceMs(options);
	const { records, meta } = await scanSessions(sessionsDir, since);
	const filteredRecords = applyFilters(records, options);
	const summary = buildSummary(filteredRecords, meta, options);
	if (options.json) {
		console.log(JSON.stringify(options.includeRecords ? { summary, records: filteredRecords } : { summary }, null, 2));
		return;
	}
	if (options.text) {
		printHumanReport(summary);
		return;
	}
	printHtmlReport(summary);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
