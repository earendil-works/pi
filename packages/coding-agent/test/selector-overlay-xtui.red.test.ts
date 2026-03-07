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

describe("selector overlays via xtui", () => {
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

	async function expectSelectorShowsAsDialog(
		selectorKind: "model" | "theme" | "thinking" | "queue" | "user",
	): Promise<void> {
		const sessionName = `mu-selector-overlay-red-${selectorKind}-${process.pid}-${Date.now()}`;
		sessionNames.push(sessionName);
		const outDir = mkdtempSync(join(tmpdir(), `mu-selector-overlay-red-${selectorKind}-`));
		tempDirs.push(outDir);
		const snapPath = join(outDir, "screen.json");

		const readyTextBySelector: Record<typeof selectorKind, string> = {
			model: "Only showing models with configured API keys",
			theme: "dark",
			thinking: "minimal",
			queue: "one-at-a-time",
			user: "first user",
		};
		const selectorText = readyTextBySelector[selectorKind];

		xtui([
			"session",
			"start",
			"--name",
			sessionName,
			"--cmd",
			`OPENAI_API_KEY=test-openai-key MU_XTUI_SELECTOR_KIND=${selectorKind} npx tsx packages/coding-agent/test/fixtures/selector-overlay-xtui.ts`,
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
			(snapshotRows) => snapshotRows.some((row) => row.includes(readyTextBySelector[selectorKind])),
			20,
			100,
		);

		const composerRows = rows.slice(-6, -2);
		const nonComposerRows = rows.slice(0, -6).concat(rows.slice(-2));

		// Desired overlay behavior: selector content should not be clipped into the sticky composer.
		expect(composerRows.some((row) => row.includes(selectorText))).toBe(false);
		expect(nonComposerRows.some((row) => row.includes(selectorText))).toBe(true);
	}

	it("renders /model as a real dialog instead of clipping it into the sticky composer", async () => {
		await expectSelectorShowsAsDialog("model");
	});

	it("renders /theme as a real dialog instead of clipping it into the sticky composer", async () => {
		await expectSelectorShowsAsDialog("theme");
	});

	it("renders /thinking as a real dialog instead of clipping it into the sticky composer", async () => {
		await expectSelectorShowsAsDialog("thinking");
	});

	it("renders queue mode as a real dialog instead of clipping it into the sticky composer", async () => {
		await expectSelectorShowsAsDialog("queue");
	});

	it("renders user-message selector as a real dialog instead of clipping it into the sticky composer", async () => {
		await expectSelectorShowsAsDialog("user");
	});
});
