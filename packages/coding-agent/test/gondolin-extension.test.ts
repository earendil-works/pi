import { fileURLToPath } from "node:url";
import type { TUI } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, ToolDefinition } from "../src/core/extensions/index.ts";
import * as tools from "../src/core/tools/index.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

type ExtensionHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

describe("Gondolin edit routing", () => {
	beforeAll(() => initTheme("dark"));

	it.each([
		{ path: "file.txt", guestPath: "/workspace/file.txt" },
		{ path: "../file.txt", guestPath: "/file.txt" },
	])("uses guest cwd for preview and execution of $path", async ({ path, guestPath }) => {
		const fs = {
			readFile: vi.fn(async (_path: string) => Buffer.from("before\n")),
			access: vi.fn(async (_path: string) => {}),
			writeFile: vi.fn(async (_path: string, _content: string, _options: { encoding: string }) => {}),
		};
		const vm = { id: "test-vm", fs, exec: async () => ({ stdout: "/bin/sh\n" }), close: vi.fn(async () => {}) };
		const createVm = vi.fn(async () => vm);
		// Load like an extension so the optional VM dependency stays outside the root TypeScript graph.
		const jiti = createJiti(import.meta.url, {
			moduleCache: false,
			virtualModules: {
				"@earendil-works/pi-coding-agent": tools,
				"@earendil-works/gondolin": { VM: { create: createVm }, RealFSProvider: vi.fn() },
			},
		});
		const extension = await jiti.import<ExtensionFactory>(
			fileURLToPath(new URL("../examples/extensions/gondolin/index.ts", import.meta.url)),
			{ default: true },
		);
		const registeredTools = new Map<string, ToolDefinition>();
		const handlers = new Map<string, ExtensionHandler>();
		await extension({
			registerTool: (tool: ToolDefinition) => registeredTools.set(tool.name, tool),
			registerCommand: vi.fn(),
			on: (event: string, handler: ExtensionHandler) => handlers.set(event, handler),
		} as unknown as ExtensionAPI);
		expect(createVm).not.toHaveBeenCalled();

		const context = {
			cwd: process.cwd(),
			ui: { theme, setStatus: vi.fn(), notify: vi.fn() },
		} as unknown as ExtensionContext;
		await handlers.get("session_start")!({}, context);
		try {
			const edit = registeredTools.get("edit")!;
			const args = { path, edits: [{ oldText: "before", newText: "after" }] };
			const component = new ToolExecutionComponent(
				"edit",
				"gondolin-edit",
				args,
				{},
				edit,
				{ requestRender: () => {} } as unknown as TUI,
				context.cwd,
			);
			component.setArgsComplete();
			await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("after"));
			expect(fs.readFile.mock.calls).toEqual([[guestPath]]);
			expect(fs.access).not.toHaveBeenCalled();
			expect(fs.writeFile).not.toHaveBeenCalled();

			const result = await edit.execute("gondolin-edit", args, undefined, undefined, context);
			component.updateResult({ ...result, isError: false });
			expect(component.render(80).join("\n")).toContain("after");
			expect(fs.readFile.mock.calls).toEqual([[guestPath], [guestPath]]);
			expect(fs.access.mock.calls).toEqual([[guestPath]]);
			expect(fs.writeFile.mock.calls).toEqual([[guestPath, "after\n", { encoding: "utf8" }]]);
			expect(createVm).toHaveBeenCalledOnce();
		} finally {
			await handlers.get("session_shutdown")!({}, context);
		}
		expect(vm.close).toHaveBeenCalledOnce();
	});
});
