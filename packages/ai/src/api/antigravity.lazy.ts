import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const antigravityApi = (): ProviderStreams => lazyApi(() => import("./antigravity.ts"));
