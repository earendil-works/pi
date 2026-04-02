import type { Message } from "./types.js";
export declare const MU_COMPACT_RESPONSE_ITEM_KEY: "__muCompactResponseItem";
export type MuCompactResponseCarrier = Message & {
    [MU_COMPACT_RESPONSE_ITEM_KEY]?: unknown;
};
export declare function getMuCompactResponseItem(message: Message): unknown;
//# sourceMappingURL=compact-history.d.ts.map