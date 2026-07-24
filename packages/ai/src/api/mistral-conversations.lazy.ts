import { trustRequestCacheBreakpointAdapter } from "../request-cache-breakpoint-dispatch.ts";
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const mistralConversationsApi = (): ProviderStreams =>
	trustRequestCacheBreakpointAdapter(lazyApi(() => import("./mistral-conversations.ts")));
