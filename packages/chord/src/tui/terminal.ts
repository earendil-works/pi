// The terminal as the app's terminal code sees it inside the sandbox (slice 11 §4): its size, writing frames, and
// input and resizes, all through the bridge; the launcher holds the real terminal. Library-agnostic: an app adapts it
// to its terminal UI library (pi-tui's `Terminal` in a few lines).

import type { SandboxChannel } from "./channel.ts";

/** The bridged terminal. */
export class BridgeTerminal {
	readonly #channel: SandboxChannel;
	#columns: number;
	#rows: number;

	constructor(channel: SandboxChannel) {
		this.#channel = channel;
		this.#columns = channel.start.columns;
		this.#rows = channel.start.rows;
		channel.onResize((columns, rows) => {
			this.#columns = columns;
			this.#rows = rows;
		});
	}

	get columns(): number {
		return this.#columns;
	}

	get rows(): number {
		return this.#rows;
	}

	/** Writes `data` (text and escape sequences) to the terminal. */
	write(data: string): void {
		this.#channel.write(data);
	}

	/** Calls `listener` with each input (keys, pastes, as the terminal sends them) until the returned removal. */
	onInput(listener: (data: string) => void): () => void {
		return this.#channel.onInput(listener);
	}

	/** Calls `listener` after each resize (the new size read from `columns` and `rows`) until the returned removal. */
	onResize(listener: () => void): () => void {
		return this.#channel.onResize(() => listener());
	}
}
