// What a scoped prompt sends: a `<scope>` block saying what the person pointed at (and, for the Familiar, what their
// page showed). To the open conversation the block goes along as message context, the text as the person typed it; to
// the Familiar it follows the text, and the Familiar routes by it (its prompt section explains the block).
import type { Route } from "@p2/app/v1/web";
import { excerpt, type ScopeLevel } from "./scopes.ts";

/** What the person pointed at: the chain of levels (outermost first; the last is the one chosen) and their selection. */
export type Scope = {
	readonly levels: readonly ScopeLevel[];
	readonly selection?: string;
};

/** Whether the scope lies in the open session's page (its chat or a view beside it): its conversation is the target. */
export const inOpenSession = (scope: Scope, route: Route): boolean =>
	route.session !== undefined && scope.levels.some((level) => level.kind === "transcript" || level.kind === "view");

/** The block for the open conversation's agent: what the person pointed at in its page, as JSON. */
export function scopeBlock(scope: Scope): string {
	return block(
		"What the person pointed at on this session's page when they wrote the message (outermost first; the last is what they chose), and text they had selected in it:",
		target(scope),
	);
}

/** The transcript's note on a message that carried `scope`: "scope Chat › Message". */
export const scopeNote = (scope: Scope): string =>
	excerpt(`scope ${scope.levels.map((level) => excerpt(level.label, 40)).join(" › ")}`, 300);

/** `text` followed by the scope block for the Familiar: the page (`route`, the open session's title) and the target. */
export function familiarMessage(text: string, scope: Scope, route: Route, title: string | undefined): string {
	const page =
		route.session !== undefined
			? { session: route.session, conversation: route.conversation, ...(title ? { title } : {}) }
			: route.page !== undefined
				? { list: route.page }
				: { screen: route.newSession ? "new session" : "home" };
	return `${text.trim()}\n\n${block("Where the owner pointed when they wrote this:", { page, ...target(scope) })}`;
}

function target(scope: Scope) {
	return {
		target: scope.levels.map((level) => ({ kind: level.kind, ...level.data })),
		...(scope.selection ? { selection: scope.selection } : {}),
	};
}

const block = (intro: string, value: object) => `<scope>\n${intro}\n${JSON.stringify(value, null, 2)}\n</scope>`;
