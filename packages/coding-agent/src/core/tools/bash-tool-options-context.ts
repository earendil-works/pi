import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionContext } from "../extensions/types.ts";

/** Keep local bash defaults scoped to the executing extension tool, including async delegation. */
export const bashToolOptionsContext = new AsyncLocalStorage<ExtensionContext["getBashToolOptions"]>();
