import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerMemory,
  runMemoryExtraction,
  type RunMemoryExtractionOptions,
  type RunMemoryExtractionResult,
  type PersonalAssistantConfig,
  // 1.1+1.2+1.3+1.4+1.5b 新增:
  MemoryIndex,
  type MemoryAtom,
  type MemoryAtomType,
  type QueryRewriteResult,
  writeAtomToFile,
  readAtomFromFile,
  searchAtoms,
  rewriteQuery,
  getAllAtoms,
  rewriteQueryWithCallLlm,
  searchAtomsWithScores,
  MEMORY_DB_PATH,
  ATOMS_DIR,
} from "./memory.ts";
import { registerTools } from "./tools.ts";
import { registerCron } from "./cron.ts";
import { registerAskUserQuestion } from "./ask_user_question.ts";

export default function (pi: ExtensionAPI) {
  registerMemory(pi);
  registerTools(pi);
  registerCron(pi);
  registerAskUserQuestion(pi);
}

export { runMemoryExtraction };
export {
  MemoryIndex,
  writeAtomToFile,
  readAtomFromFile,
  searchAtoms,
  rewriteQuery,
  getAllAtoms,
  rewriteQueryWithCallLlm,
  searchAtomsWithScores,
  MEMORY_DB_PATH,
  ATOMS_DIR,
};
export type { RunMemoryExtractionOptions, RunMemoryExtractionResult, PersonalAssistantConfig };
export type { MemoryAtom, MemoryAtomType, QueryRewriteResult };
