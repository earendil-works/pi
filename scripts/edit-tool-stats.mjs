#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const DEFAULT_SESSIONS_DIR = path.join(homedir(), ".pi/agent/sessions");
const DEFAULT_ACTIVE_EDIT_EXTENSION_PATH = path.join(homedir(), ".pi/agent/extensions/edit.ts");
const DEFAULT_TOP = 20;

function parseArgs(argv) {
	const options = {
		sessionsDir: DEFAULT_SESSIONS_DIR,
		json: false,
		includeRecords: false,
		failedOnly: false,
		modelFilter: undefined,
		extFilter: undefined,
		top: DEFAULT_TOP,
		help: false,
		allSessions: false,
		since: undefined,
		autoSincePath: DEFAULT_ACTIVE_EDIT_EXTENSION_PATH,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
		} else if (arg === "--json") {
			options.json = true;
		} else if (arg === "--include-records") {
			options.includeRecords = true;
		} else if (arg === "--failed-only") {
			options.failedOnly = true;
		} else if (arg === "--model") {
			options.modelFilter = argv[++i];
		} else if (arg === "--ext") {
			options.extFilter = argv[++i]?.toLowerCase();
		} else if (arg === "--top") {
			const value = Number.parseInt(argv[++i] ?? "", 10);
			if (!Number.isFinite(value) || value <= 0) {
				throw new Error("--top must be a positive integer");
			}
			options.top = value;
		} else if (arg === "--sessions-dir") {
			options.sessionsDir = argv[++i];
		} else if (arg === "--all-sessions") {
			options.allSessions = true;
		} else if (arg === "--since") {
			options.since = argv[++i];
		} else if (arg === "--auto-since-path") {
			options.autoSincePath = argv[++i];
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return options;
}

function printHelp() {
	console.log(`Usage: node scripts/edit-tool-stats.mjs [options]

Options:
  --sessions-dir <path>  Sessions directory (default: ~/.pi/agent/sessions)
  --model <substring>    Filter provider/model by substring
  --ext <extension>      Filter by file extension, e.g. .ts
  --failed-only          Include only failed edit calls
  --top <n>              Number of examples to show (default: ${DEFAULT_TOP})
  --since <iso>          Only scan session files created at or after this ISO time
  --all-sessions         Disable the automatic since filter
  --auto-since-path <p>  Use birth time of this file for the automatic since filter
  --json                 Print JSON summary instead of human report
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
	if (!Number.isFinite(ms)) return null;
	return ms;
}

function formatIso(ms) {
	return new Date(ms).toISOString();
}

async function resolveAutoSinceMs(options) {
	if (options.allSessions) return null;
	if (options.since) {
		const ms = Date.parse(options.since);
		if (!Number.isFinite(ms)) {
			throw new Error(`Invalid --since value: ${options.since}`);
		}
		return { ms, source: `--since ${options.since}` };
	}
	if (!options.autoSincePath) return null;
	try {
		const stats = await fs.stat(options.autoSincePath);
		const birthtimeMs = Number.isFinite(stats.birthtimeMs) && stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs;
		if (!Number.isFinite(birthtimeMs) || birthtimeMs <= 0) return null;
		return { ms: birthtimeMs, source: `birth time of ${options.autoSincePath}` };
	} catch {
		return null;
	}
}

async function* walkJsonlFiles(dir) {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	entries.sort((a, b) => a.name.localeCompare(b.name));

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkJsonlFiles(fullPath);
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			yield fullPath;
		}
	}
}

function getPathExtension(filePath) {
	if (typeof filePath !== "string" || filePath.length === 0) return "[unknown]";
	const ext = path.extname(filePath).toLowerCase();
	if (ext) return ext;
	const base = path.basename(filePath);
	if (base.startsWith(".") && !base.slice(1).includes(".")) return base.toLowerCase();
	return "[no_ext]";
}

function utf8Bytes(value) {
	return Buffer.byteLength(value ?? "", "utf8");
}

function longestCommonPrefixLength(a, b) {
	const max = Math.min(a.length, b.length);
	let index = 0;
	while (index < max && a[index] === b[index]) index++;
	return index;
}

function longestCommonSuffixLength(a, b) {
	const max = Math.min(a.length, b.length);
	let index = 0;
	while (index < max && a[a.length - 1 - index] === b[b.length - 1 - index]) index++;
	return index;
}

function analyzeReplacement(oldText, newText) {
	const prefixChars = longestCommonPrefixLength(oldText, newText);
	const oldRemainder = oldText.slice(prefixChars);
	const newRemainder = newText.slice(prefixChars);
	const suffixChars = longestCommonSuffixLength(oldRemainder, newRemainder);
	const oldCore = suffixChars > 0 ? oldRemainder.slice(0, -suffixChars) : oldRemainder;
	const newCore = suffixChars > 0 ? newRemainder.slice(0, -suffixChars) : newRemainder;
	const prefix = oldText.slice(0, prefixChars);
	const suffix = suffixChars > 0 ? oldRemainder.slice(-suffixChars) : "";

	const oldBytes = utf8Bytes(oldText);
	const newBytes = utf8Bytes(newText);
	const sharedPrefixBytes = utf8Bytes(prefix);
	const sharedSuffixBytes = utf8Bytes(suffix);
	const sharedContextBytes = sharedPrefixBytes + sharedSuffixBytes;
	const coreOldBytes = utf8Bytes(oldCore);
	const coreNewBytes = utf8Bytes(newCore);
	const coreBytes = coreOldBytes + coreNewBytes;
	const totalEditBytes = oldBytes + newBytes;
	const wrapperPayloadBytes = totalEditBytes - coreBytes;
	const inflationRatio = coreBytes === 0 ? null : totalEditBytes / coreBytes;

	return {
		oldBytes,
		newBytes,
		totalEditBytes,
		sharedPrefixBytes,
		sharedSuffixBytes,
		sharedContextBytes,
		coreOldBytes,
		coreNewBytes,
		coreBytes,
		wrapperPayloadBytes,
		inflationRatio,
		noCoreChange: coreBytes === 0,
	};
}

function median(numbers) {
	return quantile(numbers, 0.5);
}

function quantile(numbers, q) {
	const finite = numbers.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
	if (finite.length === 0) return null;
	if (finite.length === 1) return finite[0];
	const position = (finite.length - 1) * q;
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	if (lower === upper) return finite[lower];
	const weight = position - lower;
	return finite[lower] * (1 - weight) + finite[upper] * weight;
}

function formatInt(value) {
	return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(part, total) {
	if (total === 0) return "n/a";
	return `${((part / total) * 100).toFixed(1)}%`;
}

function formatRatio(value) {
	if (value === null) return "no-core-change";
	if (!Number.isFinite(value)) return "∞";
	if (value >= 100) return `${value.toFixed(0)}x`;
	if (value >= 10) return `${value.toFixed(1)}x`;
	return `${value.toFixed(2)}x`;
}

function formatBytes(value) {
	if (value < 1024) return `${value}B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(value >= 10 * 1024 ? 0 : 1)}KB`;
	return `${(value / (1024 * 1024)).toFixed(1)}MB`;
}

function extractTextContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function classifyErrorKind(text, isError, matchedResult) {
	if (!matchedResult) return "missing_result";
	if (!isError) return null;
	const normalized = text.toLowerCase();
	if (normalized.includes("file not found")) return "file_not_found";
	if (normalized.includes("could not find the exact text")) return "not_found_exact_text";
	if (normalized.includes("found multiple occurrences") || /^found \d+ occurrences/m.test(normalized)) {
		return "multiple_occurrences";
	}
	if (normalized.includes("no changes made")) return "no_changes_made";
	if (normalized.includes("input is invalid")) return "invalid_input";
	if (normalized.includes("must not overlap")) return "overlapping_edits";
	if (normalized.includes("aborted")) return "aborted";
	return "other";
}

function getArgStyle(args) {
	const hasEdits = Array.isArray(args?.edits);
	const hasOldText = typeof args?.oldText === "string" || typeof args?.newText === "string";
	const hasOldString = typeof args?.old_string === "string" || typeof args?.new_string === "string";
	if (hasEdits) return "edits";
	if (hasOldText && hasOldString) return "mixed";
	if (hasOldText) return "oldText/newText";
	if (hasOldString) return "old_string/new_string";
	return "unknown";
}

function analyzeToolArguments(args) {
	const normalizedArgs = args && typeof args === "object" ? args : {};
	const filePath = typeof normalizedArgs.path === "string" ? normalizedArgs.path : "";
	const extension = getPathExtension(filePath);
	const argStyle = getArgStyle(normalizedArgs);

	if (Array.isArray(normalizedArgs.edits)) {
		const perEdit = normalizedArgs.edits.map((edit) =>
			analyzeReplacement(typeof edit?.oldText === "string" ? edit.oldText : "", typeof edit?.newText === "string" ? edit.newText : "")
		);
		const inflations = perEdit.map((edit) => edit.inflationRatio).filter((value) => value !== null);
		const totals = perEdit.reduce(
			(acc, edit) => ({
				oldBytes: acc.oldBytes + edit.oldBytes,
				newBytes: acc.newBytes + edit.newBytes,
				totalEditBytes: acc.totalEditBytes + edit.totalEditBytes,
				sharedPrefixBytes: acc.sharedPrefixBytes + edit.sharedPrefixBytes,
				sharedSuffixBytes: acc.sharedSuffixBytes + edit.sharedSuffixBytes,
				sharedContextBytes: acc.sharedContextBytes + edit.sharedContextBytes,
				coreOldBytes: acc.coreOldBytes + edit.coreOldBytes,
				coreNewBytes: acc.coreNewBytes + edit.coreNewBytes,
				coreBytes: acc.coreBytes + edit.coreBytes,
				wrapperPayloadBytes: acc.wrapperPayloadBytes + edit.wrapperPayloadBytes,
				noCoreChangeCount: acc.noCoreChangeCount + (edit.noCoreChange ? 1 : 0),
			}),
			{
				oldBytes: 0,
				newBytes: 0,
				totalEditBytes: 0,
				sharedPrefixBytes: 0,
				sharedSuffixBytes: 0,
				sharedContextBytes: 0,
				coreOldBytes: 0,
				coreNewBytes: 0,
				coreBytes: 0,
				wrapperPayloadBytes: 0,
				noCoreChangeCount: 0,
			}
		);
		return {
			path: filePath,
			extension,
			mode: "multi",
			argStyle,
			editsCount: normalizedArgs.edits.length,
			...totals,
			inflationRatio: totals.coreBytes === 0 ? null : totals.totalEditBytes / totals.coreBytes,
			medianEditInflationRatio: median(inflations),
			maxEditInflationRatio: inflations.length > 0 ? Math.max(...inflations) : null,
			perEdit,
		};
	}

	const oldText = typeof normalizedArgs.oldText === "string" ? normalizedArgs.oldText : typeof normalizedArgs.old_string === "string" ? normalizedArgs.old_string : "";
	const newText = typeof normalizedArgs.newText === "string" ? normalizedArgs.newText : typeof normalizedArgs.new_string === "string" ? normalizedArgs.new_string : "";
	const replacement = analyzeReplacement(oldText, newText);
	return {
		path: filePath,
		extension,
		mode: "single",
		argStyle,
		editsCount: 1,
		...replacement,
		medianEditInflationRatio: replacement.inflationRatio,
		maxEditInflationRatio: replacement.inflationRatio,
		perEdit: [replacement],
	};
}

function groupCounts(records, keyFn) {
	const counts = new Map();
	for (const record of records) {
		const key = keyFn(record);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

function collectInflations(records) {
	return records.map((record) => record.inflationRatio).filter((value) => value !== null);
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
			const resolved = group.filter((record) => record.success !== null);
			const success = resolved.filter((record) => record.success).length;
			const failed = resolved.filter((record) => record.success === false).length;
			const multi = group.filter((record) => record.mode === "multi").length;
			const inflations = collectInflations(group);
			return {
				key,
				calls: group.length,
				resolved: resolved.length,
				success,
				failed,
				unresolved: group.length - resolved.length,
				multi,
				multiRate: group.length === 0 ? null : multi / group.length,
				successRate: resolved.length === 0 ? null : success / resolved.length,
				medianInflation: quantile(inflations, 0.5),
				p95Inflation: quantile(inflations, 0.95),
			};
		})
		.sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key));
}

function buildSameFileClusterStats(records) {
	const groups = new Map();
	for (const record of records) {
		const key = `${record.sessionFile}::${record.assistantEntryId}::${record.path}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(record);
	}

	const clusters = [...groups.values()].filter((group) => group.length >= 2);
	const assistantMessagesWithCluster = new Set(clusters.map((group) => `${group[0].sessionFile}::${group[0].assistantEntryId}`));
	const assistantMessagesWithMultiEdit = new Set(
		records
			.filter((record) => record.mode === "multi" && record.editsCount > 1)
			.map((record) => `${record.sessionFile}::${record.assistantEntryId}`)
	);
	const callsInsideClusters = clusters.reduce((sum, group) => sum + group.length, 0);

	return {
		clustersCount: clusters.length,
		assistantMessagesWithCluster: assistantMessagesWithCluster.size,
		assistantMessagesWithMultiEdit: assistantMessagesWithMultiEdit.size,
		callsInsideClusters,
		averageCallsPerCluster: clusters.length === 0 ? null : callsInsideClusters / clusters.length,
		ratioClusterAssistantMessagesToMultiEditAssistantMessages:
			assistantMessagesWithMultiEdit.size === 0 ? null : assistantMessagesWithCluster.size / assistantMessagesWithMultiEdit.size,
	};
}

