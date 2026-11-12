import type { InlineExtension } from "../core/extensions/types.ts";
import askExtension from "./ask/index.ts";
import autoNameExtension from "./auto-name/index.ts";
import btwExtension from "./btw/index.ts";
import codemodeExtension from "./codemode/index.ts";
import fastExtension from "./fast/index.ts";
import jobsExtension from "./jobs/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import recallExtension from "./recall/index.ts";
import recoveryExtension from "./recovery/index.ts";
import rexExtension from "./rex/index.ts";
import subagentsExtension from "./subagents/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "ask", factory: askExtension, replaceable: true, builtin: true },
	{ name: "auto-name", factory: autoNameExtension, builtin: true },
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
	{ name: "fast", factory: fastExtension, replaceable: true, builtin: true },
	{ name: "jobs", factory: jobsExtension, replaceable: true, builtin: true },
	{ name: "rex", factory: rexExtension, replaceable: true, builtin: true },
	{ name: "btw", factory: btwExtension, replaceable: true, builtin: true },
	{ name: "recall", factory: recallExtension, replaceable: true, builtin: true },
	{ name: "subagents", factory: subagentsExtension, replaceable: true, builtin: true },
	{ name: "recovery", factory: recoveryExtension, replaceable: true, builtin: true },
];
