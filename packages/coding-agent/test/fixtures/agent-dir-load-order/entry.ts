// An entry point built like src/cli.ts: agent-dir-setup.ts first, then a module that reads the agent dir at load.
import "../../../src/cli/agent-dir-setup.ts";
import { agentDirAtLoad } from "./read-at-load.ts";

process.stdout.write(agentDirAtLoad);