function buildInflationBuckets(records) {
	const buckets = [
		{ key: "no_core_change", label: "no-core-change", test: (record) => record.inflationRatio === null },
		{ key: "lt4", label: "<4x", test: (record) => record.inflationRatio !== null && record.inflationRatio < 4 },
		{ key: "4to10", label: "4-10x", test: (record) => record.inflationRatio !== null && record.inflationRatio >= 4 && record.inflationRatio < 10 },
		{ key: "10to25", label: "10-25x", test: (record) => record.inflationRatio !== null && record.inflationRatio >= 10 && record.inflationRatio < 25 },
		{ key: "gte25", label: "25x+", test: (record) => record.inflationRatio !== null && record.inflationRatio >= 25 },
	];

	return buckets.map((bucket) => {
		const bucketRecords = records.filter(bucket.test);
		const resolved = bucketRecords.filter((record) => record.success !== null);
		const failed = resolved.filter((record) => record.success === false).length;
		return {
			key: bucket.key,
			label: bucket.label,
			count: bucketRecords.length,
			resolved: resolved.length,
			failed,
			failureRate: resolved.length === 0 ? null : failed / resolved.length,
		};
	});
}

function buildHugeReplacementStats(records) {
	const thresholds = [1024, 4096, 16384, 65536];
	return thresholds.map((threshold) => ({
		threshold,
		count: records.filter((record) => record.totalEditBytes > threshold).length,
	}));
}

