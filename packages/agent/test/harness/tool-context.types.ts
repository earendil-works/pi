import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { createReadTool } from "../../src/harness/tools/read.ts";
import type { ExecutionToolContext } from "../../src/harness/tools/tool-context.ts";
import type { Session } from "../../src/harness/types.ts";

declare const models: Models;
declare const model: Model<Api>;
declare const session: Session;
declare const toolContext: ExecutionToolContext;

const readTool = createReadTool();

new AgentHarness({ models, model, session, tools: [readTool], toolContext });

// @ts-expect-error Context-requiring tools must be paired with toolContext.
new AgentHarness({ models, model, session, tools: [readTool] });
