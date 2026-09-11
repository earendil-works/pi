import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sshExtension from "../examples/extensions/ssh.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/index.ts";
import { createBashTool } from "../src/core/tools/bash.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createWriteTool } from "../src/core/tools/write.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

// Use the real source factories without loading the package's built entry point.
vi.mock("@earendil-works/pi-coding-agent", () => ({
	createBashTool: (...args: Parameters<typeof createBashTool>) => createBashTool(...args),
	createEditToolDefinition: (...args: Parameters<typeof createEditToolDefinition>) =>
		createEditToolDefinition(...args),
	createReadTool: (...args: Parameters<typeof createReadTool>) => createReadTool(...args),
	createWriteTool: (...args: Parameters<typeof createWriteTool>) => createWriteTool(...args),
}));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

type ExtensionHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function registerSshExtension(ssh: string | undefined) {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, ExtensionHandler>();
	const pi = {
		registerFlag: vi.fn(),
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		on: (event: string, handler: ExtensionHandler) => handlers.set(event, handler),
		getFlag: () => ssh,
	} as unknown as ExtensionAPI;
	sshExtension(pi);
	return { edit: tools.get("edit")!, handlers };
}

function createContext(cwd: string): ExtensionContext {
	return {
		cwd,
		ui: { theme, setStatus: vi.fn(), notify: vi.fn() },
	} as unknown as ExtensionContext;
}

function createEditRow(edit: ToolDefinition, cwd: string) {
	return new ToolExecutionComponent(
		"edit",
		"ssh-edit",
		{ path: "file.txt", edits: [{ oldText: "before", newText: "after" }] },
		{},
		edit,
		{ requestRender: () => {} } as unknown as TUI,
		cwd,
	);
}

describe("SSH extension example", () => {
	const tempDirs: string[] = [];
	const remote = "example.test";
	const remoteCwd = "/srv/project";

	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		vi.mocked(spawn).mockReset();
		vi.mocked(spawn).mockImplementation((_command, args) => {
			const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
			queueMicrotask(() => {
				const command = Array.isArray(args) ? args[1] : undefined;
				if (command?.startsWith("cat ")) child.stdout.emit("data", Buffer.from("before\n"));
				child.emit("close", 0);
			});
			return child as unknown as ReturnType<typeof spawn>;
		});
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("keeps remote preview and execution aligned when the session cwd differs", async () => {
		const localCwd = process.cwd();
		const context = createContext(resolve(localCwd, "../resumed-project"));
		const { edit, handlers } = registerSshExtension(`${remote}:${remoteCwd}`);
		await handlers.get("session_start")!({}, context);
		const component = createEditRow(edit, context.cwd);
		component.setArgsComplete();
		await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("after"));

		const remotePath = join(localCwd, "file.txt").replace(localCwd, remoteCwd);
		expect(vi.mocked(spawn).mock.calls.map(([, args]) => args)).toEqual([
			[remote, `cat ${JSON.stringify(remotePath)}`],
		]);

		const result = await edit.execute(
			"ssh-edit",
			{ path: "file.txt", edits: [{ oldText: "before", newText: "after" }] },
			undefined,
			undefined,
			context,
		);
		component.updateResult({ ...result, isError: false });
		expect(component.render(80).join("\n")).toContain("after");
		expect(vi.mocked(spawn).mock.calls.map(([, args]) => args)).toEqual([
			[remote, `cat ${JSON.stringify(remotePath)}`],
			[remote, `test -r ${JSON.stringify(remotePath)}`],
			[remote, `cat ${JSON.stringify(remotePath)}`],
			[remote, `echo "YWZ0ZXIK" | base64 -d > ${JSON.stringify(remotePath)}`],
		]);
	});

	it("keeps local preview and execution on the captured cwd without --ssh", async () => {
		const localCwd = await mkdtemp(join(tmpdir(), "pi-ssh-local-"));
		tempDirs.push(localCwd);
		await writeFile(join(localCwd, "file.txt"), "before\n");
		// Only the synchronous extension factory sees this cwd; the host process never changes directories.
		const cwd = vi.spyOn(process, "cwd").mockReturnValue(localCwd);
		let registered: ReturnType<typeof registerSshExtension>;
		try {
			registered = registerSshExtension(undefined);
		} finally {
			cwd.mockRestore();
		}
		const { edit, handlers } = registered;
		const context = createContext(resolve(localCwd, "../different-session"));
		await handlers.get("session_start")!({}, context);
		const component = createEditRow(edit, context.cwd);
		component.setArgsComplete();
		await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("after"));
		await edit.execute(
			"ssh-edit",
			{ path: "file.txt", edits: [{ oldText: "before", newText: "after" }] },
			undefined,
			undefined,
			context,
		);
		expect(await readFile(join(localCwd, "file.txt"), "utf8")).toBe("after\n");
		expect(spawn).not.toHaveBeenCalled();
	});
});
