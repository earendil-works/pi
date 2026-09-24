import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const vertexAnthropicApi = (): ProviderStreams => lazyApi(() => import("./vertex-anthropic.ts"));
