import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const googleGenerativeAIApi = (): ProviderStreams => lazyApi(() => import("./google-generative-ai.ts"));
