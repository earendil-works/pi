import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

async function waitForRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 1000));
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

async function sendKeys(sessionName: string, args: string[], attempts = 10, intervalMs = 100): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			xtui(["send", "--session", sessionName, ...args]);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, intervalMs));
		}
	}
	xtui(["send", "--session", sessionName, ...args]);
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

function findComposerRange(rows: string[]): { start: number; end: number; rows: string[] } {
	const start = rows.findIndex((row) => row.includes("gpt-5.4 • medium [openai-codex]"));
	if (start === -1) {
		throw new Error("Composer label row not found");
	}

	let end = start;
	for (let index = start + 1; index < rows.length; index++) {
		if (rows[index]?.includes("╯")) {
			end = index;
			break;
		}
	}

	return { start, end, rows: rows.slice(start, end + 1) };
}

describe("xtui chat layout spec", () => {
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

	it("shows a sticky boxed composer labeled with model/provider/reasoning above the separate footer", async () => {
		const sessionName = `mu-chat-layout-red-${process.pid}-${Date.now()}`;
		sessionNames.push(sessionName);
		const outDir = mkdtempSync(join(tmpdir(), "mu-chat-layout-red-"));
		tempDirs.push(outDir);
		const snapPath = join(outDir, "screen.json");

		xtui([
			"session",
			"start",
			"--name",
			sessionName,
			"--cmd",
			"OPENAI_API_KEY=test-openai-key npx tsx packages/coding-agent/test/fixtures/chat-layout-xtui.ts",
			"--cwd",
			join(process.cwd(), "..", ".."),
			"--cols",
			"100",
			"--rows",
			"20",
		]);

		await waitForSessionAlive(sessionName);
		await waitForRender();

		const rows = await waitForRows(sessionName, snapPath, (snapshotRows) =>
			snapshotRows.some((row) => row.includes("gpt-5.4 • medium [openai-codex]")),
		);
		const composerRange = findComposerRange(rows);
		const composerRows = composerRange.rows;
		const footerRows = rows.slice(-2);

		expect(composerRows.some((row) => row.includes("gpt-5.4 • medium [openai-codex]"))).toBe(true);
		expect(composerRows.some((row) => /[╭╰│]/.test(row))).toBe(true);
		expect(rows[composerRange.start - 1] ?? "").toBe("");
		expect(footerRows.some((row) => row.includes("gpt-5.4 • medium [openai-codex]"))).toBe(false);
	});

	it("shows a chat scrollbar when chat history overflows the live viewport", async () => {
		const sessionName = `mu-chat-scrollbar-red-${process.pid}-${Date.now()}`;
		sessionNames.push(sessionName);
		const outDir = mkdtempSync(join(tmpdir(), "mu-chat-scrollbar-red-"));
		tempDirs.push(outDir);
		const snapPath = join(outDir, "screen.json");

		xtui([
			"session",
			"start",
			"--name",
			sessionName,
			"--cmd",
			"OPENAI_API_KEY=test-openai-key npx tsx packages/coding-agent/test/fixtures/chat-layout-xtui.ts",
			"--cwd",
			join(process.cwd(), "..", ".."),
			"--cols",
			"100",
			"--rows",
			"20",
		]);

		await waitForSessionAlive(sessionName);
		await waitForRender();

		const rows = await waitForRows(
			sessionName,
			snapPath,
			(snapshotRows) =>
				snapshotRows.some((row) => row.includes("gpt-5.4 • medium [openai-codex]")) &&
				snapshotRows.some((row) => /[█░]/.test(row)),
		);
		const chatRows = rows.slice(0, findComposerRange(rows).start);

		expect(chatRows.some((row) => /[█░]/.test(row))).toBe(true);
	});

	it("scrolls the chat pane and keeps the composer/footer fixed on wheel input", async () => {
		const sessionName = `mu-chat-wheel-red-${process.pid}-${Date.now()}`;
		sessionNames.push(sessionName);
		const outDir = mkdtempSync(join(tmpdir(), "mu-chat-wheel-red-"));
		tempDirs.push(outDir);
		const beforePath = join(outDir, "before.json");
		const afterPath = join(outDir, "after.json");

		xtui([
			"session",
			"start",
			"--name",
			sessionName,
			"--cmd",
			"OPENAI_API_KEY=test-openai-key npx tsx packages/coding-agent/test/fixtures/chat-layout-xtui.ts",
			"--cwd",
			join(process.cwd(), "..", ".."),
			"--cols",
			"100",
			"--rows",
			"20",
		]);

		await waitForSessionAlive(sessionName);
		await waitForRender();

		await waitForRows(
			sessionName,
			beforePath,
			(snapshotRows) => snapshotRows.some((row) => row.includes("XTUI_CHAT_LAYOUT_READY")),
			20,
			100,
		);
		xtui(["send", "--session", sessionName, "--keys-hex", "1b 5b 3c 36 34 3b 39 39 3b 35 4d"]);
		await new Promise((resolve) => setTimeout(resolve, 400));
		await waitForRows(
			sessionName,
			afterPath,
			(snapshotRows) => snapshotRows.some((row) => row.includes("XTUI_CHAT_LAYOUT_READY")),
			20,
			100,
		);

		const beforeRows = readSnapRows(beforePath);
		const afterRows = readSnapRows(afterPath);
		const beforeComposerRange = findComposerRange(beforeRows);
		const afterComposerRange = findComposerRange(afterRows);
		const beforeChatRows = beforeRows.slice(0, beforeComposerRange.start);
		const afterChatRows = afterRows.slice(0, afterComposerRange.start);
		const beforeComposerRows = beforeComposerRange.rows;
		const afterComposerRows = afterComposerRange.rows;
		const beforeFooterRows = beforeRows.slice(-2);
		const afterFooterRows = afterRows.slice(-2);

		expect(afterChatRows).not.toEqual(beforeChatRows);
		expect(afterComposerRows).toEqual(beforeComposerRows);
		expect(afterFooterRows).toEqual(beforeFooterRows);
		expect(afterChatRows.some((row, index) => row !== beforeChatRows[index] && /[█░]/.test(row))).toBe(true);
	});

	it("shows slash commands in a dialog-style palette above the sticky composer when typing slash", async () => {
		const sessionName = `mu-chat-slash-palette-${process.pid}-${Date.now()}`;
		sessionNames.push(sessionName);
		const outDir = mkdtempSync(join(tmpdir(), "mu-chat-slash-palette-"));
		tempDirs.push(outDir);
		const snapPath = join(outDir, "screen.json");

		xtui([
			"session",
			"start",
			"--name",
			sessionName,
			"--cmd",
			"OPENAI_API_KEY=test-openai-key npx tsx packages/coding-agent/test/fixtures/chat-layout-xtui.ts",
			"--cwd",
			join(process.cwd(), "..", ".."),
			"--cols",
			"100",
			"--rows",
			"20",
		]);

		await waitForSessionAlive(sessionName);
		await waitForRender();
		await sendKeys(sessionName, ["--keys", "/"]);

		const initialRows = await waitForRows(
			sessionName,
			snapPath,
			(snapshotRows) =>
				snapshotRows.some((row) => row.includes("Commands")) &&
				snapshotRows.some((row) => row.includes("Search  /")),
			20,
			100,
		);
		await sendKeys(sessionName, ["--keys", "mo"]);
		const rows = await waitForRows(
			sessionName,
			snapPath,
			(snapshotRows) => snapshotRows.some((row) => row.includes("Search  /mo")),
			20,
			100,
		);

		const initialPaletteRows = initialRows.filter(
			(row) => row.includes("Commands") || row.includes("Search  /") || row.includes("/branch"),
		);
		const paletteRows = rows.filter(
			(row) =>
				row.includes("Commands") || row.includes("Search  /mo") || row.includes("/model") || row.includes("/fast"),
		);
		const paletteInteriorRows = rows.filter((row) => row.includes("│"));

		expect(initialPaletteRows.some((row) => row.includes("Commands"))).toBe(true);
		expect(initialPaletteRows.some((row) => row.includes("Search  /"))).toBe(true);
		expect(initialPaletteRows.some((row) => row.includes("/branch"))).toBe(true);
		expect(paletteRows.some((row) => row.includes("Search  /mo"))).toBe(true);
		expect(paletteRows.some((row) => row.includes("/model"))).toBe(true);
		expect(paletteInteriorRows.length).toBeGreaterThanOrEqual(6);
	});

	it("executes the selected slash command directly from the palette on enter", async () => {
		const sessionName = `mu-chat-slash-exec-${process.pid}-${Date.now()}`;
		sessionNames.push(sessionName);
		const outDir = mkdtempSync(join(tmpdir(), "mu-chat-slash-exec-"));
		tempDirs.push(outDir);
		const snapPath = join(outDir, "screen.json");

		xtui([
			"session",
			"start",
			"--name",
			sessionName,
			"--cmd",
			"OPENAI_API_KEY=test-openai-key npx tsx packages/coding-agent/test/fixtures/chat-layout-xtui.ts",
			"--cwd",
			join(process.cwd(), "..", ".."),
			"--cols",
			"100",
			"--rows",
			"20",
		]);

		await waitForSessionAlive(sessionName);
		await waitForRender();
		await sendKeys(sessionName, ["--keys", "/"]);
		await sendKeys(sessionName, ["--keys", "mo"]);
		await sendKeys(sessionName, ["--keys-hex", "0d"]);

		const rows = await waitForRows(
			sessionName,
			snapPath,
			(snapshotRows) => snapshotRows.some((row) => row.includes("Select model")),
			20,
			100,
		);

		expect(rows.some((row) => row.includes("Select model"))).toBe(true);
		expect(rows.some((row) => row.includes("Search  /mo"))).toBe(false);
		expect(rows.some((row) => row.includes("gpt-5.4") && row.includes("[openai-codex]"))).toBe(true);
	});

	it("grows and shrinks the composer with multiline input up to the configured max height", async () => {
		const sessionName = `mu-chat-composer-grow-${process.pid}-${Date.now()}`;
		sessionNames.push(sessionName);
		const outDir = mkdtempSync(join(tmpdir(), "mu-chat-composer-grow-"));
		tempDirs.push(outDir);
		const beforePath = join(outDir, "before.json");
		const grownPath = join(outDir, "grown.json");
		const shrunkPath = join(outDir, "shrunk.json");

		xtui([
			"session",
			"start",
			"--name",
			sessionName,
			"--cmd",
			"OPENAI_API_KEY=test-openai-key npx tsx packages/coding-agent/test/fixtures/chat-layout-xtui.ts",
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
			(snapshotRows) => snapshotRows.some((row) => row.includes("XTUI_CHAT_LAYOUT_READY")),
			20,
			100,
		);

		const beforeRows = readSnapRows(beforePath);
		const beforeComposer = findComposerRange(beforeRows).rows;
		const beforeFooter = beforeRows.slice(-2);

		xtui([
			"send",
			"--session",
			sessionName,
			"--keys-hex",
			"6f 6e 65 1b 0d 74 77 6f 1b 0d 74 68 72 65 65 1b 0d 66 6f 75 72 1b 0d 66 69 76 65",
		]);

		const grownRows = await waitForRows(
			sessionName,
			grownPath,
			(snapshotRows) => findComposerRange(snapshotRows).rows.length > beforeComposer.length,
			20,
			100,
		);
		const grownComposer = findComposerRange(grownRows).rows;
		const grownFooter = grownRows.slice(-2);

		xtui([
			"send",
			"--session",
			sessionName,
			"--keys-hex",
			"08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08 08",
		]);

		const shrunkRows = await waitForRows(
			sessionName,
			shrunkPath,
			(snapshotRows) => findComposerRange(snapshotRows).rows.length === beforeComposer.length,
			20,
			100,
		);
		const shrunkComposer = findComposerRange(shrunkRows).rows;
		const shrunkFooter = shrunkRows.slice(-2);

		expect(grownComposer.length).toBeGreaterThan(beforeComposer.length);
		expect(grownFooter).toEqual(beforeFooter);
		expect(grownComposer.some((row) => /[█░]/.test(row))).toBe(false);
		expect(shrunkComposer.length).toEqual(beforeComposer.length);
		expect(shrunkFooter).toEqual(beforeFooter);
	});

	it("clicks and drags the chat scrollbar while keeping the composer/footer fixed", async () => {
		const sessionName = `mu-chat-drag-red-${process.pid}-${Date.now()}`;
		sessionNames.push(sessionName);
		const outDir = mkdtempSync(join(tmpdir(), "mu-chat-drag-red-"));
		tempDirs.push(outDir);
		const beforePath = join(outDir, "before.json");
		const afterClickPath = join(outDir, "after-click.json");
		const afterDragPath = join(outDir, "after-drag.json");

		xtui([
			"session",
			"start",
			"--name",
			sessionName,
			"--cmd",
			"OPENAI_API_KEY=test-openai-key npx tsx packages/coding-agent/test/fixtures/chat-layout-xtui.ts",
			"--cwd",
			join(process.cwd(), "..", ".."),
			"--cols",
			"100",
			"--rows",
			"20",
		]);

		await waitForSessionAlive(sessionName);
		await waitForRender();

		await waitForRows(
			sessionName,
			beforePath,
			(snapshotRows) => snapshotRows.some((row) => row.includes("XTUI_CHAT_LAYOUT_READY")),
			20,
			100,
		);

		await sendKeys(sessionName, ["--keys-hex", "1b 5b 3c 30 3b 39 39 3b 31 30 4d"]);
		await new Promise((resolve) => setTimeout(resolve, 400));
		await waitForRows(
			sessionName,
			afterClickPath,
			(snapshotRows) => snapshotRows.some((row) => row.includes("XTUI_CHAT_LAYOUT_READY")),
			20,
			100,
		);

		await sendKeys(sessionName, ["--keys-hex", "1b 5b 3c 30 3b 39 39 3b 31 30 4d"]);
		await sendKeys(sessionName, ["--keys-hex", "1b 5b 3c 33 32 3b 39 39 3b 35 4d"]);
		await sendKeys(sessionName, ["--keys-hex", "1b 5b 3c 30 3b 39 39 3b 35 6d"]);
		await new Promise((resolve) => setTimeout(resolve, 400));
		await waitForRows(
			sessionName,
			afterDragPath,
			(snapshotRows) => snapshotRows.some((row) => row.includes("XTUI_CHAT_LAYOUT_READY")),
			20,
			100,
		);

		const beforeRows = readSnapRows(beforePath);
		const afterClickRows = readSnapRows(afterClickPath);
		const afterDragRows = readSnapRows(afterDragPath);
		const beforeComposerRange = findComposerRange(beforeRows);
		const afterClickComposerRange = findComposerRange(afterClickRows);
		const afterDragComposerRange = findComposerRange(afterDragRows);
		const beforeChatRows = beforeRows.slice(0, beforeComposerRange.start);
		const afterClickChatRows = afterClickRows.slice(0, afterClickComposerRange.start);
		const afterDragChatRows = afterDragRows.slice(0, afterDragComposerRange.start);
		const beforeComposerRows = beforeComposerRange.rows;
		const beforeFooterRows = beforeRows.slice(-2);

		expect(afterClickChatRows).not.toEqual(beforeChatRows);
		expect(afterDragChatRows).not.toEqual(afterClickChatRows);
		expect(afterClickComposerRange.rows).toEqual(beforeComposerRows);
		expect(afterDragComposerRange.rows).toEqual(beforeComposerRows);
		expect(afterClickRows.slice(-2)).toEqual(beforeFooterRows);
		expect(beforeRows.slice(-2)).toEqual(beforeFooterRows);
	});

	it("shows explicit selection-mode on/off indicators and lets Ctrl+C exit selection mode", async () => {
		const sessionName = `mu-chat-select-indicator-${process.pid}-${Date.now()}`;
		sessionNames.push(sessionName);
		const outDir = mkdtempSync(join(tmpdir(), "mu-chat-select-indicator-"));
		tempDirs.push(outDir);
		const onPath = join(outDir, "on.json");
		const offPath = join(outDir, "off.json");

		xtui([
			"session",
			"start",
			"--name",
			sessionName,
			"--cmd",
			"OPENAI_API_KEY=test-openai-key npx tsx packages/coding-agent/test/fixtures/chat-layout-xtui.ts",
			"--cwd",
			join(process.cwd(), "..", ".."),
			"--cols",
			"100",
			"--rows",
			"20",
		]);

		await waitForSessionAlive(sessionName);
		await waitForRender();
		await sendKeys(sessionName, ["--keys", "/select"]);
		await new Promise((resolve) => setTimeout(resolve, 250));
		await sendKeys(sessionName, ["--keys-hex", "0d"]);

		const onRows = await waitForRows(
			sessionName,
			onPath,
			(snapshotRows) =>
				snapshotRows.some((row) => row.includes("Selection Mode: On")) &&
				snapshotRows.some((row) => row.includes("Drag with your mouse")) &&
				snapshotRows.some((row) => row.includes("Ctrl+C to return")),
			40,
			150,
		);
		const onText = onRows.join("\n");

		expect(onText).toContain("Selection Mode: On");
		expect(onText).toContain("Drag with your mouse");
		expect(onText).toContain("Ctrl+C to return");

		await sendKeys(sessionName, ["--keys-hex", "03"]);

		const offRows = await waitForRows(
			sessionName,
			offPath,
			(snapshotRows) => snapshotRows.some((row) => row.includes("Selection Mode: Off")),
			40,
			150,
		);

		expect(offRows.join("\n")).toContain("Selection Mode: Off");
	});
});
