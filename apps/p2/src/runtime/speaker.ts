import type { Author } from "./principals.ts";

export type { Author } from "./principals.ts";
export const SPEAKER_PREFIX = "<mobile-speaker>";
export function speakerText(author: Author): string {
	return `${SPEAKER_PREFIX}${JSON.stringify(author)}</mobile-speaker>`;
}
