import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";

const highlightedLines = vi.hoisted(() => ({ count: 0 }));

vi.mock("../src/utils/syntax-highlight.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/utils/syntax-highlight.ts")>();
	return {
		...original,
		highlight: (code: string, options: Parameters<typeof original.highlight>[1]) => {
			highlightedLines.count += code.split("\n").length;
			return original.highlight(code, options);
		},
	};
});

import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function createToolComponent(
	name: string,
	args: Record<string, unknown>,
	definition: ToolDefinition<any, any>,
): ToolExecutionComponent {
	return new ToolExecutionComponent(
		name,
		`tool-${name}-cache`,
		args,
		{},
		definition,
		{ requestRender: () => {} } as unknown as TUI,
		process.cwd(),
	);
}

function createComponent(command: string): ToolExecutionComponent {
	return createToolComponent(
		"bash",
		{ command },
		createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false }),
	);
}

describe("streaming call highlighting", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("highlights streamed heredocs incrementally and reuses the result for output updates", () => {
		const header = "cat > src/lib.rs <<'EOF'\n";
		const bodyLines = Array.from({ length: 400 }, (_, i) => `fn f${i}() -> u32 { ${i} }`);
		const command = `${header}${bodyLines.join("\n")}\nEOF`;

		const component = createComponent(header);
		component.setExpanded(true);
		highlightedLines.count = 0;
		for (let i = 1; i <= bodyLines.length; i++) {
			component.updateArgs({ command: `${header}${bodyLines.slice(0, i).join("\n")}\n` });
		}
		component.updateArgs({ command });
		// Each update highlights its new line plus a bounded prefix; a full rehighlight per update
		// would cost 400 * 401 / 2 = 80,200 lines.
		expect(highlightedLines.count).toBeLessThan(bodyLines.length * 60);

		component.setArgsComplete();
		component.markExecutionStarted();
		const final = component.render(200);
		const fresh = createComponent(command);
		fresh.setExpanded(true);
		fresh.setArgsComplete();
		fresh.markExecutionStarted();
		expect(final).toEqual(fresh.render(200));

		highlightedLines.count = 0;
		for (let i = 0; i < 10; i++) {
			component.updateResult({ content: [{ type: "text", text: `line ${i}` }], isError: false }, true);
		}
		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		expect(highlightedLines.count).toBe(0);
	});

	test("highlights streamed write content incrementally and fully once complete", () => {
		const definition = createWriteToolDefinition(process.cwd());
		const contentLines = Array.from({ length: 400 }, (_, i) => `const s${i} = \`multi`);
		const content = `${contentLines.join("\n")}\n`;

		const component = createToolComponent("write", { path: "src/a.ts", content: "" }, definition);
		component.setExpanded(true);
		highlightedLines.count = 0;
		for (let i = 1; i <= contentLines.length; i++) {
			component.updateArgs({ path: "src/a.ts", content: `${contentLines.slice(0, i).join("\n")}\n` });
		}
		expect(highlightedLines.count).toBeLessThan(contentLines.length * 60);

		// The unterminated template literal spans lines, so only a full highlight matches a fresh render.
		component.setArgsComplete();
		const fresh = createToolComponent("write", { path: "src/a.ts", content }, definition);
		fresh.setExpanded(true);
		fresh.setArgsComplete();
		expect(component.render(200)).toEqual(fresh.render(200));

		highlightedLines.count = 0;
		component.updateResult({ content: [{ type: "text", text: "ok" }], isError: false }, false);
		expect(highlightedLines.count).toBe(0);
	});
});