function buildWorstExamples(records, top) {
	const scored = [...records].sort((a, b) => {
		const aScore = a.inflationRatio === null ? Number.POSITIVE_INFINITY : a.inflationRatio;
		const bScore = b.inflationRatio === null ? Number.POSITIVE_INFINITY : b.inflationRatio;
		if (aScore !== bScore) return bScore - aScore;
		if (a.totalEditBytes !== b.totalEditBytes) return b.totalEditBytes - a.totalEditBytes;
		return a.path.localeCompare(b.path);
	});

	return scored.slice(0, top).map((record) => ({
		providerModel: record.providerModel,
		extension: record.extension,
		path: record.path,
		inflationRatio: record.inflationRatio,
		totalEditBytes: record.totalEditBytes,
		coreBytes: record.coreBytes,
		mode: record.mode,
		editsCount: record.editsCount,
		failed: record.success === false,
		errorKind: record.errorKind,
		sessionFile: record.sessionFile,
	}));
}

function buildSummary(records, meta, options) {
	const uniqueAssistantMessages = new Set(records.map((record) => `${record.sessionFile}::${record.assistantEntryId}`)).size;
	const resolved = records.filter((record) => record.success !== null);
	const success = resolved.filter((record) => record.success).length;
	const failed = resolved.filter((record) => record.success === false).length;
	const unresolved = records.length - resolved.length;
	const single = records.filter((record) => record.mode === "single").length;
	const multi = records.filter((record) => record.mode === "multi").length;
	const modeStats = ["single", "multi"].map((mode) => {
		const modeRecords = records.filter((record) => record.mode === mode);
		const modeResolved = modeRecords.filter((record) => record.success !== null);
		const modeSuccess = modeResolved.filter((record) => record.success).length;
		const modeFailed = modeResolved.filter((record) => record.success === false).length;
		return {
			mode,
			calls: modeRecords.length,
			resolved: modeResolved.length,
			success: modeSuccess,
			failed: modeFailed,
			unresolved: modeRecords.length - modeResolved.length,
			successRate: modeResolved.length === 0 ? null : modeSuccess / modeResolved.length,
			failureRate: modeResolved.length === 0 ? null : modeFailed / modeResolved.length,
		};
	});
	const multiEditLengthBuckets = [
		{ key: "1", label: "edits.length === 1", test: (record) => record.mode === "multi" && record.editsCount === 1 },
		{ key: "2", label: "edits.length === 2", test: (record) => record.mode === "multi" && record.editsCount === 2 },
		{ key: "3plus", label: "edits.length >= 3", test: (record) => record.mode === "multi" && record.editsCount >= 3 },
	].map((bucket) => {
		const bucketRecords = records.filter(bucket.test);
		const bucketResolved = bucketRecords.filter((record) => record.success !== null);
		const bucketSuccess = bucketResolved.filter((record) => record.success).length;
		const bucketFailed = bucketResolved.filter((record) => record.success === false).length;
		return {
			key: bucket.key,
			label: bucket.label,
			calls: bucketRecords.length,
			resolved: bucketResolved.length,
			success: bucketSuccess,
			failed: bucketFailed,
			unresolved: bucketRecords.length - bucketResolved.length,
			successRate: bucketResolved.length === 0 ? null : bucketSuccess / bucketResolved.length,
			failureRate: bucketResolved.length === 0 ? null : bucketFailed / bucketResolved.length,
		};
	});
	const argStyles = [...groupCounts(records, (record) => record.argStyle).entries()]
		.map(([style, count]) => ({ style, count }))
		.sort((a, b) => b.count - a.count || a.style.localeCompare(b.style));
	const providerStats = summarizeGroups(records, (record) => record.providerModel);
	const extensionStats = summarizeGroups(records, (record) => record.extension);
	const inflations = collectInflations(records);
	const noCoreChange = records.filter((record) => record.inflationRatio === null).length;
	const pathologicalThresholds = [10, 25, 100].map((threshold) => ({
		threshold,
		count: records.filter((record) => record.inflationRatio !== null && record.inflationRatio >= threshold).length,
	}));
	const failureKinds = [...groupCounts(records.filter((record) => record.success === false), (record) => record.errorKind ?? "other").entries()]
		.map(([kind, count]) => ({ kind, count }))
		.sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));

	return {
		filters: {
			model: options.modelFilter ?? null,
			extension: options.extFilter ?? null,
			failedOnly: options.failedOnly,
		},
		scan: {
			sessionsDir: meta.sessionsDir,
			sessionFilesScanned: meta.sessionFilesScanned,
			sessionFilesIncluded: meta.sessionFilesIncluded,
			sessionFilesSkippedOlderThanSince: meta.sessionFilesSkippedOlderThanSince,
			sessionFilesWithEditCalls: meta.sessionFilesWithEditCalls,
			since: meta.since ? { ms: meta.since.ms, iso: formatIso(meta.since.ms), source: meta.since.source } : null,
			malformedLines: meta.malformedLines,
			unmatchedToolResults: meta.unmatchedToolResults,
		},
		counts: {
			assistantMessagesWithEditCalls: uniqueAssistantMessages,
			totalEditCalls: records.length,
			resolvedEditCalls: resolved.length,
			success,
			failed,
			unresolved,
			single,
			multi,
			noCoreChange,
		},
		modeStats,
		multiEditLengthBuckets,
		argStyles,
		providerStats,
		extensionStats,
		inflation: {
			median: quantile(inflations, 0.5),
			p90: quantile(inflations, 0.9),
			p95: quantile(inflations, 0.95),
			p99: quantile(inflations, 0.99),
			pathologicalThresholds,
			hugeReplacements: buildHugeReplacementStats(records),
			failureByBucket: buildInflationBuckets(records),
		},
		sameFileClusters: buildSameFileClusterStats(records),
		failureKinds,
		worstExamples: buildWorstExamples(records, options.top),
	};
}

