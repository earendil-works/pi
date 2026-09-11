import type { ByteConnectionAcceptor } from "./connection.ts";

/** Supplies established byte connections after any required transport authentication. */
export interface ServerListener {
	/** Starts listening and passes authorized connections to accept. */
	start(accept: ByteConnectionAcceptor): Promise<void>;
	close(): Promise<void>;
}
