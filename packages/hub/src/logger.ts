import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG_DIR = path.join(process.env.PI_HUB_DIR || path.join(os.homedir(), ".pi", "pi-hub"), "logs");

const LEVEL_PRIORITY: Record<string, number> = {
	DEBUG: 0,
	INFO: 1,
	WARN: 2,
	ERROR: 3,
};

let currentLevel = "INFO";

export function setLogLevel(level: string): void {
	const upper = level.toUpperCase();
	if (upper in LEVEL_PRIORITY) {
		currentLevel = upper;
	}
}

function shouldLog(level: string): boolean {
	return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}

function ensureLogDir(): void {
	if (!fs.existsSync(LOG_DIR)) {
		fs.mkdirSync(LOG_DIR, { recursive: true });
	}
}

function logFilePath(): string {
	const date = new Date().toISOString().slice(0, 10);
	return path.join(LOG_DIR, `pi-hub-${date}.log`);
}

function formatLine(level: string, message: string): string {
	const ts = new Date().toISOString();
	return `[${ts}] [${level}] ${message}\n`;
}

function write(level: string, message: string, err?: unknown): void {
	if (!shouldLog(level)) return;
	ensureLogDir();
	let line = formatLine(level, message);
	if (err instanceof Error) {
		line += formatLine(level, err.stack || err.message);
	} else if (err !== undefined) {
		line += formatLine(level, String(err));
	}
	try {
		fs.appendFileSync(logFilePath(), line, "utf-8");
	} catch {
		// ignore logging failures
	}
}

export function error(message: string, err?: unknown): void {
	write("ERROR", message, err);
}

export function warn(message: string, err?: unknown): void {
	write("WARN", message, err);
}

export function info(message: string): void {
	write("INFO", message);
}

export function debug(message: string): void {
	write("DEBUG", message);
}
