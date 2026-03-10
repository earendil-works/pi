import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

function xtui(args: string[]): string {
	return execFileSync("xtui", args, {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

async function waitForSessionAlive(sessionName: string, attempts = 20, intervalMs = 100): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt++) {
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
	attempts = 15,
	intervalMs = 200,
): Promise<string[]> {
	let lastRows: string[] = [];
	for (let attempt = 0; attempt < attempts; attempt++) {
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

describe("xtui transcript copy toast", () => {
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

	it("shows a top-center toast after transcript copy and then dismisses it", async () => {
		const sessionName = `mu-toast-xtui-${process.pid}-${Date.now()}`;
		sessionNames.push(sessionName);
		const outDir = mkdtempSync(join(tmpdir(), "mu-toast-xtui-"));
		tempDirs.push(outDir);
		const snapPath = join(outDir, "screen.json");

		xtui([
			"session",
			"start",
			"--name",
			sessionName,
			"--cmd",
			"OPENAI_API_KEY=test-openai-key npx tsx packages/coding-agent/test/fixtures/transcript-copy-toast-xtui.ts",
			"--cwd",
			repoRoot,
			"--cols",
			"100",
			"--rows",
			"20",
		]);

		await waitForSessionAlive(sessionName);

		const visibleRows = await waitForRows(sessionName, snapPath, (rows) =>
			rows.some((row) => row.includes("Text Copied to Clipboard")),
		);

		const toastRow = visibleRows.findIndex((row) => row.includes("Text Copied to Clipboard"));
		expect(toastRow).toBeGreaterThanOrEqual(0);
		expect(toastRow).toBeGreaterThan(0);
		expect(toastRow).toBeLessThanOrEqual(5);
		expect(visibleRows.some((row) => row.includes("Text Copied to Clipboard"))).toBe(true);
		expect(visibleRows.some((row) => row.includes("XTUI_TOAST_READY"))).toBe(true);

		await new Promise((resolve) => setTimeout(resolve, 1800));
		const dismissedRows = await waitForRows(
			sessionName,
			snapPath,
			(rows) =>
				rows.some((row) => row.includes("XTUI_TOAST_READY")) &&
				!rows.some((row) => row.includes("Text Copied to Clipboard")),
		);

		expect(dismissedRows.some((row) => row.includes("XTUI_TOAST_READY"))).toBe(true);
		expect(dismissedRows.some((row) => row.includes("Text Copied to Clipboard"))).toBe(false);
	});
});
