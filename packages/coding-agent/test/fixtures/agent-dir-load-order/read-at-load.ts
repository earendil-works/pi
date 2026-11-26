// Reads the agent dir when it loads, as a module-level cache would.
import { getAgentDir } from "../../../src/config.ts";

export const agentDirAtLoad = getAgentDir();
