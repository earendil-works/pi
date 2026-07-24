import { trustRequestCacheBreakpointAdapter } from "../request-cache-breakpoint-dispatch.ts";
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const azureOpenAIResponsesApi = (): ProviderStreams =>
	trustRequestCacheBreakpointAdapter(lazyApi(() => import("./azure-openai-responses.ts")));
