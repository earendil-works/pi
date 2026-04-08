import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

function setEnvIfUnset(key: string, value: string): void {
	const v = value.trim();
	if (!v || process.env[key]) return;
	process.env[key] = v;
}

function parseSecretsEnv(content: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of content.split(/\r?\n/)) {
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		const eq = t.indexOf("=");
		if (eq <= 0) continue;
		const k = t.slice(0, eq).trim();
		let v = t.slice(eq + 1).trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
			v = v.slice(1, -1);
		}
		out[k] = v;
	}
	return out;
}

function applyEnvMap(m: Record<string, string>): void {
	for (const [k, v] of Object.entries(m)) {
		setEnvIfUnset(k, v);
	}
}

/**
 * Conventional `.keys` locations (workspace + monorepo parents).
 * Matches pi-mono-p2p `workspaceDotKeyFiles` so `AGENT_MEMORY_MONGODB_URI` works the same way.
 */
export function workspaceDotKeyFiles(workingDir: string): string[] {
	const wd = resolve(workingDir);
	return [join(wd, ".keys"), join(wd, "..", "..", ".keys"), join(wd, "..", ".keys")];
}

/**
 * Load KEY=value pairs from `.keys` without overriding existing process.env.
 */
export function loadWorkspaceDotKeys(workingDir: string): void {
	const seen = new Set<string>();
	for (const p of workspaceDotKeyFiles(workingDir)) {
		if (!p || seen.has(p)) continue;
		seen.add(p);
		if (!existsSync(p)) continue;
		try {
			const text = readFileSync(p, "utf8");
			applyEnvMap(parseSecretsEnv(text));
		} catch {
			// ignore unreadable
		}
	}
}
