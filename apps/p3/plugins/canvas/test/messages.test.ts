// The canvas plugin's messages (guide 8.9): every key of its catalog has a text, and a second catalog renders instead.

import { describe, it } from "node:test";
import { checkCatalog } from "../../things/test/catalog.ts";
import { messages } from "../messages.ts";

describe("the canvas plugin's messages", () => {
	it("have a text for every key, and a second catalog renders in their place", () => {
		checkCatalog(messages);
	});
});
