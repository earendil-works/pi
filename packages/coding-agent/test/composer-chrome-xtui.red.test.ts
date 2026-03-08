import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface SnapColorDefault {
	type: "default";
}

interface SnapColorNamed {
	type: "named";
	name: string;
}

interface SnapColorRgb {
	type: "rgb";
	r: number;
	g: number;
	b: number;
}

type SnapColor = SnapColorDefault | SnapColorNamed | SnapColorRgb;

interface SnapCell {
	char: string;
	fg: SnapColor;
	bg: SnapColor;
	attrs: {
		bold: boolean;
		italic: boolean;
		underline: boolean;
		inverse: boolean;
	};
}

type SnapRow = SnapCell[];

interface SnapFile {
	screen: {
		cells: SnapRow[];
	};
}

interface HarnessPaths {
	tmpDir: string;
	homeDir: string;
	configDir: string;
	snapPath: string;
	workspaceDir: string;
}

interface HarnessSession {
	paths: HarnessPaths;
	sessionName: string;
}

function xtui(args: string[]): string {
	return execFileSync("xtui", args, {
		cwd: join(process.cwd(), "..", ".."),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function buildWorkspaceSessionDir(configDir: string, workspaceDir: string): string {
	const safePath = "--" + workspaceDir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
	return join(configDir, "sessions", safePath);
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function buildHarnessPaths(): HarnessPaths {
	const tmpDir = mkdtempSync(join(tmpdir(), "mu-composer-chrome-red-"));
	const homeDir = join(tmpDir, "home");
	const configDir = join(homeDir, ".mu", "agent");
	const workspaceDir = join(process.cwd(), "..", "..");
	const snapPath = join(tmpDir, "screen.json");
	return { tmpDir, homeDir, configDir, snapPath, workspaceDir };
}

function seedMuConfig(paths: HarnessPaths): void {
	mkdirSync(paths.configDir, { recursive: true });

	writeJson(join(paths.configDir, "settings.json"), {
		usageFooterMode: "visible",
		fastMode: true,
		theme: "dark",
	});

	writeJson(join(paths.configDir, "oauth.json"), {
		"openai-codex": {
			accounts: [
				{
					id: "acct1",
					credentials: {
						type: "oauth",
						refresh: "dummy-refresh",
						access: "dummy-access",
						expires: Date.now() + 60 * 60 * 1000,
						accountId: "acct1",
					},
				},
			],
			activeAccountId: "acct1",
		},
	});

	const sessionDir = buildWorkspaceSessionDir(paths.configDir, paths.workspaceDir);
	mkdirSync(sessionDir, { recursive: true });

	const sessionPath = join(sessionDir, "2026-03-08T13-00-00-000Z_xtui-composer-chrome.jsonl");
	const sessionHeader = {
		type: "session",
		version: 2,
		id: "xtui-composer-chrome",
		timestamp: "2026-03-08T13:00:00.000Z",
		cwd: paths.workspaceDir,
		provider: "openai-codex",
		modelId: "gpt-5.4",
		thinkingLevel: "medium",
	};
	const assistantEntry = {
		type: "message",
		id: "msg1",
		parentId: null,
		timestamp: "2026-03-08T13:00:01.000Z",
		message: {
			role: "assistant",
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5.4",
			timestamp: 1700000000000,
			stopReason: "stop",
			content: [{ type: "text", text: "hello world" }],
			usage: {
				input: 19040,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 19040,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			usageLimits: {
				primary: { usedPercent: 12, windowMinutes: 300 },
				secondary: { usedPercent: 4, windowMinutes: 7 * 24 * 60 },
			},
		},
	};
	writeFileSync(sessionPath, `${JSON.stringify(sessionHeader)}\n${JSON.stringify(assistantEntry)}\n`, "utf8");
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
		await wait(intervalMs);
	}
	throw new Error(`Timed out waiting for xtui session ${sessionName}`);
}

function readSnap(path: string): SnapFile {
	if (!existsSync(path)) {
		throw new Error(`Snapshot file not found: ${path}`);
	}
	return JSON.parse(readFileSync(path, "utf8")) as SnapFile;
}

function rowText(row: SnapRow): string {
	return row
		.map((cell) => cell.char)
		.join("")
		.replace(/\s+$/g, "");
}

function allRowsText(snap: SnapFile): string[] {
	return snap.screen.cells.map(rowText);
}

function findComposerRows(rows: string[]): { top: number; bottom: number } {
	const top = rows.findIndex((row) => row.includes("gpt-5.4 • medium • fast [openai-codex]"));
	if (top === -1) {
		throw new Error("Composer top border was not found in snapshot");
	}

	for (let index = top + 1; index < rows.length; index++) {
		if (rows[index]?.includes("╯")) {
			return { top, bottom: index };
		}
	}

	throw new Error("Composer bottom border was not found in snapshot");
}

async function snapUntil(
	sessionName: string,
	snapPath: string,
	predicate: (rows: string[]) => boolean,
): Promise<SnapFile> {
	let last: SnapFile | null = null;
	for (let attempt = 0; attempt < 15; attempt++) {
		try {
			xtui(["snap", "--session", sessionName, "--json", "--full", "--out", snapPath]);
			last = readSnap(snapPath);
			if (predicate(allRowsText(last))) {
				return last;
			}
		} catch {
			// Session startup and snapshot capture can race slightly under xtui.
		}
		await wait(200);
	}
	if (last) return last;
	throw new Error(`Unable to capture snapshot for session ${sessionName}`);
}

function startHarness(paths: HarnessPaths, sessionName: string): void {
	const command =
		`HOME=${paths.homeDir} COLORTERM=truecolor ` + `mu --provider openai-codex --model gpt-5.4 --continue`;

	xtui([
		"session",
		"start",
		"--name",
		sessionName,
		"--cmd",
		command,
		"--cwd",
		paths.workspaceDir,
		"--cols",
		"100",
		"--rows",
		"22",
	]);
}

function isRgb(color: SnapColor, r: number, g: number, b: number): boolean {
	return color.type === "rgb" && color.r === r && color.g === g && color.b === b;
}

describe("xtui + mu composer chrome spec", () => {
	const harnesses: HarnessSession[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			try {
				xtui(["session", "stop", "--name", harness.sessionName]);
			} catch {
				// best-effort cleanup
			}
			rmSync(harness.paths.tmpDir, { recursive: true, force: true });
		}
	});

	async function createHarness(): Promise<HarnessSession> {
		const paths = buildHarnessPaths();
		seedMuConfig(paths);
		const sessionName = `mu-composer-chrome-red-${process.pid}-${Date.now()}`;
		startHarness(paths, sessionName);
		await waitForSessionAlive(sessionName);
		const harness = { paths, sessionName };
		harnesses.push(harness);
		return harness;
	}

	it("shows actual mu composer chrome with restored codex model and subscription usage in the border", async () => {
		const harness = await createHarness();
		const snap = await snapUntil(harness.sessionName, harness.paths.snapPath, (rows) =>
			rows.some((row) => row.includes("gpt-5.4 • medium • fast [openai-codex]")),
		);

		const rows = allRowsText(snap);
		const composer = findComposerRows(rows);
		const topRow = rows[composer.top] ?? "";
		const bottomRow = rows[composer.bottom] ?? "";

		expect(topRow).toContain("gpt-5.4 • medium • fast [openai-codex]");
		expect(bottomRow).toContain("(sub) 7% of 272k↖5h 88%↖weekly 96%");
		expect(bottomRow).toContain("pi-mono");
		expect(bottomRow.endsWith("╯")).toBe(true);
	});

	it("renders the active composer cursor as the accent block cursor in actual mu", async () => {
		const harness = await createHarness();
		const snap = await snapUntil(harness.sessionName, harness.paths.snapPath, (rows) =>
			rows.some((row) => row.includes("gpt-5.4 • medium • fast [openai-codex]")),
		);

		const rows = allRowsText(snap);
		const composer = findComposerRows(rows);
		const bodyRows = snap.screen.cells.slice(composer.top + 1, composer.bottom);

		const cursorCell = bodyRows.flat().find((cell) => isRgb(cell.bg, 120, 220, 232));

		expect(cursorCell).toBeDefined();
		expect(isRgb(cursorCell?.bg ?? { type: "default" }, 120, 220, 232)).toBe(true);
		expect(isRgb(cursorCell?.fg ?? { type: "default" }, 24, 28, 32)).toBe(true);
	});

	it("renders blue separator markers between composer usage groups", async () => {
		const harness = await createHarness();
		const snap = await snapUntil(harness.sessionName, harness.paths.snapPath, (rows) =>
			rows.some((row) => row.includes("(sub) 7% of 272k")),
		);

		const rows = allRowsText(snap);
		const composer = findComposerRows(rows);
		const bottomRow = snap.screen.cells[composer.bottom] ?? [];
		const separatorCells = bottomRow.filter((cell) => cell.char === "↖");

		expect(separatorCells.length).toBeGreaterThanOrEqual(2);
		for (const cell of separatorCells) {
			expect(isRgb(cell.fg, 120, 220, 232)).toBe(true);
		}
	});
});
