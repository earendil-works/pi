import type { AgentTool } from "@mariozechner/pi-ai";

export { bashTool } from "./bash.js";
export { editTool } from "./edit.js";
export { readTool } from "./read.js";
export { writeTool } from "./write.js";

import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";

export const codingTools: AgentTool<any>[] = [readTool, bashTool, editTool, writeTool];
