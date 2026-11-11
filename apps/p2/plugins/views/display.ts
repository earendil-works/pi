// How a message that carried view context shows in the transcript (web and TUI): the person's text as always, with a
// note of what came along.
import type { EntryDisplay } from "../chat/contract.ts";

/** The note on a `p2.view-input` entry: how many selections and annotations it carried. */
export function viewInputDisplay(data: unknown): EntryDisplay | undefined {
	const views = data !== null && typeof data === "object" && "views" in data ? data.views : undefined;
	if (views === null || typeof views !== "object") return undefined;
	const count = (key: string) => {
		const value = (views as Record<string, unknown>)[key];
		return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
	};
	const selections = count("selections");
	const annotations = count("annotations");
	const parts = [
		selections ? `${selections} selection${selections === 1 ? "" : "s"}` : "",
		annotations ? `${annotations} annotation${annotations === 1 ? "" : "s"}` : "",
	].filter(Boolean);
	return parts.length ? { note: `with ${parts.join(" and ")} from views` } : undefined;
}
