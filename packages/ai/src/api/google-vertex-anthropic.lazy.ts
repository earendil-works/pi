import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const googleVertexAnthropicApi = (): ProviderStreams => lazyApi(() => import("./google-vertex-anthropic.ts"));
