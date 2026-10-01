// Redirect map for the pi-plus CLI (source-mode loader + CLI bundle): the shared core
// table (packages/plus/loader/redirects.mjs) plus the CLI-only wrappers that live in
// this package. The pi-plus-sdk bundle (packages/plus-api) uses the core table only,
// with its own main.ts redirect to a stub — it must not pick up any CLI logic.
import { REDIRECTS as CORE_REDIRECTS } from "../../plus/loader/redirects.mjs";

export const REDIRECTS = new Map([
	...CORE_REDIRECTS,
	["packages/coding-agent/src/main.ts", "packages/plus-cli/src/coding-agent/main.ts"],
	["packages/coding-agent/src/cli/args.ts", "packages/plus-cli/src/coding-agent/cli/args.ts"],
	[
		"packages/coding-agent/src/modes/interactive/components/settings-selector.ts",
		"packages/plus-cli/src/coding-agent/ui/settings-selector.ts",
	],
]);
