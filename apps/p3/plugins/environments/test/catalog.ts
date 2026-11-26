// The guide's check 8.9 for the messages of the kinds that reach machines (environments, files, terminals): every key
// of a plugin's own catalog has a text, and a second catalog of the same keys renders in its place.

import assert from "node:assert/strict";
import { type Catalog, defineMessages, type Messages } from "@earendil-works/p3/v1";

/** Asserts that every key of `messages`' own catalog renders a text, and that a second catalog renders instead. */
export function checkCatalog(messages: Messages<string, Catalog>): void {
	const [own] = messages.translations;
	assert.ok(own !== undefined, `${messages.namespace}: a catalog`);
	const keys = Object.keys(own.messages);
	const args = (key: string) => {
		const value = own.messages[key];
		return Array.from({ length: typeof value === "function" ? value.length : 0 }, () => 1);
	};
	for (const key of keys) {
		const text = (messages as unknown as (key: string, ...args: unknown[]) => string)(key, ...args(key));
		assert.ok(text.length > 0 && text !== key, `${messages.namespace}.${key} has a text`);
	}
	const second: Catalog = Object.fromEntries(
		keys.map((key) => [key, typeof own.messages[key] === "function" ? () => `xx ${key}` : `xx ${key}`]),
	);
	const both = defineMessages(messages.namespace, { de: second, en: own.messages });
	for (const key of keys) {
		const text = (both as unknown as (key: string, ...args: unknown[]) => string)(key, ...args(key));
		assert.equal(text, `xx ${key}`);
	}
}
