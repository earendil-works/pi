// The UI state a reload carries from the old worker to the new one (bounded to 1 MiB by the launcher): the viewed
// identity and screen, display toggles, and per-identity drafts, pending send IDs and reading positions (P0c).
// The state comes from the previous bundle, which may be older: everything is validated, and the version-1 format
// (session-keyed drafts, a line offset) is migrated.
import { identityKey, type TuiRuntime } from "../runtime/tui.ts";
import type { TranscriptAnchor } from "./components/transcript.ts";

export type TuiSnapshot = {
	version: 2;
	session: string | undefined;
	conversation: number;
	screen: TuiRuntime["screen"];
	showThinking: boolean;
	thinkingSetting: boolean;
	expandedTools: boolean;
	drafts: [string, string][];
	submissions: [string, { text: string; id: string; mode: "steer" | "followUp" }][];
	anchors: [string, TranscriptAnchor][];
};

export function snapshotRuntime(runtime: TuiRuntime): TuiSnapshot {
	runtime.saveState();
	return {
		version: 2,
		session: runtime.session,
		conversation: runtime.conversation,
		screen: runtime.screen,
		showThinking: runtime.showThinking,
		thinkingSetting: runtime.thinkingSetting,
		expandedTools: runtime.expandedTools,
		drafts: [...runtime.drafts],
		submissions: [...runtime.submissions],
		anchors: [...runtime.anchors],
	};
}

const object = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const pairs = (value: unknown): [string, unknown][] =>
	Array.isArray(value)
		? value.flatMap((pair) =>
				Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string"
					? [[pair[0], pair[1]] as [string, unknown]]
					: [],
			)
		: [];
/** Version 1 keyed drafts and submissions by session: the main conversation's. */
const migrateKey = (key: string): string => (key.includes("#") ? key : identityKey(key));

export function restoreRuntime(runtime: TuiRuntime, state: unknown): void {
	const saved = object(state);
	if (!saved) return;
	if (typeof saved.session === "string") runtime.session = saved.session;
	if (typeof saved.conversation === "number" && Number.isSafeInteger(saved.conversation) && saved.conversation > 0)
		runtime.conversation = saved.conversation;
	if (saved.screen === "sessions" || saved.screen === "chat") runtime.screen = saved.screen;
	// The model screen became an overlay (P4): back to where it was opened from.
	else if (saved.screen === "models") runtime.screen = runtime.session ? "chat" : "sessions";
	runtime.showThinking = saved.showThinking === true;
	if (typeof saved.thinkingSetting === "boolean") runtime.thinkingSetting = saved.thinkingSetting;
	runtime.expandedTools = saved.expandedTools === true;
	for (const [key, value] of pairs(saved.drafts))
		if (typeof value === "string") runtime.drafts.set(migrateKey(key), value);
	for (const [key, value] of pairs(saved.submissions)) {
		const submission = object(value);
		if (
			typeof submission?.text === "string" &&
			typeof submission.id === "string" &&
			(submission.mode === "steer" || submission.mode === "followUp")
		)
			runtime.submissions.set(migrateKey(key), { text: submission.text, id: submission.id, mode: submission.mode });
	}
	for (const [key, value] of pairs(saved.anchors)) {
		const anchor = object(value);
		if (typeof anchor?.key !== "string" || typeof anchor.offset !== "number" || !Number.isFinite(anchor.offset))
			continue;
		runtime.anchors.set(key, {
			key: anchor.key,
			offset: Math.floor(anchor.offset),
			...(typeof anchor.entryId === "number" ? { entryId: anchor.entryId } : {}),
		});
	}
}
