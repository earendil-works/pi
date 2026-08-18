import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const piMessagesApi = (): ProviderStreams => lazyApi(() => import("./pi-messages.ts"));