function printGroupTable(title, groups, formatter) {
	if (groups.length === 0) return;
	console.log(`\n${title}`);
	for (const group of groups) {
		console.log(formatter(group));
	}
}

function printHumanReport(summary) {
	const { scan, counts, modeStats, multiEditLengthBuckets, argStyles, providerStats, extensionStats, inflation, sameFileClusters, failureKinds, worstExamples, filters } = summary;
	console.log(`Scanned ${formatInt(scan.sessionFilesIncluded)} session files in ${scan.sessionsDir}`);
	if (scan.since) {
		console.log(`Session filter: files created at or after ${scan.since.iso} (${scan.since.source})`);
		console.log(`Skipped older session files: ${formatInt(scan.sessionFilesSkippedOlderThanSince)} of ${formatInt(scan.sessionFilesScanned)}`);
	}
	console.log(`Found ${formatInt(counts.totalEditCalls)} edit tool calls in ${formatInt(counts.assistantMessagesWithEditCalls)} assistant messages`);
	if (filters.model || filters.extension || filters.failedOnly) {
		const filterParts = [];
		if (filters.model) filterParts.push(`model contains \"${filters.model}\"`);
		if (filters.extension) filterParts.push(`extension = ${filters.extension}`);
		if (filters.failedOnly) filterParts.push("failed only");
		console.log(`Filters: ${filterParts.join(", ")}`);
	}

	console.log("\nSuccess rate");
	console.log(`  success:    ${formatInt(counts.success)}  ${formatPercent(counts.success, counts.resolvedEditCalls)}`);
	console.log(`  failed:     ${formatInt(counts.failed)}  ${formatPercent(counts.failed, counts.resolvedEditCalls)}`);
	console.log(`  unresolved: ${formatInt(counts.unresolved)}`);

	console.log("\nMode usage");
	console.log(`  single replacement: ${formatInt(counts.single)}  ${formatPercent(counts.single, counts.totalEditCalls)}`);
	console.log(`  multi-edit (edits): ${formatInt(counts.multi)}  ${formatPercent(counts.multi, counts.totalEditCalls)}`);

	console.log("\nFailures by edit type");
	for (const mode of modeStats) {
		console.log(
			`  ${mode.mode.padEnd(6)} calls=${formatInt(mode.calls).padStart(4)} success=${mode.successRate === null ? "n/a" : formatPercent(mode.success, mode.resolved).padStart(6)} failed=${mode.failureRate === null ? "n/a" : formatPercent(mode.failed, mode.resolved).padStart(6)} unresolved=${formatInt(mode.unresolved)}`
		);
	}

	console.log("\nMulti-edit bucket split");
	for (const bucket of multiEditLengthBuckets) {
		console.log(
			`  ${bucket.label.padEnd(20)} ${formatInt(bucket.calls).padStart(4)} calls  success=${bucket.successRate === null ? "n/a" : formatPercent(bucket.success, bucket.resolved).padStart(6)} failed=${bucket.failureRate === null ? "n/a" : formatPercent(bucket.failed, bucket.resolved).padStart(6)}`
		);
	}

	console.log("\nArgument style");
	for (const entry of argStyles) {
		console.log(`  ${entry.style.padEnd(22)} ${formatInt(entry.count).padStart(8)}  ${formatPercent(entry.count, counts.totalEditCalls)}`);
	}

	printGroupTable("By provider/model", providerStats, (group) => {
		return [
			`  ${group.key}`,
			`    calls: ${formatInt(group.calls)}`,
			`    success: ${group.successRate === null ? "n/a" : formatPercent(group.success, group.resolved)}`,
			`    multi-edit: ${group.multiRate === null ? "n/a" : formatPercent(group.multi, group.calls)}`,
			`    median inflation: ${formatRatio(group.medianInflation)}`,
			`    p95 inflation: ${formatRatio(group.p95Inflation)}`,
		].join("\n");
	});

	printGroupTable("By file extension", extensionStats, (group) => {
		return `  ${group.key.padEnd(10)} calls=${formatInt(group.calls).padStart(6)}  success=${group.successRate === null ? "n/a" : formatPercent(group.success, group.resolved).padStart(6)}  medianInflation=${formatRatio(group.medianInflation)}`;
	});

	console.log("\nContext inflation");
	console.log(`  median inflation: ${formatRatio(inflation.median)}`);
	console.log(`  p90 inflation:    ${formatRatio(inflation.p90)}`);
	console.log(`  p95 inflation:    ${formatRatio(inflation.p95)}`);
	console.log(`  p99 inflation:    ${formatRatio(inflation.p99)}`);
	console.log(`  no-core-change:   ${formatInt(counts.noCoreChange)}`);

	console.log("\nHuge replacements");
	for (const entry of inflation.hugeReplacements) {
		console.log(`  >${formatBytes(entry.threshold).padEnd(6)} ${formatInt(entry.count).padStart(8)}`);
	}

	console.log("\nPathological wrappers");
	for (const entry of inflation.pathologicalThresholds) {
		console.log(`  inflation >= ${String(entry.threshold).padEnd(3)}x ${formatInt(entry.count).padStart(8)}`);
	}

	console.log("\nSame-file multi-call behavior");
	console.log(`  assistant msgs with 2+ edit calls to same file: ${formatInt(sameFileClusters.assistantMessagesWithCluster)}`);
	console.log(`  total same-file clusters:                      ${formatInt(sameFileClusters.clustersCount)}`);
	console.log(`  calls inside those clusters:                  ${formatInt(sameFileClusters.callsInsideClusters)}`);
	console.log(`  average calls per cluster:                    ${sameFileClusters.averageCallsPerCluster === null ? "n/a" : sameFileClusters.averageCallsPerCluster.toFixed(2)}`);
	console.log(`  assistant msgs using one multi-edit call:     ${formatInt(sameFileClusters.assistantMessagesWithMultiEdit)}`);
	console.log(`  ratio multi-call / multi-edit assistant msgs: ${sameFileClusters.ratioClusterAssistantMessagesToMultiEditAssistantMessages === null ? "n/a" : sameFileClusters.ratioClusterAssistantMessagesToMultiEditAssistantMessages.toFixed(2)}`);

	console.log("\nFailures by kind");
	if (failureKinds.length === 0) {
		console.log("  none");
	} else {
		for (const failure of failureKinds) {
			console.log(`  ${failure.kind.padEnd(22)} ${formatInt(failure.count).padStart(8)}`);
		}
	}

	console.log("\nFailure rate by inflation bucket");
	for (const bucket of inflation.failureByBucket) {
		console.log(`  ${bucket.label.padEnd(14)} ${bucket.failureRate === null ? "n/a" : formatPercent(bucket.failed, bucket.resolved).padStart(6)}  (${formatInt(bucket.count)} calls)`);
	}

	console.log(`\nWorst ${formatInt(worstExamples.length)} examples`);
	for (let i = 0; i < worstExamples.length; i++) {
		const example = worstExamples[i];
		console.log(
			`  ${i + 1}. ${example.providerModel} ${example.extension} inflation=${formatRatio(example.inflationRatio)} failed=${example.failed ? example.errorKind : "false"}`
		);
		console.log(`     path: ${example.path}`);
		console.log(`     totalEditBytes=${formatBytes(example.totalEditBytes)} coreBytes=${formatBytes(example.coreBytes)} mode=${example.mode} edits=${example.editsCount}`);
	}

	if (scan.malformedLines > 0 || scan.unmatchedToolResults > 0) {
		console.log("\nParser notes");
		if (scan.malformedLines > 0) console.log(`  malformed lines skipped: ${formatInt(scan.malformedLines)}`);
		if (scan.unmatchedToolResults > 0) console.log(`  unmatched edit tool results: ${formatInt(scan.unmatchedToolResults)}`);
	}
}

