// Chord v2's plugins component (`@earendil-works/chord/next/plugins` once v2 has its entry point; slice 7c): plugin
// directories found, built into scripts, evaluated, loaded and reloaded per plugin, watched and rolled out. Node-only
// (`fs`, esbuild, `vm`); esbuild is an optional peer dependency, imported only here.

export { type BuildInput, type BuildOptions, type BuiltFacet, buildFacet } from "./build.ts";
export {
	type Discovery,
	type DiscoveryOptions,
	type DiscoveryProblem,
	discoverPlugins,
	type Plugin,
} from "./discover.ts";
export { type BuiltScript, type EvaluateOptions, evaluateFacet, type HostPackages, pluginFile } from "./evaluate.ts";
export { type InstallOptions, installDependencies } from "./install.ts";
export {
	type Built,
	createPlugins,
	type Plugins,
	type PluginsError,
	type PluginsOptions,
	type RolloutResult,
	type RolloutStep,
} from "./plugins.ts";
export { mapStack } from "./stack.ts";
export type { PluginsState } from "./watcher.ts";
