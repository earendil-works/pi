// Types of the stats plugin's dependency before it is installed (its own types once installed).

declare module "@bob/words" {
	export const VERSION: string;
	export function words(text: string): number;
}
