import { execSync } from "child_process";
import { platform } from "os";

export function copyToClipboard(text: string): void {
	const p = platform();
	const options = { input: text, timeout: 5000 };

	try {
		if (p === "darwin") {
			execSync("pbcopy", options);
		} else if (p === "win32") {
			execSync("clip", options);
		} else {
			// Linux - try xclip first, fall back to xsel
			try {
				execSync("xclip -selection clipboard", options);
			} catch {
				execSync("xsel --clipboard --input", options);
			}
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if (p === "linux") {
			throw new Error(`Failed to copy to clipboard. Install xclip or xsel: ${msg}`);
		}
		throw new Error(`Failed to copy to clipboard: ${msg}`);
	}
}
