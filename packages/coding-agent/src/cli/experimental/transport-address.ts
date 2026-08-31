import { posix } from "node:path";

export interface UnixTransportAddress {
	readonly transport: "unix";
	readonly path: string;
}

export interface TcpTransportAddress {
	readonly transport: "tcp";
	readonly host: string;
	readonly port: number;
}

export interface WebSocketTransportAddress {
	readonly transport: "ws";
	readonly url: string;
}

export type TransportAddress = UnixTransportAddress | TcpTransportAddress | WebSocketTransportAddress;

function parsePort(value: string, option: "--listen" | "--connect"): { port?: number; error?: string } {
	if (!/^\d+$/u.test(value)) {
		return { error: `${option} address port must be a number` };
	}
	const port = Number.parseInt(value, 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		return { error: `${option} address port must be an integer between 1 and 65535` };
	}
	return { port };
}

export function parseTransportAddress(
	value: string,
	option: "--listen" | "--connect",
): { address?: TransportAddress; error?: string } {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { error: `Invalid ${option} address "${value}"` };
	}

	if (url.protocol === "unix:") {
		if (url.hostname || url.port || url.username || url.password) {
			return { error: "Unix transport address must not include an authority" };
		}
		if (
			!value.startsWith("unix:///") ||
			value.startsWith("unix:////") ||
			value.includes("?") ||
			value.includes("#") ||
			url.href !== value
		) {
			return { error: `Invalid ${option} address "${value}"` };
		}
		let path: string;
		try {
			path = decodeURIComponent(url.pathname);
		} catch {
			return { error: `Invalid ${option} address "${value}"` };
		}
		if (path.includes("\0")) {
			return { error: `Invalid ${option} address "${value}"` };
		}
		if (!posix.isAbsolute(path)) {
			return { error: "Unix transport address requires an absolute path" };
		}
		return { address: { transport: "unix", path } };
	}

	if (url.protocol === "tcp:") {
		if (url.username || url.password || url.search || url.hash) {
			return { error: `Invalid ${option} address "${value}"` };
		}
		// Non-special schemes leave pathname empty; accept "/" or "" and reject anything else.
		if (url.pathname !== "" && url.pathname !== "/") {
			return { error: `Invalid ${option} address "${value}"` };
		}
		const host = url.hostname || "127.0.0.1";
		if (host.length === 0 || url.port === null || url.port === "") {
			return { error: `${option} address requires a host and port (tcp://host:port)` };
		}
		const parsed = parsePort(url.port, option);
		if (parsed.error) return { error: parsed.error };
		return { address: { transport: "tcp", host, port: parsed.port! } };
	}

	if (url.protocol === "ws:" || url.protocol === "wss:") {
		if (url.username || url.password || url.search || url.hash) {
			return { error: `Invalid ${option} address "${value}"` };
		}
		if (url.pathname !== "" && url.pathname !== "/") {
			return { error: `Invalid ${option} address "${value}"` };
		}
		// ws:// defaults to port 80, wss:// to port 443 when omitted.
		let port = url.port;
		if (port === null || port === "") {
			port = String(url.protocol === "wss:" ? 443 : 80);
		}
		const parsed = parsePort(port, option);
		if (parsed.error) return { error: parsed.error };
		return { address: { transport: "ws", url: value } };
	}

	return { error: `Unsupported ${option} transport "${url.protocol}"` };
}
