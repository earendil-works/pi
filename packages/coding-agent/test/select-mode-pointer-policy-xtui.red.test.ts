import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function xtui(args: string[]): string {
	return execFileSync("xtui", args, {
		cwd: join(process.cwd(), "..", ".."),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function readSnapRows(path: string): string[] {
	const data = JSON.parse(readFileSync(path, "utf8")) as SnapFile;
	return data.screen.cells.map((row) =>
		row
			.map((cell) => cell.char)
			.join("")
			.replace(/\s+$/g, ""),
	);
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

async function waitForRows(
	sessionName: string,
	path: string,
	predicate: (rows: string[]) => boolean,
	attempts = 20,
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
	return lastRows.length > 0 ? lastRows : readSnapRows(path);
}

describe("xtui /select pointer policy spec", () => {
	const tempDirs: string[] = [];
	const sessionNames: string[] = [];

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

	it("switches to selection mode so mouse wheel no longer scrolls the chat viewport", async () => {
		const sessionName = `mu-select-pointer-policy-red-${process.pid}-${Date.now()}`;
		sessionNames.push(sessionName);
		const outDir = mkdtempSync(join(tmpdir(), "mu-select-pointer-policy-red-"));
		tempDirs.push(outDir);
		const beforePath = join(outDir, "before.json");
		const selectedPath = join(outDir, "selected.json");
		const afterWheelPath = join(outDir, "after-wheel.json");

		xtui([
			"session",
			"start",
			"--name",
			sessionName,
			"--cmd",
			"npx tsx packages/coding-agent/test/fixtures/chat-pointer-policy-xtui.ts",
			"--cwd",
			join(process.cwd(), "..", ".."),
			"--cols",
			"100",
			"--rows",
			"20",
		]);

		await waitForSessionAlive(sessionName);
		await waitForRows(
			sessionName,
			beforePath,
			(rows) => rows.some((row) => row.includes("XTUI_POINTER_POLICY app")),
			20,
			150,
		);

		xtui(["send", "--session", sessionName, "--keys", "/select{Enter}", "--wait", "800"]);

		const selectedRows = await waitForRows(
			sessionName,
			selectedPath,
			(snapshotRows) => snapshotRows.some((row) => row.includes("XTUI_MODE Selection mode")),
			20,
			150,
		);

		xtui(["send", "--session", sessionName, "--keys-hex", "1b 5b 3c 36 34 3b 39 39 3b 35 4d", "--wait", "800"]);

		const afterWheelRows = await waitForRows(
			sessionName,
			afterWheelPath,
			(snapshotRows) => snapshotRows.some((row) => row.includes("XTUI_MODE Selection mode")),
			20,
			150,
		);

		expect(selectedRows.some((row) => row.includes("XTUI_MODE Selection mode"))).toBe(true);
		expect(afterWheelRows).toEqual(selectedRows);
	});
});
