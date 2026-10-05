/**
 * Strip terminal escape sequences from decoded command output across chunks.
 * Keep only parser state, not payloads: an unterminated OSC may be arbitrarily
 * long. Incomplete sequences are discarded when the stream ends.
 */
export class AnsiStreamStripper {
	private state: "text" | "escape" | "intermediate" | "csi" | "osc" | "oscEscape" = "text";

	write(value: string): string {
		const output: string[] = [];
		let textStart = 0;
		for (let index = 0; index < value.length; index++) {
			const char = value[index];
			if (this.state === "text") {
				if (char !== "\x1b" && char !== "\x9b") continue;
				output.push(value.slice(textStart, index));
				this.state = char === "\x1b" ? "escape" : "csi";
			} else if (this.state === "osc" || this.state === "oscEscape") {
				if (char === "\x07" || char === "\x9c" || (this.state === "oscEscape" && char === "\\")) {
					this.state = "text";
				} else {
					this.state = char === "\x1b" ? "oscEscape" : "osc";
				}
			} else if (char === "\x1b" || char === "\x9b") {
				// A new introducer abandons an incomplete escape/CSI sequence.
				this.state = char === "\x1b" ? "escape" : "csi";
			} else if (this.state === "escape" && char === "[") {
				this.state = "csi";
			} else if (this.state === "escape" && char === "]") {
				this.state = "osc";
			} else if (this.state === "csi" && char >= " " && char <= "?") {
				// CSI parameter and intermediate bytes; wait for the final byte.
			} else if (this.state !== "csi" && char >= " " && char <= "/") {
				this.state = "intermediate";
			} else {
				const finalStart = this.state === "csi" ? "@" : "0";
				this.state = "text";
				if (char < finalStart || char > "~") {
					// Preserve ordinary text/control characters after a malformed sequence.
					textStart = index;
					continue;
				}
			}
			textStart = index + 1;
		}
		if (this.state === "text") output.push(value.slice(textStart));
		return output.join("");
	}
}
