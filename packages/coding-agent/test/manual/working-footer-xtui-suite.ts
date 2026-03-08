import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

interface SnapCell {
	char: string;
}

type SnapRow = SnapCell[];

interface SnapFile {
	screen: {
		cells: SnapRow[];
	};
}

type ExpectationMode = "current" | "target";

interface SuiteOptions {
	expectation: ExpectationMode;
	muCommand: string;
	cols: number;
	rows: number;
	prompt: string;
	outDir: string;
}

function parseArgs(argv: string[]): SuiteOptions {
	let expectation: ExpectationMode = "target";
	let muCommand = "npx tsx packages/coding-agent/src/cli.ts --no-session";
	let cols = 100;
	let rows = 28;
	let prompt = "Count from 1 to 400, with each number on its own line.";
	let outDir = mkdtempSync(join(tmpdir(), "mu-working-footer-xtui-"));

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--expect") {
			const value = argv[index + 1];
			if (value !== "current" && value !== "target") {
				throw new Error(`Invalid --expect value: ${value ?? "<missing>"}`);
			}
			expectation = value;
			index++;
			continue;
		}
		if (arg === "--mu-cmd") {
			muCommand = argv[index + 1] ?? "";
			if (!muCommand) throw new Error("Missing value for --mu-cmd");
			index++;
			continue;
		}
		if (arg === "--cols") {
			cols = Number.parseInt(argv[index + 1] ?? "", 10);
			if (!Number.isFinite(cols)) throw new Error("Invalid value for --cols");
			index++;
			continue;
		}
		if (arg === "--rows") {
			rows = Number.parseInt(argv[index + 1] ?? "", 10);
			if (!Number.isFinite(rows)) throw new Error("Invalid value for --rows");
			index++;
			continue;
		}
		if (arg === "--prompt") {
			prompt = argv[index + 1] ?? "";
			if (!prompt) throw new Error("Missing value for --prompt");
			index++;
			continue;
		}
		if (arg === "--out-dir") {
			outDir = argv[index + 1] ?? "";
			if (!outDir) throw new Error("Missing value for --out-dir");
			index++;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return { expectation, muCommand, cols, rows, prompt, outDir };
}

function xtui(args: string[], cwd: string): string {
	return execFileSync("xtui", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: process.env,
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSessionAlive(sessionName: string, cwd: string, attempts = 30, intervalMs = 150): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const sessions = xtui(["session", "list"], cwd);
		if (
			sessions.includes(`${sessionName}\t`) ||
			sessions.includes(`${sessionName} `) ||
			sessions.includes(sessionName)
		) {
			return;
		}
		await sleep(intervalMs);
	}
	throw new Error(`Timed out waiting for xtui session ${sessionName} to appear`);
}

function readSnapRows(path: string): string[] {
	if (!existsSync(path)) return [];
	const data = JSON.parse(readFileSync(path, "utf8")) as SnapFile;
	return data.screen.cells.map((row) =>
		row
			.map((cell) => cell.char)
			.join("")
			.replace(/\s+$/g, ""),
	);
}

async function waitForRows(
	sessionName: string,
	path: string,
	cwd: string,
	predicate: (rows: string[]) => boolean,
	attempts = 25,
	intervalMs = 250,
): Promise<string[]> {
	let lastRows: string[] = [];
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			xtui(["snap", "--session", sessionName, "--json", "--full", "--out", path], cwd);
		} catch {
			await sleep(intervalMs);
			continue;
		}
		const rows = readSnapRows(path);
		lastRows = rows;
		if (predicate(rows)) return rows;
		await sleep(intervalMs);
	}
	if (lastRows.length > 0) return lastRows;
	throw new Error(`Unable to capture rows for session ${sessionName}`);
}

function findComposerTop(rows: string[]): number {
	const index = rows.findIndex((row) => row.startsWith("╭─ "));
	if (index === -1) {
		throw new Error(`Composer top border not found in snapshot:\n${rows.join("\n")}`);
	}
	return index;
}

function findRowsContaining(rows: string[], needle: string): number[] {
	return rows.flatMap((row, index) => (row.includes(needle) ? [index] : []));
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

function logSnapshot(label: string, rows: string[]): void {
	console.log(`\n[${label}]`);
	for (const [index, row] of rows.entries()) {
		console.log(`${String(index).padStart(2, "0")}: ${row}`);
	}
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const repoRoot = join(process.cwd(), "..", "..");
	const repoName = basename(repoRoot);
	const sessionName = `mu-working-footer-${process.pid}-${Date.now()}`;
	const idlePath = join(options.outDir, "idle.json");
	const activePath = join(options.outDir, "active.json");

	let sessionStarted = false;
	try {
		xtui(
			[
				"session",
				"start",
				"--name",
				sessionName,
				"--cmd",
				options.muCommand,
				"--cwd",
				repoRoot,
				"--cols",
				String(options.cols),
				"--rows",
				String(options.rows),
			],
			repoRoot,
		);
		sessionStarted = true;

		await waitForSessionAlive(sessionName, repoRoot);

		const idleRows = await waitForRows(sessionName, idlePath, repoRoot, (rows) =>
			rows.some((row) => row.startsWith("╭─ ")),
		);
		const idleComposerTop = findComposerTop(idleRows);
		const idleRowsBelowComposer = idleRows.slice(idleComposerTop + 1);

		assert(
			idleRowsBelowComposer.some((row) => row.includes(repoName)),
			`Idle layout should show workspace context below the composer; expected to find ${repoName}`,
		);

		xtui(["send", "--session", sessionName, "--keys", `${options.prompt}{Enter}`, "--wait", "50"], repoRoot);

		const activeRows = await waitForRows(
			sessionName,
			activePath,
			repoRoot,
			(rows) => rows.some((row) => row.includes("Working")) && rows.some((row) => row.startsWith("╭─ ")),
			30,
			300,
		);
		const activeComposerTop = findComposerTop(activeRows);
		const workingRows = findRowsContaining(activeRows, "Working");
		assert(workingRows.length > 0, "Expected an active snapshot containing a Working row");

		if (options.expectation === "current") {
			assert(
				workingRows.some((index) => index < activeComposerTop),
				`Current layout expectation failed: expected Working row above composer, got rows ${workingRows.join(", ")} with composer at ${activeComposerTop}`,
			);
		} else {
			assert(
				workingRows.some((index) => index > activeComposerTop),
				`Target layout expectation failed: expected Working row below composer, got rows ${workingRows.join(", ")} with composer at ${activeComposerTop}`,
			);
			assert(
				workingRows.every((index) => index > activeComposerTop),
				`Target layout expectation failed: Working row should not remain in the chat area above composer, got rows ${workingRows.join(", ")} with composer at ${activeComposerTop}`,
			);
		}

		console.log(`Verification passed for expectation: ${options.expectation}`);
		console.log(`Artifacts saved to: ${options.outDir}`);
		console.log(`Idle snapshot: ${idlePath}`);
		console.log(`Active snapshot: ${activePath}`);
		logSnapshot("idle", idleRows);
		logSnapshot("active", activeRows);
	} finally {
		if (sessionStarted) {
			try {
				xtui(["session", "stop", "--name", sessionName], repoRoot);
			} catch {
				// best effort cleanup
			}
		}
	}
}

void main().catch((error: unknown) => {
	const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
	console.error(message);
	process.exitCode = 1;
});
