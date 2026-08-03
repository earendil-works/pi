import type { PiServerOptions } from "../../types.ts";

export interface UnixListenerOptions {
	path: string;
	/** Socket filesystem permissions. Defaults to owner read/write only (0o600). */
	mode?: number;
	/** Maximum framed bytes queued per connection before a slow peer is disconnected. */
	maxPendingBytes?: number;
	gracefulCloseTimeoutMs?: number;
	/** Used to derive and validate maxPendingBytes. Must match the server when customized. */
	maxFrameLength?: number;
	onError?: (error: Error) => void;
}

export interface UnixServerOptions extends Omit<PiServerOptions, "listeners">, UnixListenerOptions {}
