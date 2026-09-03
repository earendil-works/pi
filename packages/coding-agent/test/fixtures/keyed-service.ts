import { type Context, defineService, type ReplicatedState } from "@earendil-works/chord";

export interface KeyedProbe {
	readonly state: ReplicatedState<{ value: string }>;
	replace(value: string, context: Context): Promise<void>;
	wait(context: Context): Promise<void>;
}

export const KeyedProbe = defineService<KeyedProbe>("test.keyed-probe");
