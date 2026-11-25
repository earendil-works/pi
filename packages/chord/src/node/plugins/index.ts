// Chord v2's plugins component (`@earendil-works/chord/plugins`; slices 7c, 12): plugin directories and single-file
// plugins found, built into scripts checked against the app's API, evaluated, loaded and reloaded per plugin, watched,
// rolled out and installed, and a plugin tested alone. Node-only (`fs`, esbuild, `vm`); esbuild is an optional peer
// dependency, imported only here.

export type { BaseInputs } from "./base-inputs.ts";
export { type AppApi, type BuildInput, type BuildOptions, type BuiltFacet, buildFacet } from "./build.ts";
export {
	type Discovery,
	type DiscoveryOptions,
	type DiscoveryProblem,
	discoverPlugins,
	type Plugin,
	type PluginRoot,
} from "./discover.ts";
export { type BuiltScript, type EvaluateOptions, evaluateFacet, type HostPackages, pluginFile } from "./evaluate.ts";
export {
	type InstallOptions,
	type InstallPluginOptions,
	installDependencies,
	installPlugin,
	type PluginSource,
} from "./install.ts";
export {
	type Built,
	createPlugins,
	type KindDefinition,
	type Plugins,
	type PluginsError,
	type PluginsOptions,
	type RolloutHost,
	type RolloutResult,
	type RolloutStep,
} from "./plugins.ts";
export {
	createPluginRuntime,
	PluginError,
	type PluginRuntime,
	type PluginScript,
	type RuntimeLoad,
} from "./runtime.ts";
export { mapStack } from "./stack.ts";
export { type TestedPlugin, type TestPluginOptions, testPlugin } from "./testing.ts";
export type { PluginsState } from "./watcher.ts";
