// `@bob/words`: a package in its own git repository (the example commits it twice: this file, then a version 2).

/** The version of this commit. */
export const VERSION = "1";

/** The words in `text`. */
export function words(text: string): number {
	return text.split(/\s+/).filter(Boolean).length;
}
