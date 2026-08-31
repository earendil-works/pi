import type { PiServerOptions } from "../../types.ts";

export interface TcpListenerOptions {
	host?: string;
	port: number;
	maxPendingBytes?: number;
	gracefulCloseTimeoutMs?: number;
	/** Used to derive and validate maxPendingBytes. Must match the server when customized. */
	maxFrameLength?: number;
	onError?: (error: Error) => void;
}

export interface TcpServerOptions extends Omit<PiServerOptions, "listeners">, TcpListenerOptions {}
