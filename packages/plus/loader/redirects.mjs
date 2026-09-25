// Redirect map: upstream source file (repo-relative, posix) -> plus wrapper (repo-relative, posix).
// The wrapper must import the original module via a relative path; since the importer then lives
// under packages/plus/, the resolve hook passes it through and no redirect loop occurs.
export const REDIRECTS = new Map([
	["packages/coding-agent/src/core/compaction/compaction.ts", "packages/plus/src/coding-agent/core/compaction/compaction.ts"],
	["packages/coding-agent/src/core/agent-session.ts", "packages/plus/src/coding-agent/core/agent-session.ts"],
	["packages/coding-agent/src/core/model-resolver.ts", "packages/plus/src/coding-agent/core/model-resolver.ts"],
	["packages/coding-agent/src/core/defaults.ts", "packages/plus/src/coding-agent/core/defaults.ts"],
	["packages/coding-agent/src/config.ts", "packages/plus/src/coding-agent/core/config.ts"],
	["packages/coding-agent/src/main.ts", "packages/plus/src/coding-agent/main.ts"],
	["packages/coding-agent/src/cli/args.ts", "packages/plus/src/coding-agent/cli/args.ts"],
	["packages/agent/src/agent.ts", "packages/plus/src/agent/agent.ts"],
	["packages/agent/src/harness/compaction/compaction.ts", "packages/plus/src/agent/harness/compaction/compaction.ts"],
]);
