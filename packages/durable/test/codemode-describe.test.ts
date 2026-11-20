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
import {
	codemodeDescription,
	codemodeSection,
	listableNamespaces,
	namespacesOf,
} from "../src/codemode/describe.ts";
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

const LINEAR: ToolNamespace = { name: "linear", description: "Linear: sign in first." };

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

	it("puts a tool in its winning extension's namespace; the last extension naming a tool wins", () => {
		const issues = tool("list_issues", "List issues.");
		const shared = tool("read", "Read a file.");
		const map = namespacesOf([extension("coding", [shared]), extension("github", [issues, shared], GITHUB)]);
		expect(map.get("list_issues")).toBe(GITHUB);
		// Durable composes `read` from `github`, the last extension naming it: its namespace is the one that runs.
		expect(map.get("read")).toBe(GITHUB);
		// The last extension naming `read` declares no namespace: the winning tool is ungrouped.
		expect(
			namespacesOf([extension("github", [issues, shared], GITHUB), extension("coding", [shared])]).has("read"),
		).toBe(false);
	});

	it("lists namespaces by structural reachability, not by state", () => {
		const read = tool("read", "Read a file.");
		const issues = tool("list_issues", "List issues.");
		const modelOnly = tool("get_issue", "Get an issue.", { callers: ["model"] });
		const extensions = [
			extension("coding", [read]),
			extension("github", [issues, modelOnly], GITHUB),
			extension("linear", [], LINEAR),
		];
		// `github` has a callable tool; `linear` declares none yet; both are listed, sorted by name.
		expect(listableNamespaces(extensions, [read, issues])).toEqual([LINEAR, GITHUB]);
		// `github` declares tools but none is callable, `linear` still declares none: only `linear` is listed.
		expect(listableNamespaces(extensions, [read])).toEqual([LINEAR]);
		expect(listableNamespaces(extensions, [])).toEqual([LINEAR]);
	});

	it("lists ungrouped tools first, then each namespace's heading and description, then its declarations", () => {
		const read = tool("read", "Read a file.");
		const issues = tool("list_issues", "List issues.");
		const section = codemodeSection(
			[read, issues],
			[extension("coding", [read]), extension("github", [issues], GITHUB)],
			3000,
			[read, issues],
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
		const section = codemodeSection([], [extension("github", [], GITHUB)], 3000, [])!;
		expect(section).toContain("## mcp__github\nGitHub MCP server");
		expect(codemodeSection([], [extension("coding", [])], 3000, [])).toBeUndefined();
	});

	it("hides a namespace whose declared tools are not callable (callers, or an allowlist)", () => {
		const read = tool("read", "Read a file.");
		const modelOnly = tool("get_issue", "Get an issue.", { callers: ["model"] });
		const section = codemodeSection(
			[read],
			[extension("coding", [read]), extension("github", [modelOnly], GITHUB), extension("linear", [], LINEAR)],
			3000,
			[read],
		)!;
		expect(section).not.toContain("## mcp__github");
		expect(section).not.toContain("GitHub MCP server");
		expect(section).toContain("## linear");
		expect(section).toContain("### `read`");
		// The allowlist leaves the namespace's only tool out: no callable tool, so no heading, and no section at all
		// without other tools.
		const issues = tool("list_issues", "List issues.");
		expect(codemodeSection([], [extension("github", [issues], GITHUB)], 3000, [])).toBeUndefined();
	});

	it("keeps the section identical before and after a namespace's (deferred) tools appear", () => {
		const read = tool("read", "Read a file.");
		const before = codemodeSection([read], [extension("coding", [read]), extension("github", [], GITHUB)], 3000, [
			read,
		]);
		// The server connected: its tools are installed, deferred, and callable by scripts.
		const issues = tool("list_issues", "List issues.", { deferred: true });
		const extensions = [extension("coding", [read]), extension("github", [issues], GITHUB)];
		// The section declares the non-deferred callable tools; `callable` includes the deferred ones, so the namespace
		// stays listed before and after they appear.
		const after = codemodeSection([read], extensions, 3000, [read, issues]);
		expect(after).toBe(before);
	});

	it("lists what fits the budget, every namespace before any is complete, with no counts in headings", () => {
		const github = Array.from({ length: 30 }, (_, index) => tool(`tool${index}`, "x".repeat(200)));
		const read = tool("read", "Read a file.");
		const extensions = [extension("coding", [read]), extension("github", github, GITHUB)];
		const section = codemodeSection([read, ...github], extensions, 400, [read, ...github])!;
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
