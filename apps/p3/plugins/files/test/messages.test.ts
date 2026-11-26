// The files plugin's messages (the guide's 8.9): every key has a text, and a second catalog renders.

import { describe, it } from "node:test";
import { checkCatalog } from "../../environments/test/catalog.ts";
import { messages } from "../messages.ts";

describe("the files plugin's messages", () => {
	it("has a text for every key, and a second catalog renders in its place (guide 8.9)", () => {
		checkCatalog(messages);
	});
});
