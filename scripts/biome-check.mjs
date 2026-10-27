// Runs `biome check --error-on-warnings` for the biome.json in the current directory.
// Native Biome has no Android (Termux) binary. There, fall back to Biome's
// Node WASM bindings, which check one file at a time.
// Usage: node scripts/biome-check.mjs [--write]
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { matchesGlob, posix } from "node:path";
import { MemoryFileSystem, main, Workspace } from "@biomejs/wasm-nodejs";

const write = process.argv.includes("--write");

// Same platform table as @biomejs/biome/bin/biome.
const hasNativeBinary = ["win32", "darwin", "linux"].includes(process.platform) && ["x64", "arm64"].includes(process.arch);

if (hasNativeBinary) {
	const biomeBin = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");
	const args = ["check", "--error-on-warnings", ...(write ? ["--write"] : []), "."];
	const result = spawnSync(process.execPath, [biomeBin, ...args], { stdio: "inherit" });
	if (result.error) throw result.error;
	process.exit(result.status ?? 1);
}

// The WASM API has no CLI file scanner. Git supplies tracked and untracked
// files while respecting .gitignore; biome.json supplies the include patterns.
// A negated pattern also excludes everything below a matching directory.
const configuration = JSON.parse(readFileSync("biome.json", "utf8"));
const patterns = configuration.files?.includes ?? ["**"];
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
	encoding: "utf8",
})
	.split("\0")
	.filter(Boolean)
	.filter((path) => {
		let included = false;
		for (const pattern of patterns) {
			if (pattern.startsWith("!")) {
				const glob = pattern.replace(/^!+/, "");
				if (matchesGlob(path, glob) || matchesGlob(path, `${glob}/**`)) included = false;
			} else if (matchesGlob(path, pattern)) {
				included = true;
			}
		}
		return included;
	});

// The WASM workspace cannot read the disk. GritQL plugins referenced by
// biome.json must be preloaded into its in-memory file system, keyed by the
// configured path relative to the project ("./a.grit" becomes "a.grit").
main();
const fileSystem = new MemoryFileSystem();
for (const plugin of configuration.plugins ?? []) {
	fileSystem.insert(posix.normalize(plugin), readFileSync(plugin));
}
const workspace = Workspace.withFileSystem(fileSystem);
const { projectKey } = workspace.openProject({ path: process.cwd(), openUninitialized: true });
workspace.updateSettings({ projectKey, configuration, workspaceDirectory: "./" });

function withFile(path, content, run) {
	workspace.openFile({ projectKey, path, content: { type: "fromClient", content, version: 0 } });
	try {
		return run();
	} finally {
		workspace.closeFile({ projectKey, path });
	}
}

let failures = 0;
let checked = 0;
try {
	for (const path of files) {
		const original = readFileSync(path, "utf8");
		const fixed = write
			? withFile(
					path,
					original,
					() =>
						workspace.fixFile({
							projectKey,
							path,
							fixFileMode: "safeFixes",
							shouldFormat: false,
							ruleCategories: ["syntax", "lint", "action"],
						}).code,
				)
			: original;
		const { diagnostics, formatted } = withFile(path, fixed, () => {
			const { diagnostics } = workspace.pullDiagnostics({
				projectKey,
				path,
				categories: ["syntax", "lint", "action"],
				pullCodeActions: false,
			});
			// Like the CLI with formatWithErrors: false, skip formatting files with syntax errors.
			const syntax = workspace.pullDiagnostics({ projectKey, path, categories: ["syntax"], pullCodeActions: false });
			const formatted = syntax.errors === 0 ? workspace.formatFile({ projectKey, path }).code : fixed;
			return { diagnostics, formatted };
		});
		if (write && formatted !== original) writeFileSync(path, formatted);
		for (const diagnostic of diagnostics) {
			if (diagnostic.severity === "hint") continue;
			// Biome's WASM build reports its version as 0.0.0. Keep the real
			// schema URL for editors, but ignore only this spurious mismatch.
			if (
				path === "biome.json" &&
				diagnostic.category === "deserialize" &&
				diagnostic.description === "The configuration schema version does not match the CLI version 0.0.0"
			)
				continue;
			console.error(`${path}: ${diagnostic.severity} ${diagnostic.category ?? ""}: ${diagnostic.description}`);
			failures++;
		}
		if (!write && formatted !== original) {
			console.error(`${path}: formatting differs (run with --write)`);
			failures++;
		}
		checked++;
	}
} finally {
	workspace.free();
}
console.log(`Biome WASM: checked ${checked} files; ${failures} diagnostics.`);
if (failures > 0) process.exitCode = 1;
