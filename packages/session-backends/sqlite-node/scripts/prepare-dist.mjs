#!/usr/bin/env node

import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const distDir = resolve(packageDir, "dist");
const migrationSourceDir = resolve(packageDir, "src/sqlite/migrations");
const migrationDestDir = resolve(distDir, "sqlite/migrations");

async function clean() {
	await rm(distDir, { recursive: true, force: true });
}

async function copySqliteMigrations() {
	await mkdir(migrationDestDir, { recursive: true });
	await cp(migrationSourceDir, migrationDestDir, { recursive: true });
}

const command = process.argv[2];

if (command === "clean") {
	await clean();
	process.exit(0);
}

if (command === "copy-sqlite-migrations") {
	await copySqliteMigrations();
	process.exit(0);
}

console.error("Usage: node scripts/prepare-dist.mjs <clean|copy-sqlite-migrations>");
process.exit(1);
