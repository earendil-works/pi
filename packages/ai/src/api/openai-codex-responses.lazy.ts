import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const openAICodexResponsesApi = (): ProviderStreams => lazyApi(() => import("./openai-codex-responses.ts"));