async function scanSessions(sessionsDir, since) {
	const records = [];
	const meta = {
		sessionsDir,
		sessionFilesScanned: 0,
		sessionFilesIncluded: 0,
		sessionFilesSkippedOlderThanSince: 0,
		sessionFilesWithEditCalls: 0,
		since,
		malformedLines: 0,
		unmatchedToolResults: 0,
	};

	for await (const sessionFile of walkJsonlFiles(sessionsDir)) {
		meta.sessionFilesScanned++;
		const sessionTimestampMs = parseSessionFileTimestamp(sessionFile);
		if (since && sessionTimestampMs !== null && sessionTimestampMs < since.ms) {
			meta.sessionFilesSkippedOlderThanSince++;
			continue;
		}
		meta.sessionFilesIncluded++;
		const pending = new Map();
		let fileHadEditCall = false;
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

			if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const block of message.content) {
					if (block?.type !== "toolCall" || block.name !== "edit") continue;
					fileHadEditCall = true;
					const analysis = analyzeToolArguments(block.arguments);
					const record = {
						sessionFile,
						assistantEntryId: entry.id,
						toolCallId: typeof block.id === "string" ? block.id : "",
						timestamp: entry.timestamp,
						api: typeof message.api === "string" ? message.api : null,
						provider: typeof message.provider === "string" ? message.provider : "[unknown]",
						model: typeof message.model === "string" ? message.model : "[unknown]",
						providerModel: `${typeof message.provider === "string" ? message.provider : "[unknown]"}/${typeof message.model === "string" ? message.model : "[unknown]"}`,
						success: null,
						errorKind: null,
						errorText: "",
						resultSummary: "",
						matchedResult: false,
						...analysis,
					};
					records.push(record);
					if (record.toolCallId) pending.set(record.toolCallId, record);
				}
			}

			if (message.role === "toolResult" && message.toolName === "edit") {
				const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
				const record = pending.get(toolCallId);
				if (!record) {
					meta.unmatchedToolResults++;
					continue;
				}
				const text = extractTextContent(message.content);
				record.matchedResult = true;
				record.success = message.isError === true ? false : true;
				record.resultSummary = text;
				record.errorText = message.isError === true ? text : "";
				record.errorKind = classifyErrorKind(text, message.isError === true, true);
				pending.delete(toolCallId);
			}
		}

		for (const record of pending.values()) {
			record.matchedResult = false;
			record.success = null;
			record.errorKind = classifyErrorKind("", false, false);
		}

		if (fileHadEditCall) meta.sessionFilesWithEditCalls++;
	}

	return { records, meta };
}

function applyFilters(records, options) {
	return records.filter((record) => {
		if (options.modelFilter && !record.providerModel.toLowerCase().includes(options.modelFilter.toLowerCase())) {
			return false;
		}
		if (options.extFilter && record.extension !== options.extFilter) {
			return false;
		}
		if (options.failedOnly && record.success !== false) {
			return false;
		}
		return true;
	});
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
		const output = options.includeRecords ? { summary, records: filteredRecords } : { summary };
		console.log(JSON.stringify(output, null, 2));
		return;
	}

	printHumanReport(summary);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
