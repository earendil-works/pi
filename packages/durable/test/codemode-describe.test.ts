import { type AssistantMessage, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { CODEMODE_SOURCE_GRAMMAR } from "@earendil-works/pi-codemode/source";
import {
	defineExtension,
	defineTool,
	type Extension,
	MemoryStorage,
	type ToolNamespace,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import { createCodemodeExtension } from "../src/codemode/codemode.ts";
import { codemodeDescription, codemodeSection, namespacesOf } from "../src/codemode/describe.ts";
import { allEntries, chatSetup, openChat } from "./chat-support.ts";
import { context } from "./session-support.ts";

function tool(name: string, description: string, extra: Partial<ToolRegistration> = {}): ToolRegistration {
	return defineTool({
		name,
		description,
		parameters: obj({ path: str({ description: "File path" }) }),
		execute: async () => ({ output: [] }),
		...extra,
	});
}

const GITHUB: ToolNamespace = {
	name: "mcp__github",
	description: "GitHub MCP server",
	instructions: "Pass repositories as owner/name.",
};

/** An extension bringing `tools`, in `namespace` when given. */
function extension(name: string, tools: ToolRegistration[], namespace?: ToolNamespace): Extension {
	return defineExtension({ name, tools, ...(namespace ? { namespace } : {}) });
}

describe("code mode description and section", () => {
	it("keeps the tool description the same for every conversation", () => {
		const text = codemodeDescription(false);
		expect(text).toContain("`await tools.<name>({ ...args })`");
		expect(text).toContain("searchTools(query");
		expect(text).toContain("The `codemode` section of the system prompt lists the tools scripts can call");
		expect(text).not.toContain("`models`");
		expect(codemodeDescription(true)).toContain("`models`");
	});

	it("puts a tool in its extension's namespace; the first extension naming a tool wins", () => {
		const issues = tool("list_issues", "List issues.");
		const shared = tool("read", "Read a file.");
		const map = namespacesOf([extension("coding", [shared]), extension("github", [issues, shared], GITHUB)]);
		expect(map.get("list_issues")).toBe(GITHUB);
		// `read` came first from an extension without a namespace: ungrouped.
		expect(map.has("read")).toBe(false);
		expect(
			namespacesOf([extension("github", [issues, shared], GITHUB), extension("coding", [shared])]).get("read"),
		).toBe(GITHUB);
	});

	it("lists ungrouped tools first, then each namespace's heading and description, then its declarations", () => {
		const read = tool("read", "Read a file.");
		const issues = tool("list_issues", "List issues.");
		const section = codemodeSection(
			[read, issues],
			[extension("coding", [read]), extension("github", [issues], GITHUB)],
			3000,
		)!;
		expect(section).toContain("### `read`\nRead a file.");
		expect(section).toContain("read(args: {");
		expect(section).toContain("## mcp__github\nGitHub MCP server");
		// Instructions only through describeNamespace().
		expect(section).not.toContain("owner/name");
		expect(section.indexOf("### `read`")).toBeLessThan(section.indexOf("## mcp__github"));
		expect(section.indexOf("## mcp__github")).toBeLessThan(section.indexOf("### `list_issues`"));
		expect(section).toContain("Promise<string>");
	});

	it("lists a namespace without tools, and nothing without tools and namespaces", () => {
		const section = codemodeSection([], [extension("github", [], GITHUB)], 3000)!;
		expect(section).toContain("## mcp__github\nGitHub MCP server");
		expect(codemodeSection([], [extension("coding", [])], 3000)).toBeUndefined();
	});

	it("keeps the section identical before and after a namespace's (deferred) tools appear", () => {
		const read = tool("read", "Read a file.");
		const before = codemodeSection([read], [extension("coding", [read]), extension("github", [], GITHUB)], 3000);
		// The server connected: its tools are installed, deferred, and callable by scripts.
		const issues = tool("list_issues", "List issues.", { deferred: true });
		const extensions = [extension("coding", [read]), extension("github", [issues], GITHUB)];
		// The section's caller passes the non-deferred callable tools (deferred ones are found with searchTools()).
		const after = codemodeSection([read], extensions, 3000);
		expect(after).toBe(before);
	});

	it("lists what fits the budget, every namespace before any is complete, with no counts in headings", () => {
		const github = Array.from({ length: 30 }, (_, index) => tool(`tool${index}`, "x".repeat(200)));
		const read = tool("read", "Read a file.");
		const extensions = [extension("coding", [read]), extension("github", github, GITHUB)];
		const section = codemodeSection([read, ...github], extensions, 400)!;
		expect(section).toContain("### `read`");
		expect(section).toContain("Some tools are not listed: find them with `searchTools()`.");
		expect(section).toContain("## mcp__github\nGitHub MCP server");
		expect(section).not.toContain("tool29");
		expect(section).not.toContain("not listed)");
	});

	it("renders the section from the conversation's extensions and callable tools into the system prompt", async () => {
		const setup = chatSetup();
		setup.registry.install(createCodemodeExtension({ sandbox: new CodemodeSandbox() }));
		setup.registry.install({ name: "tools", tools: [tool("read", "Read a file.")] });
		setup.registry.install({
			name: "mcp:github",
			namespace: GITHUB,
			tools: [
				tool("list_issues", "List issues.", { callers: ["tools"] }),
				tool("get_issue", "Get an issue.", { deferred: true }),
			],
		});
		setup.faux.setResponses([fauxAssistantMessage([fauxText("hi")]) as AssistantMessage]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const system = (await allEntries(root)).find((entry) => entry.kind === "pi.system")!;
		const sections = (system.model![0] as { sections?: Record<string, string> }).sections!;
		expect(sections.codemode).toContain("### `read`");
		expect(sections.codemode).toContain("## mcp__github\nGitHub MCP server");
		expect(sections.codemode).toContain("### `list_issues`");
		// Deferred tools are found with searchTools(), not listed.
		expect(sections.codemode).not.toContain("get_issue");
		// The code mode tool itself is not callable from scripts.
		expect(sections.codemode).not.toContain("### `codemode`");
		// The tool declaration carries the script grammar; pi-ai applies it only for models that support it.
		const tools = (system.model![0] as { toolsAdded?: { name: string; constrainedSampling?: unknown }[] })
			.toolsAdded!;
		expect(tools.find((candidate) => candidate.name === "codemode")?.constrainedSampling).toEqual({
			type: "grammar",
			variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR },
		});
		await harness.close(context);
	});
});
