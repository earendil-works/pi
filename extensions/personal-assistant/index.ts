import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemory, runMemoryExtraction, type RunMemoryExtractionOptions, type RunMemoryExtractionResult, type PersonalAssistantConfig } from "./memory.ts";
import { registerTools } from "./tools.ts";
import { registerCron } from "./cron.ts";

export default function (pi: ExtensionAPI) {
  registerMemory(pi);
  registerTools(pi);
  registerCron(pi);
}

export { runMemoryExtraction };
export type { RunMemoryExtractionOptions, RunMemoryExtractionResult, PersonalAssistantConfig };
