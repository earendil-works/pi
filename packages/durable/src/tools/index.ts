import { defineExtension } from "../harness/define.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";

export {
	type BashExecution,
	type BashPrepare,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
} from "./bash.ts";
export { createEditTool, type EditToolDetails, type EditToolInput } from "./edit.ts";
export { createReadTool, type ReadToolDetails, type ReadToolInput } from "./read.ts";
export { createWriteTool, type WriteToolInput } from "./write.ts";

/** `read`, `write`, `edit`, and `bash`; nothing installs it automatically. */
export const CodingTools = defineExtension({
	name: "coding-tools",
	tools: [createReadTool(), createWriteTool(), createEditTool(), createBashTool()],
});
