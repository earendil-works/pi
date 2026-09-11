import type { Id, JsonValue } from "./core.ts";

export type Scope =
	| { readonly type: "session" }
	| { readonly type: "conversation"; readonly conversationId: Id }
	| { readonly type: "task"; readonly taskId: Id }
	| { readonly type: "shared"; readonly id: Id };

declare const addressType: unique symbol;

export interface Address<T extends JsonValue = JsonValue> {
	readonly scope: Scope;
	readonly namespace: string;
	readonly key?: string;
	readonly collection: "value" | "list";
	readonly rewind: boolean;
	readonly [addressType]?: T;
}

export interface Value<T extends JsonValue> extends Address<T> {
	readonly collection: "value";
}

export interface List<T extends JsonValue> extends Address<T> {
	readonly collection: "list";
}

export interface Element<T extends JsonValue> {
	readonly id: Id;
	readonly value: T;
}

type StickyOptions = { readonly key?: string; readonly rewind?: false };
type ConversationOptions = { readonly key?: string; readonly rewind: boolean };
type StickyScope = Extract<Scope, { type: "session" | "task" | "shared" }>;
type ConversationScope = Extract<Scope, { type: "conversation" }>;
type Options = StickyOptions | ConversationOptions;

export function defineValue<T extends JsonValue>(
	scope: StickyScope,
	namespace: string,
	options?: StickyOptions,
): Value<T>;
export function defineValue<T extends JsonValue>(
	scope: ConversationScope,
	namespace: string,
	options: ConversationOptions,
): Value<T>;
export function defineValue<T extends JsonValue>(scope: Scope, namespace: string, options?: Options): Value<T> {
	return Object.freeze({
		...options,
		scope,
		namespace,
		collection: "value",
		rewind: options?.rewind ?? false,
	});
}

export function defineList<T extends JsonValue>(
	scope: StickyScope,
	namespace: string,
	options?: StickyOptions,
): List<T>;
export function defineList<T extends JsonValue>(
	scope: ConversationScope,
	namespace: string,
	options: ConversationOptions,
): List<T>;
export function defineList<T extends JsonValue>(scope: Scope, namespace: string, options?: Options): List<T> {
	return Object.freeze({
		...options,
		scope,
		namespace,
		collection: "list",
		rewind: options?.rewind ?? false,
	});
}
