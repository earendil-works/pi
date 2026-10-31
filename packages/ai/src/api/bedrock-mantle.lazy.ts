import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const bedrockMantleApi = (): ProviderStreams => lazyApi(() => import("./bedrock-mantle.ts"));
