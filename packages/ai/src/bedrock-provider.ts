import { stream, streamSimple } from "./api/bedrock-converse-stream.ts";
import { createMantleSigV4Fetch } from "./api/bedrock-mantle-sigv4.ts";

export const bedrockProviderModule = {
	stream,
	streamSimple,
};

export const bedrockMantleSigV4Module = {
	createMantleSigV4Fetch,
};
