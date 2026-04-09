import askUserExtension from "./presets/ask-user.js";
import mcpExtension from "./presets/mcp.js";
import type { ExtensionFactory } from "./types.js";

export interface BuiltInExtensionRegistration {
	sourceId: string;
	factory: ExtensionFactory;
}

export const builtInExtensions: BuiltInExtensionRegistration[] = [
	{
		sourceId: "preset:ask-user",
		factory: askUserExtension,
	},
	{
		sourceId: "preset:mcp",
		factory: mcpExtension,
	},
];
