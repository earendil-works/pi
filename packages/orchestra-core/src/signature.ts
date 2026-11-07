// Stall detection: sha256(check_id + normalized error) to find repeated failures.
import { createHash } from "node:crypto";

export function normalizeError(output: string): string {
	return output
		.replace(/\r/g, "")
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l) => l.length > 0)
		.slice(-20)
		.join("\n")
		.replace(/\d+/g, "#")
		.slice(0, 2000);
}

export function failureSignature(checkId: string, output: string): string {
	const h = createHash("sha256");
	h.update(checkId);
	h.update("\n");
	h.update(normalizeError(output));
	return h.digest("hex").slice(0, 32);
}
