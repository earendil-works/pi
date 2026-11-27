// What typing into a terminal's hidden text field means to the terminal (ghostty-screen.tsx): on a phone's keyboard
// every key arrives as text the keyboard composes and corrects in the field, so the screen sends what changed.

/**
 * What typing into the terminal's textarea did, as a terminal sees it: `deleted` characters before the cursor go
 * (Backspaces), then `inserted` is typed. Everything from the first changed character is retyped, so a correction of
 * an earlier word works without moving the cursor. Characters are code points, as a line editor deletes them; a
 * newline is Enter (CR).
 *
 * Example: Gboard corrects "teh" to "the ": deleted 2, inserted "he ".
 */
export function typedChange(before: string, after: string): { deleted: number; inserted: string } {
	const old = [...before];
	const next = [...after];
	let same = 0;
	while (same < old.length && same < next.length && old[same] === next[same]) same++;
	return { deleted: old.length - same, inserted: next.slice(same).join("").replace(/\r?\n/g, "\r") };
}
