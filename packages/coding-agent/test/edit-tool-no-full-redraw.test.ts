import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, type Terminal, Text, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { createEditToolDefinition, type EditOperations } from "../src/core/tools/edit.ts";
import * as editDiff from "../src/core/tools/edit-diff.ts";
import { withBuiltInRenderers } from "../src/core/tools/renderers/index.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = true;
	writes: string[] = [];

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}

	get fullClearCount(): number {
		return this.writes.filter((write) => write.includes("\x1b[2J\x1b[H\x1b[3J")).length;
	}
}

async function waitForRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForRenderedText(
	getRender: () => string,
	expectedText: string,
	onRetry?: () => void,
	timeoutMs = 2000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let lastRender = "";
	while (Date.now() < deadline) {
		onRetry?.();
		await waitForRender();
		lastRender = getRender();
		if (lastRender.includes(expectedText)) {
			return lastRender;
		}
	}
	throw new Error(`Timed out waiting for render to include "${expectedText}". Last render:\n${lastRender}`);
}

function createLargeEdits(lines: string[]): editDiff.Edit[] {
	const targets = [50, 150, 250, 350, 450, 550, 650, 750, 850, 950];
	return targets.map((lineNumber) => ({
		oldText: `${lines[lineNumber - 1]}\n${lines[lineNumber]}\n${lines[lineNumber + 1]}`,
		newText: `${lines[lineNumber - 1]}\n${lines[lineNumber]} changed\n${lines[lineNumber + 1]}`,
	}));
}

