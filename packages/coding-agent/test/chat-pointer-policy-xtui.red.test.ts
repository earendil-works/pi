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

describe("xtui chat pointer policy spec", () => {
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

	it("keeps normal chat app-owned by default so scrollbar mouse interactions remain available", async () => {
		const sessionName = `mu-chat-pointer-policy-red-${process.pid}-${Date.now()}`;
		sessionNames.push(sessionName);
		const outDir = mkdtempSync(join(tmpdir(), "mu-chat-pointer-policy-red-"));
		tempDirs.push(outDir);
		const snapPath = join(outDir, "screen.json");

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

		const rows = await waitForRows(
			sessionName,
			snapPath,
			(snapshotRows) => snapshotRows.some((row) => row.includes("XTUI_POINTER_POLICY")),
			20,
			150,
		);

		expect(rows.some((row) => row.includes("XTUI_POINTER_POLICY app"))).toBe(true);
	});
});
