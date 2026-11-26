import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const googleInteractionsApi = (): ProviderStreams => lazyApi(() => import("./google-interactions.ts"));
