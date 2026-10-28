import { describe, expect, it } from "vitest";
import { broken } from "../../../src/next/data/index.ts";
import { invalid, openFailure } from "../../../src/next/data/internal.ts";

describe("failure causes", () => {
	it("a value thrown by an open is transient unless marked broken", () => {
		const error = new Error("network down");
		const transient = openFailure(error, "open notes");
		expect(transient.kind).toBe("transient");
		expect(transient.error.toJSON()).toEqual({ code: "unavailable", message: "open notes: network down" });
		expect(transient.error.cause).toBe(error);
	});

	it("broken() marks an open's failure as broken; its message is the cause's", () => {
		const marked = broken(new Error("bad config"));
		expect(marked.message).toBe("bad config");
		const cause = openFailure(marked, "open notes");
		expect(cause.kind).toBe("broken");
		expect(cause.error.message).toBe("open notes: bad config");
	});

	it("the kind comes from the stage, never from the error code", () => {
		const chord = invalid("placement", "wrong host");
		expect(openFailure(chord, "open")).toEqual({ kind: "transient", error: chord });
		expect(openFailure(broken(chord), "open")).toEqual({ kind: "broken", error: chord });
	});
});
