import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

interface SnapCell {
	char: string;
}

interface SnapRow extends Array<SnapCell> {}

interface SnapFile {
	screen: {
		cells: SnapRow[];
	};
}

const repoRoot = join(fileURLToPath(new URL("../../..", import.meta.url)));
const xtuiFixtureSource = join(
	repoRoot,
	"devdocs",
	"missions",
	"mission-reset-control-event",
	"fixtures",
	"xtui-optimize-resettable",
);

function xtui(args: string[]): string {
	return execFileSync("xtui", args, {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

async function waitForSessionAlive(sessionName: string, attempts = 20, intervalMs = 100): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const sessions = xtui(["session", "list"]);
		if (
			sessions.includes(`${sessionName}\t`) ||
			sessions.includes(`${sessionName} `) ||
			sessions.includes(sessionName)
		) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(`Timed out waiting for xtui session ${sessionName} to appear`);
}

function readSnapRows(path: string): string[] {
	if (!existsSync(path)) {
		return [];
	}
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
	predicate: (rows: string[]) => boolean,
	attempts = 25,
	intervalMs = 250,
): Promise<string[]> {
	let lastRows: string[] = [];
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			xtui(["snap", "--session", sessionName, "--json", "--full", "--out", path]);
		} catch {
			await new Promise((resolve) => setTimeout(resolve, intervalMs));
			continue;
		}
		const rows = readSnapRows(path);
		lastRows = rows;
		if (predicate(rows)) {
			return rows;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	return lastRows;
}

describe("xtui /mission-reset verification", () => {
	const sessionNames: string[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const sessionName of sessionNames.splice(0)) {
			try {
				xtui(["session", "stop", "--name", sessionName]);
			} catch {
				// best effort cleanup
			}
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("shows /mission-reset success in the real CLI and appends a control event to the fixture history", async () => {
		const sessionName = `mu-mission-reset-xtui-${process.pid}-${Date.now()}`;
		sessionNames.push(sessionName);

		const tempRoot = mkdtempSync(join(tmpdir(), "mu-mission-reset-xtui-"));
		tempDirs.push(tempRoot);
		const missionDir = join(tempRoot, "xtui-optimize-resettable");
		cpSync(xtuiFixtureSource, missionDir, { recursive: true });

		const snapPath = join(tempRoot, "screen.json");
		xtui([
			"session",
			"start",
			"--name",
			sessionName,
			"--cmd",
			"OPENAI_API_KEY=test-openai-key npx tsx packages/coding-agent/src/cli.ts --provider openai --model gpt-4o-mini --no-session",
			"--cwd",
			repoRoot,
			"--cols",
			"120",
			"--rows",
			"30",
		]);

		await waitForSessionAlive(sessionName);
		await waitForRows(
			sessionName,
			snapPath,
			(rows) => rows.some((row) => row.includes("for commands")) && rows.some((row) => row.includes("gpt-4o-mini")),
		);

		xtui(["send", "--session", sessionName, "--keys", `/mission-reset ${missionDir}{Enter}`, "--wait", "500"]);

		const rows = await waitForRows(
			sessionName,
			snapPath,
			(snapshotRows) =>
				snapshotRows.some((row) => row.includes("Mission reset appended.")) &&
				snapshotRows.some((row) => row.includes(missionDir)),
		);

		expect(rows.some((row) => row.includes("Mission reset appended."))).toBe(true);
		expect(rows.some((row) => row.includes(missionDir))).toBe(true);

		const lines = readFileSync(join(missionDir, "EXPERIMENTS.jsonl"), "utf8").trim().split("\n");
		const appended = JSON.parse(lines[lines.length - 1] ?? "{}");
		expect(appended).toMatchObject({
			type: "control",
			kind: "resume-reset",
			note: "Manual resume reset",
		});
		expect(typeof appended.timestamp).toBe("number");
	});
});
