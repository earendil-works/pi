import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, type Terminal, Text, TUI } from "@mariozechner/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.js";
import { computeEditsDiff, type Edit } from "../src/core/tools/edit-diff.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

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

	get fullClearCount(): number {
		return this.writes.filter((write) => write.includes("\x1b[2J\x1b[H\x1b[3J")).length;
	}
}

async function waitForRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function createLargeEdits(lines: string[]): Edit[] {
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
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("renders the large diff only in the settled result without triggering a full TUI redraw", async () => {
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
		const diff = await computeEditsDiff(filePath, edits, process.cwd());
		if ("error" in diff) {
			throw new Error(diff.error);
		}

		const terminal = new FakeTerminal();
		const tui = new TUI(terminal);
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

		const callOnlyRender = component.render(80).join("\n");
		expect(callOnlyRender).toContain("edit");
		expect(callOnlyRender).not.toContain("line 50 changed");
		expect(callOnlyRender).not.toContain("+  51");

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
	});
});
