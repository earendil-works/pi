import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const ollamaChatApi = (): ProviderStreams => lazyApi(() => import("./ollama-chat.ts"));
