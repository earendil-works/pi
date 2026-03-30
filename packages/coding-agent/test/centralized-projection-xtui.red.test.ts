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

async function waitForRows(
	sessionName: string,
	path: string,
	predicate: (rows: string[]) => boolean,
	attempts = 10,
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

describe("centralized projection xtui red suite", () => {
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

	async function expectProjectionSurface(surface: "inline" | "dialog"): Promise<void> {
		const sessionName = `mu-centralized-projection-red-${surface}-${process.pid}-${Date.now()}`;
		sessionNames.push(sessionName);
		const outDir = mkdtempSync(join(tmpdir(), `mu-centralized-projection-red-${surface}-`));
		tempDirs.push(outDir);
		const snapPath = join(outDir, "screen.json");

		xtui([
			"session",
			"start",
			"--name",
			sessionName,
			"--cmd",
			`MU_XTUI_PROJECTION_SURFACE=${surface} npx tsx packages/coding-agent/test/fixtures/centralized-projection-xtui.ts`,
			"--cwd",
			join(process.cwd(), "..", ".."),
			"--cols",
			"100",
			"--rows",
			"24",
		]);

		const rows = await waitForRows(
			sessionName,
			snapPath,
			(snapshotRows) => snapshotRows.some((row) => row.includes("Todo List") || row.includes("Projection docs")),
			20,
			100,
		);

		const composerRows = rows.slice(-6, -2);
		const nonComposerRows = rows.slice(0, -6).concat(rows.slice(-2));

		expect(nonComposerRows.some((row) => row.includes("Search Results"))).toBe(true);
		expect(rows.some((row) => row.includes("Todo List"))).toBe(false);
		expect(composerRows.some((row) => row.includes("Search Results"))).toBe(false);
	}

	it("shows a generic inline projection card above the composer", async () => {
		await expectProjectionSurface("inline");
	});

	it("shows a generic dialog projection card without todo-specific chrome", async () => {
		await expectProjectionSurface("dialog");
	});
});
