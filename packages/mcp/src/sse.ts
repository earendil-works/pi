const DEFAULT_MAX_EVENT_BYTES = 16 * 1024 * 1024;

export interface SseEvent {
	event?: string;
	data: string;
	id?: string;
}

export interface ConsumeSseOptions {
	maxEventBytes?: number;
	onEvent(event: SseEvent): void;
}

export async function consumeSseStream(stream: ReadableStream<Uint8Array>, options: ConsumeSseOptions): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	let eventName: string | undefined;
	let eventId: string | undefined;
	let dataLines: string[] = [];
	const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;

	const dispatch = () => {
		if (dataLines.length === 0) {
			eventName = undefined;
			eventId = undefined;
			return;
		}
		const data = dataLines.join("\n");
		if (Buffer.byteLength(data) > maxEventBytes) throw new Error(`MCP SSE event exceeds ${maxEventBytes} bytes`);
		options.onEvent({ ...(eventName ? { event: eventName } : {}), data, ...(eventId ? { id: eventId } : {}) });
		eventName = undefined;
		eventId = undefined;
		dataLines = [];
	};

	const processLine = (rawLine: string) => {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line === "") {
			dispatch();
			return;
		}
		if (line.startsWith(":")) return;
		const colon = line.indexOf(":");
		const field = colon < 0 ? line : line.slice(0, colon);
		let value = colon < 0 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "data") dataLines.push(value);
		else if (field === "event") eventName = value;
		else if (field === "id" && !value.includes("\0")) eventId = value;
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffered += decoder.decode(value, { stream: true });
			let newline = buffered.indexOf("\n");
			while (newline >= 0) {
				processLine(buffered.slice(0, newline));
				buffered = buffered.slice(newline + 1);
				newline = buffered.indexOf("\n");
			}
			if (Buffer.byteLength(buffered) > maxEventBytes)
				throw new Error(`MCP SSE event exceeds ${maxEventBytes} bytes`);
		}
		buffered += decoder.decode();
		if (buffered) processLine(buffered);
		dispatch();
	} finally {
		reader.releaseLock();
	}
}
