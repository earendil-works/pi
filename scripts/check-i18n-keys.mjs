#!/usr/bin/env node

/**
 * Check i18n health:
 * 1. en.json and zh-CN.json have the same key structure
 * 2. All t() calls in source code reference keys that exist in en.json
 *
 * Usage:
 *   node scripts/check-i18n-keys.mjs [localeDir]
 *
 * If localeDir is not provided, defaults to packages/tui/src/i18n/locales
 *
 * Examples:
 *   node scripts/check-i18n-keys.mjs
 *   node scripts/check-i18n-keys.mjs packages/tui/src/i18n/locales
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve, relative } from "path";

const defaultLocaleDir = join(import.meta.dirname, "..", "packages", "tui", "src", "i18n", "locales");
const LOCALES_DIR = resolve(process.argv[2] || defaultLocaleDir);
const PROJECT_ROOT = join(import.meta.dirname, "..");

function flattenKeys(obj, prefix = "") {
	const keys = [];
	for (const [key, value] of Object.entries(obj)) {
		const fullKey = prefix ? `${prefix}.${key}` : key;
		if (typeof value === "object" && value !== null) {
			keys.push(...flattenKeys(value, fullKey));
		} else {
			keys.push(fullKey);
		}
	}
	return keys;
}

function loadLocale(locale) {
	const filePath = join(LOCALES_DIR, `${locale}.json`);
	try {
		const content = readFileSync(filePath, "utf-8");
		return JSON.parse(content);
	} catch {
		console.error(`Failed to load ${filePath}`);
		process.exit(1);
	}
}

function collectSourceFiles(dir, files = []) {
	const entries = readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
			collectSourceFiles(fullPath, files);
		} else if (/\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
			files.push(fullPath);
		}
	}
	return files;
}

function extractTranslationKeys(sourceFiles) {
	const usedKeys = new Set();
	const keyPattern = /\bt\(\s*["'`]([^"'`]+)["'`]/g;

	for (const filePath of sourceFiles) {
		const content = readFileSync(filePath, "utf-8");
		let match;
		while ((match = keyPattern.exec(content)) !== null) {
			usedKeys.add(match[1]);
		}
	}

	return usedKeys;
}

// --- Check 1: Key structure consistency ---
const en = loadLocale("en");
const zhCN = loadLocale("zh-CN");

const enKeys = new Set(flattenKeys(en));
const zhCNKeys = new Set(flattenKeys(zhCN));

const missingInZhCN = [...enKeys].filter((key) => !zhCNKeys.has(key));
const missingInEn = [...zhCNKeys].filter((key) => !enKeys.has(key));

let hasError = false;

if (missingInZhCN.length > 0) {
	console.error(`Missing in zh-CN.json (${missingInZhCN.length}):`);
	for (const key of missingInZhCN) {
		console.error(`  - ${key}`);
	}
	hasError = true;
}

if (missingInEn.length > 0) {
	console.error(`Missing in en.json (${missingInEn.length}):`);
	for (const key of missingInEn) {
		console.error(`  - ${key}`);
	}
	hasError = true;
}

// --- Check 2: Source code key usage ---
const sourceFiles = [
	...collectSourceFiles(join(PROJECT_ROOT, "packages", "coding-agent", "src")),
	...collectSourceFiles(join(PROJECT_ROOT, "packages", "tui", "src")),
];

const usedKeys = extractTranslationKeys(sourceFiles);
const undefinedKeys = [...usedKeys].filter((key) => !enKeys.has(key));

if (undefinedKeys.length > 0) {
	console.error(`\nKeys used in source but missing from en.json (${undefinedKeys.length}):`);
	for (const key of undefinedKeys.sort()) {
		console.error(`  - ${key}`);
	}
	hasError = true;
}

// --- Summary ---
if (!hasError) {
	const unusedCount = [...enKeys].filter((key) => !usedKeys.has(key)).length;
	console.log(`OK: ${enKeys.size} keys in en.json, ${usedKeys.size} keys used in source, ${unusedCount} unused`);
}

process.exit(hasError ? 1 : 0);
