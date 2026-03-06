import type { Message } from "./types.js";

export const MU_COMPACT_RESPONSE_ITEM_KEY = "__muCompactResponseItem" as const;

export type MuCompactResponseCarrier = Message & {
	[MU_COMPACT_RESPONSE_ITEM_KEY]?: unknown;
};

export function getMuCompactResponseItem(message: Message): unknown {
	return (message as MuCompactResponseCarrier)[MU_COMPACT_RESPONSE_ITEM_KEY];
}
