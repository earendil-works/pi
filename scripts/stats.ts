#!/usr/bin/env npx tsx

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

interface UsageCost {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	total?: number;
}

interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: UsageCost;
}

interface AssistantMessage {
	role?: string;
	provider?: string;
	usage?: Usage;
	timestamp?: number;
}

interface SessionEntry {
	type?: string;
	timestamp?: string;
	message?: AssistantMessage;
}

interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costInput: number;
	costOutput: number;
	costCacheRead: number;
	costCacheWrite: number;
	costTotal: number;
	assistantMessages: number;
	sessions: Set<string>;
}

interface DayStats extends Totals {
	providers: Map<string, Totals>;
}

interface Args {
	days: number;
	cwd: string;
	sessionsBase: string;
}

function createTotals(): Totals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		costInput: 0,
		costOutput: 0,
		costCacheRead: 0,
		costCacheWrite: 0,
		costTotal: 0,
		assistantMessages: 0,
		sessions: new Set<string>(),
	};
}

function createDayStats(): DayStats {
	return {
		...createTotals(),
		providers: new Map<string, Totals>(),
	};
}

function addUsage(totals: Totals, usage: Usage, sessionFile: string): void {
	const cost = usage.cost ?? {};
	totals.input += usage.input ?? 0;
	totals.output += usage.output ?? 0;
	totals.cacheRead += usage.cacheRead ?? 0;
	totals.cacheWrite += usage.cacheWrite ?? 0;
	totals.totalTokens += usage.totalTokens ?? 0;
	totals.costInput += cost.input ?? 0;
	totals.costOutput += cost.output ?? 0;
	totals.costCacheRead += cost.cacheRead ?? 0;
	totals.costCacheWrite += cost.cacheWrite ?? 0;
	totals.costTotal += cost.total ?? 0;
	totals.assistantMessages += 1;
	totals.sessions.add(sessionFile);
}

function encodeSessionDir(cwd: string): string {
	const normalized = cwd.startsWith("/") ? cwd.slice(1) : cwd;
	return `--${normalized.replace(/\//g, "-")}--`;
}

function localDayKey(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function parseArgs(): Args {
	const args = process.argv.slice(2);
	let days = 7;
	let cwd = process.cwd();
	let sessionsBase = join(homedir(), ".pi", "agent", "sessions");

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if ((arg === "--days" || arg === "-n") && args[i + 1]) {
			days = Number.parseInt(args[++i], 10);
		} else if ((arg === "--cwd" || arg === "--dir" || arg === "-d") && args[i + 1]) {
			cwd = resolve(args[++i]);
		} else if (arg === "--sessions-base" && args[i + 1]) {
			sessionsBase = resolve(args[++i]);
		} else if (arg === "--help" || arg === "-h") {
			console.log(`Usage: scripts/stats.ts [options]

Options:
  -n, --days <days>         Number of local calendar days to include (default: 7)
  -d, --dir, --cwd <path>   Project cwd to inspect (default: current cwd)
  --sessions-base <path>    Sessions base directory (default: ~/.pi/agent/sessions)
  -h, --help                Show this help`);
			process.exit(0);
		}
	}

	if (!Number.isInteger(days) || days <= 0) {
		throw new Error("--days must be a positive integer");
	}

	return { days, cwd: resolve(cwd), sessionsBase };
}

function formatInt(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

function formatCost(value: number): string {
	return `$${value.toFixed(4)}`;
}

function printTotals(label: string, totals: Totals): void {
	console.log(
		`${label.padEnd(16)} messages: ${String(totals.assistantMessages).padStart(5)}  sessions: ${String(totals.sessions.size).padStart(3)}  ` +
			`input: ${formatInt(totals.input).padStart(12)}  output: ${formatInt(totals.output).padStart(10)}  ` +
			`cache read: ${formatInt(totals.cacheRead).padStart(13)}  cache write: ${formatInt(totals.cacheWrite).padStart(10)}  ` +
			`total: ${formatInt(totals.totalTokens).padStart(13)}  cost: ${formatCost(totals.costTotal).padStart(10)}`,
	);
}

const { days, cwd, sessionsBase } = parseArgs();
const sessionsDir = join(sessionsBase, encodeSessionDir(cwd));

if (!existsSync(sessionsDir)) {
	throw new Error(`Sessions directory not found: ${sessionsDir}`);
}

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
start.setDate(start.getDate() - days + 1);
const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

const stats = new Map<string, DayStats>();
const grandTotal = createTotals();

for (const file of readdirSync(sessionsDir)) {
	if (!file.endsWith(".jsonl")) continue;

	const path = join(sessionsDir, file);
	const lines = readFileSync(path, "utf8").split("\n");
	for (const line of lines) {
		if (!line.trim()) continue;

		let entry: SessionEntry;
		try {
			entry = JSON.parse(line) as SessionEntry;
		} catch {
			continue;
		}

		if (entry.type !== "message" || entry.message?.role !== "assistant" || !entry.message.usage) continue;

		const timestamp = entry.message.timestamp !== undefined ? new Date(entry.message.timestamp) : new Date(entry.timestamp ?? 0);
		if (timestamp < start || timestamp >= end) continue;

		const dayKey = localDayKey(timestamp);
		let dayStats = stats.get(dayKey);
		if (!dayStats) {
			dayStats = createDayStats();
			stats.set(dayKey, dayStats);
		}

		const provider = entry.message.provider ?? "unknown";
		let providerStats = dayStats.providers.get(provider);
		if (!providerStats) {
			providerStats = createTotals();
			dayStats.providers.set(provider, providerStats);
		}

		addUsage(dayStats, entry.message.usage, file);
		addUsage(providerStats, entry.message.usage, file);
		addUsage(grandTotal, entry.message.usage, file);
	}
}

console.log(`Usage for ${cwd}`);
console.log(`Sessions: ${sessionsDir}`);
console.log(`Period: ${localDayKey(start)} through ${localDayKey(new Date(end.getTime() - 1))} (${days} local days)`);
console.log("".padEnd(160, "="));

for (const day of [...stats.keys()].sort()) {
	const dayStats = stats.get(day)!;
	printTotals(day, dayStats);
	for (const provider of [...dayStats.providers.keys()].sort()) {
		printTotals(`  ${provider}`, dayStats.providers.get(provider)!);
	}
}

console.log("".padEnd(160, "-"));
printTotals("TOTAL", grandTotal);
