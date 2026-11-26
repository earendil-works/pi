import { applyAgentDirArg } from "./agent-dir-arg.ts";

// Entry points import this module first, so modules that read the agent dir when they load see `--agent-dir` as if
// PI_CODING_AGENT_DIR had been set before pi started. main() applies the flag again for callers of the exported
// main(), and reports a missing directory.
applyAgentDirArg(process.argv.slice(2));
