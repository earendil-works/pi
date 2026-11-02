// Links for apps: the link interface adapters implement, the in-memory pair, IPC and WebSocket links, the codecs a link
// may use, its limits per part and the compressor a host may bring.

export { binaryCodec } from "./binary.ts";
export { type IpcPort, ipcLink } from "./ipc.ts";
export { type Link, memoryLinkPair } from "./link.ts";
export type { Codec, Message } from "./message.ts";
export type { Compression, Inflated, PartLimits } from "./part.ts";
export { describeMessage, textCodec } from "./text.ts";
export { type WebSocketLike, webSocketLink } from "./websocket.ts";