describe("edit tool TUI rendering", () => {
	const tempDirs: string[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("renders the large diff in the call preview and does not full-redraw when the result settles", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-redraw-"));
		tempDirs.push(dir);
		const filePath = join(dir, "large-edit.txt");
		await writeFile(
			filePath,
			`${Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n")}
`,
			"utf8",
		);
		const lines = (await readFile(filePath, "utf8")).trimEnd().split("\n");
		const edits = createLargeEdits(lines);
		const diff = await editDiff.computeEditsDiff(filePath, edits, process.cwd());
		if ("error" in diff) {
			throw new Error(diff.error);
		}

		const terminal = new FakeTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		const root = new Container();
		for (let i = 0; i < 200; i++) {
			root.addChild(new Text(`history ${i}`, 0, 0));
		}

		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-1",
			{ path: filePath, edits },
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		root.addChild(component);
		tui.addChild(root);
		tui.start();
		await waitForRender();

		component.setArgsComplete();
		tui.requestRender();
		await waitForRender();
		await waitForRender();

		const callOnlyRender = await waitForRenderedText(
			() => component.render(80).join("\n"),
			"line 50 changed",
			() => tui.requestRender(true),
		);
		expect(callOnlyRender).toContain("edit");
		expect(callOnlyRender).toContain("line 950 changed");

		const redrawsBeforeResult = tui.fullRedraws;
		const clearsBeforeResult = terminal.fullClearCount;
		component.updateResult(
			{
				content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${filePath}.` }],
				details: diff,
				isError: false,
			},
			false,
		);
		tui.requestRender();
		await waitForRender();

		expect(tui.fullRedraws).toBe(redrawsBeforeResult);
		expect(terminal.fullClearCount).toBe(clearsBeforeResult);

		const settledRender = component.render(80).join("\n");
		expect(settledRender).toContain("line 50 changed");
		expect(settledRender).toContain("line 950 changed");
		expect(settledRender).not.toContain("Successfully replaced");
	});

	it("reconstructs the boxed preview from a settled result without argsComplete", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-replay-"));
		tempDirs.push(dir);
		const filePath = join(dir, "replay-edit.txt");
		await writeFile(
			filePath,
			`${Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")}
`,
			"utf8",
		);
		const lines = (await readFile(filePath, "utf8")).trimEnd().split("\n");
		const edits = createLargeEdits(lines).slice(0, 2);
		const diff = await editDiff.computeEditsDiff(filePath, edits, process.cwd());
		if ("error" in diff) {
			throw new Error(diff.error);
		}
		await rm(filePath, { force: true });

		const terminal = new FakeTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-replay",
			{ path: filePath, edits },
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		tui.addChild(component);
		tui.start();
		await waitForRender();

		component.updateResult(
			{
				content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${filePath}.` }],
				details: diff,
				isError: false,
			},
			false,
		);
		await waitForRender();
		await waitForRender();

		const rendered = component.render(80).join("\n");
		expect(rendered).toContain("line 50 changed");
		expect(rendered).toContain("line 150 changed");
	});

	it("uses injected edit operations for the call preview", async () => {
		const filePath = "/remote/workspace/file.txt";
		const accessedPaths: string[] = [];
		const readPaths: string[] = [];
		const operations: EditOperations = {
			access: async (path) => {
				accessedPaths.push(path);
			},
			readFile: async (path) => {
				readPaths.push(path);
				return Buffer.from("before\n");
			},
			writeFile: async () => {},
		};
		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-remote-preview",
			{ path: filePath, edits: [{ oldText: "before", newText: "after" }] },
			{},
			createEditToolDefinition(process.cwd(), { operations }),
			{ requestRender: () => {} } as unknown as TUI,
			process.cwd(),
		);
		component.setArgsComplete();
		await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("after"));

		expect(accessedPaths).toEqual([]);
		expect(readPaths).toEqual([filePath]);
		expect(component.render(80).join("\n")).not.toContain("Could not edit file");
	});

	it.each([
		{ customResult: false, isError: false },
		{ customResult: false, isError: true },
		{ customResult: true, isError: false },
		{ customResult: true, isError: true },
	])(
		"ignores late previews after settlement (customResult=$customResult, isError=$isError)",
		async ({ customResult, isError }) => {
			const filePath = "/remote/workspace/slow.txt";
			let resolveRead!: (content: Buffer) => void;
			const pendingRead = new Promise<Buffer>((resolve) => {
				resolveRead = resolve;
			});
			const readFile = vi.fn(() => pendingRead);
			const operations: EditOperations = {
				access: async () => {},
				readFile,
				writeFile: async () => {},
			};
			const definition = createEditToolDefinition(process.cwd(), { operations });
			if (customResult) definition.renderResult = () => new Text("Custom result", 0, 0);
			const component = new ToolExecutionComponent(
				"edit",
				"tool-call-late-preview",
				{ path: filePath, edits: [{ oldText: "before", newText: "after" }] },
				{},
				definition,
				{ requestRender: () => {} } as unknown as TUI,
				process.cwd(),
			);
			component.setArgsComplete();
			expect(readFile).toHaveBeenCalledOnce();
			component.updateResult(
				{
					content: [{ type: "text", text: isError ? "Operation aborted" : "Successfully replaced 1 block." }],
					details: isError
						? undefined
						: { ...editDiff.generateDiffString("settled before\n", "settled after\n"), patch: "" },
					isError,
				},
				false,
			);
			component.setExpanded(true);
			component.setExpanded(false);
			resolveRead(Buffer.from("preview-only context\nbefore\n"));
			await waitForRender();

			const rendered = component.render(80).join("\n");
			expect(readFile).toHaveBeenCalledOnce();
			expect(rendered).toContain(customResult ? "Custom result" : isError ? "Operation aborted" : "settled after");
			expect(rendered).not.toContain("preview-only context");
		},
	);

	it("does not start a preview for a settled row with a custom result renderer", () => {
		const readFile = vi.fn(async () => Buffer.from("before\n"));
		const definition = createEditToolDefinition(process.cwd(), {
			operations: { readFile, access: async () => {}, writeFile: async () => {} },
		});
		definition.renderResult = () => new Text("Custom result", 0, 0);
		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-already-settled",
			{ path: "file.txt", edits: [{ oldText: "before", newText: "after" }] },
			{},
			definition,
			{ requestRender: () => {} } as unknown as TUI,
			process.cwd(),
		);
		component.updateResult({ content: [], isError: true });
		component.setArgsComplete();
		component.setExpanded(true);
		expect(readFile).not.toHaveBeenCalled();
		expect(component.render(80).join("\n")).toContain("Custom result");
	});

	it("does not read files when an edit definition opts out of call previews", () => {
		const preview = vi.spyOn(editDiff, "computeEditsDiff");
		const readFile = vi.fn(async () => Buffer.from("before\n"));
		const definition = createEditToolDefinition(process.cwd(), {
			operations: { readFile, access: async () => {}, writeFile: async () => {} },
		});
		const filePath = "/remote-only/missing.txt";
		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-renderer-only",
			{ path: filePath, edits: [{ oldText: "before", newText: "after" }] },
			{},
			withBuiltInRenderers("edit", { ...definition, renderCall: undefined } as ToolDefinition),
			{ requestRender: () => {} } as unknown as TUI,
			process.cwd(),
		);

		component.setArgsComplete();
		expect(preview).not.toHaveBeenCalled();
		expect(readFile).not.toHaveBeenCalled();

		const diff = editDiff.generateDiffString("before\n", "after\n");
		component.updateResult({
			content: [{ type: "text", text: "Successfully replaced 1 block." }],
			details: { ...diff, patch: "" },
			isError: false,
		});
		component.setExpanded(true);
		expect(component.render(80).join("\n")).toContain("after");
		expect(preview).not.toHaveBeenCalled();
		expect(readFile).not.toHaveBeenCalled();
	});

	it("shows a preflight error without rendering a diff when the edits do not apply", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-preflight-"));
		tempDirs.push(dir);
		const filePath = join(dir, "missing-edit.txt");
		await writeFile(filePath, "line 0\nline 1\n", "utf8");

		const terminal = new FakeTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-2",
			{ path: filePath, edits: [{ oldText: "does not exist", newText: "replacement" }] },
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		tui.addChild(component);
		tui.start();
		await waitForRender();

		component.setArgsComplete();
		tui.requestRender();
		await waitForRender();
		await waitForRender();

		const rendered = await waitForRenderedText(
			() => component.render(80).join("\n"),
			"Could not find",
			() => tui.requestRender(true),
		);
		expect(rendered).not.toContain("+1 ");
		expect(rendered).not.toContain("-1 ");
	});
});
