/** One server-sent event: its `event` field, its `data` lines joined by "\n", and its raw lines for diagnostics. */
export interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
}

/**
 * Decodes server-sent events from a UTF-8 byte stream. Lines end with LF, CRLF or CR, and a blank line ends an
 * event. Only new text is scanned, and an incomplete line is read once when it ends, so a large event arriving in
 * many chunks costs time linear in its size.
 */
export class SseDecoder {
	private readonly decoder = new TextDecoder();
	/** The incomplete last line. */
	private pendingLine = "";
	/** The last text ended with CR, so a leading LF of the next text completes that CRLF. */
	private skipLeadingLf = false;
	private event: string | null = null;
	private data: string[] = [];
	private raw: string[] = [];

	/** Takes the next bytes and returns the events they complete. */
	push(bytes: Uint8Array): ServerSentEvent[] {
		return this.decodeText(this.decoder.decode(bytes, { stream: true }));
	}

	/** Ends the stream and returns the remaining events, including a last one the stream ended without a blank line. */
	end(): ServerSentEvent[] {
		const events = this.decodeText(this.decoder.decode());
		if (this.pendingLine) this.decodeLine(this.pendingLine);
		this.pendingLine = "";
		this.skipLeadingLf = false;
		const last = this.flush();
		if (last) events.push(last);
		return events;
	}

	private decodeText(text: string): ServerSentEvent[] {
		const events: ServerSentEvent[] = [];
		let start = this.skipLeadingLf && text.startsWith("\n") ? 1 : 0;
		if (text.length > 0) this.skipLeadingLf = false;
		for (let i = start; i < text.length; i++) {
			const char = text[i];
			if (char !== "\r" && char !== "\n") continue;
			const event = this.decodeLine(this.pendingLine + text.slice(start, i));
			if (event) events.push(event);
			this.pendingLine = "";
			if (char === "\r") {
				if (i + 1 === text.length) this.skipLeadingLf = true;
				else if (text[i + 1] === "\n") i++;
			}
			start = i + 1;
		}
		this.pendingLine += text.slice(start);
		return events;
	}

	private decodeLine(line: string): ServerSentEvent | undefined {
		if (line === "") return this.flush();
		this.raw.push(line);
		if (line.startsWith(":")) return undefined;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") this.event = value;
		else if (field === "data") this.data.push(value);
		return undefined;
	}

	private flush(): ServerSentEvent | undefined {
		if (!this.event && this.data.length === 0) {
			this.event = null;
			this.raw = [];
			return undefined;
		}
		const event: ServerSentEvent = { event: this.event, data: this.data.join("\n"), raw: this.raw };
		this.event = null;
		this.data = [];
		this.raw = [];
		return event;
	}
}
