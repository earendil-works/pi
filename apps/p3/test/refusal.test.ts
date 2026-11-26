// `refusalText` (`/v1/web`, src/api/v1/refusal.ts): a refusal's message rendered by the translator of its namespace,
// else the error's text.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forbidden } from "@earendil-works/p3/v1";
import { messages } from "../plugins/environments/messages.ts";
import { refusalText } from "../src/api/v1/refusal.ts";

describe("refusalText", () => {
	const translators = { environments: messages };

	it("renders the message a refusal carries with its namespace's translator", () => {
		const refusal = forbidden("environments: log text", { message: messages.message("noTerminals") });
		assert.equal(refusalText(refusal, translators), "Terminals on this machine are not there yet.");
	});

	it("shows the error's own text for another namespace, malformed details and plain errors", () => {
		const other = forbidden("things: log text", { message: { namespace: "things", key: "notGiven", params: [] } });
		assert.equal(refusalText(other, translators), "things: log text");
		assert.equal(refusalText(forbidden("no details"), translators), "no details");
		assert.equal(refusalText(forbidden("odd", { message: { namespace: 1 } }), translators), "odd");
		assert.equal(refusalText(new Error("plain"), translators), "plain");
		assert.equal(refusalText("text", translators), "text");
	});
});
