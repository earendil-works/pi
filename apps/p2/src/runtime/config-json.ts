// Adapted from earendil-works/pi (MIT); see third-party/pi.LICENSE.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const stripBom = (text: string): string => text.replace(/^\uFEFF/, "");
export function normalizePath(path: string): string {
	return resolve(path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path);
}

/** Strip `//` line comments and trailing commas from JSON, leaving string literals untouched. */
export function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

export async function optionalText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
		throw new Error("Could not read resource file");
	}
}
