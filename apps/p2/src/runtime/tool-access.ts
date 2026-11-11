// Who may make the agent call a tool, and where (worker): each tool declares it with its registration, and the
// worker's Durable registry checks it before every call, so no tool repeats the checks.
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Extension, ToolExecutionResult, ToolPark, ToolRegistration } from "@earendil-works/pi-durable";
import { isTopLevel } from "./main-conversation.ts";
import { originOf } from "./origin.ts";
import type { LockCapability } from "./session-lock.ts";
import { sessionLock } from "./session-lock-doc.ts";

/** A tool's requirements; both default to `"any"`. */
export type ToolAccess = {
	/** Whose turn may call it: anyone's, or only a turn the owner started (`originOf`). */
	readonly origin?: "any" | "owner";
	/**
	 * Where it works: anywhere; only in the session's top-level conversations (`main`: the main conversation and its
	 * `/tree` branches, never a subagent or one-shot agent); or offered only to subagents, which get it without choosing.
	 */
	readonly scope?: "any" | "main" | "subagent";
	/**
	 * In a locked session (`SessionLock`) the lock replaces the origin check of an `origin: "owner"` tool, whoever's turn
	 * it is: `pass` (the default: what it reaches is limited by the lock elsewhere, MCP servers by their leases, location
	 * tools by the sandbox), `never`, or only when the owner picked the capability.
	 */
	readonly locked?: "pass" | "never" | LockCapability;
};

/** A tool as p2 plugins contribute it: a Durable tool with its requirements. */
export type P2Tool<TParameters extends object = object, TDetails extends JsonValue = JsonValue> = ToolRegistration<
	TParameters,
	TDetails
> &
	ToolAccess;

/** Defines a p2 tool: `defineTool` with the tool's requirements. */
export function defineP2Tool<TParameters extends object, TDetails extends JsonValue = JsonValue>(
	tool: P2Tool<TParameters, TDetails>,
): P2Tool<TParameters, TDetails> {
	return tool;
}

/** `tool` as Durable runs it: unchanged without requirements, else refusing calls that do not meet them. */
export function guardTool(tool: P2Tool): P2Tool {
	if (tool.origin !== "owner" && tool.scope !== "main") return tool;
	return {
		...tool,
		execute: async (args, api, context: Context): Promise<ToolExecutionResult | ToolPark> => {
			if (tool.scope === "main" && !(await isTopLevel(api, api.conversationId, context)))
				return refusal(`${tool.name} works only in the session's main conversation.`);
			if (tool.origin === "owner") {
				const lock = await sessionLock(api, context);
				if (lock) {
					const rule = tool.locked ?? "pass";
					if (rule === "never") return refusal(`${tool.name} is not available in a locked session.`);
					if (rule !== "pass" && !lock.capabilities.includes(rule))
						return refusal(`${tool.name} is not among the resources the owner picked for this session.`);
				} else if ((await originOf(api, context)) !== "owner")
					return refusal(`${tool.name} needs a turn the owner started; guests and what they start cannot use it.`);
			}
			return tool.execute(args, api, context);
		},
	};
}

const refusal = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true });

/** The tools of `extensions` by name, with what they declare. */
export function toolsByName(extensions: ReadonlyMap<string, Extension<P2Tool>>): ReadonlyMap<string, P2Tool> {
	return new Map(
		[...extensions.values()].flatMap((extension) => (extension.tools ?? []).map((tool) => [tool.name, tool])),
	);
}
