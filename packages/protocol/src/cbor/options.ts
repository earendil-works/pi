export const UINT32_BASE = 0x1_0000_0000;
export const MAX_UINT32 = 0xffff_ffff;
const MAX_CONFIGURED_DEPTH = 512;

/** Safe defaults for untrusted protocol payloads. */
export const DEFAULT_MAX_CBOR_BYTE_LENGTH = 16 * 1024 * 1024;
export const DEFAULT_MAX_CBOR_CONTAINER_LENGTH = 1_000_000;
export const DEFAULT_MAX_CBOR_DEPTH = 64;

export interface CborOptions {
	/** Maximum encoded input/output bytes and maximum byte/text string length. */
	maxByteLength?: number;
	/** Maximum number of elements in an array or entries in a map. */
	maxContainerLength?: number;
	/** Maximum recursive item depth. */
	maxDepth?: number;
}

export interface ResolvedCborOptions {
	maxByteLength: number;
	maxContainerLength: number;
	maxDepth: number;
}

export class CborError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CborError";
	}
}

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function resolveLimit(name: string, value: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
		throw new RangeError(`${name} must be an integer between 0 and ${maximum}`);
	}
	return value;
}

export function resolveOptions(options: CborOptions | undefined): ResolvedCborOptions {
	return {
		maxByteLength: resolveLimit("maxByteLength", options?.maxByteLength ?? DEFAULT_MAX_CBOR_BYTE_LENGTH, MAX_UINT32),
		maxContainerLength: resolveLimit(
			"maxContainerLength",
			options?.maxContainerLength ?? DEFAULT_MAX_CBOR_CONTAINER_LENGTH,
			MAX_UINT32,
		),
		maxDepth: resolveLimit("maxDepth", options?.maxDepth ?? DEFAULT_MAX_CBOR_DEPTH, MAX_CONFIGURED_DEPTH),
	};
}
