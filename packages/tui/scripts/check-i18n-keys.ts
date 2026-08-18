#!/usr/bin/env node

/**
 * Check that en.json and zh-CN.json have the same key structure.
 * Run: npx tsx scripts/check-i18n-keys.ts
 */

import { execSync } from "child_process";
import { join } from "path";

const scriptPath = join(import.meta.dirname ?? ".", "..", "..", "..", "scripts", "check-i18n-keys.mjs");
const localeDir = join(import.meta.dirname ?? ".", "..", "src", "i18n", "locales");

try {
	execSync(`node "${scriptPath}" "${localeDir}"`, { stdio: "inherit" });
} catch {
	process.exit(1);
}
