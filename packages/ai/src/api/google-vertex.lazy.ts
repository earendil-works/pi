import { trustRequestCacheBreakpointAdapter } from "../request-cache-breakpoint-dispatch.ts";
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const googleVertexApi = (): ProviderStreams =>
	trustRequestCacheBreakpointAdapter(lazyApi(() => import("./google-vertex.ts")));
