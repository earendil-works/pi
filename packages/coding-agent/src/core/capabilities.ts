/** Stable capability surface for coding-agent embedders. */
export const PI_CAPABILITIES = {
	inputDurability: "pre_dispatch_barrier",
} as const;

export type PiCapabilities = typeof PI_CAPABILITIES;
