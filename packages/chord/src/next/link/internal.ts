// Links for Chord's layers: a host's end of a link (handshake, codec, checks, heartbeat and in-order handling), the
// message type, parts with their limits and compression, and errors in messages.

export { binaryCodec } from "./binary.ts";
export { Channel, type ChannelHandler } from "./channel.ts";
export { errorFromWire, wireError } from "./errors.ts";
export type { Link } from "./link.ts";
export {
	type BoundEntry,
	CHAIN,
	type Codec,
	type ConsumerMessage,
	checkMessage,
	type FailedMember,
	type Message,
	NO_RETIRED,
	type OriginMessage,
	type ProviderMessage,
	type StateEntry,
	type WireAddress,
} from "./message.ts";
export {
	type Compression,
	DeflatedPart,
	inflateAsync,
	type Limits,
	linkLimits,
	openPart,
	originPart,
	oversized,
	type Part,
	type PartLimits,
} from "./part.ts";
export { describeMessage, textCodec } from "./text.ts";
export { jsonPart, parsePart, parsePayload, payloadPart } from "./values.ts";
