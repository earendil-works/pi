import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { evolve, hostKind, int, oneOf, opt, remote, str } from "../../../src/next/contracts/index.ts";
import { contractData, kindParams } from "../../../src/next/contracts/internal.ts";
import { isChordError } from "../../../src/next/data/index.ts";
import { checkAddress } from "../../../src/next/data/internal.ts";
import { expectCollected } from "../support.ts";

const Server = hostKind("server");
const Session = hostKind("session", { id: str() });
const Shard = hostKind("shard", { region: oneOf("eu", "us"), n: int({ min: 0 }) });

describe("host kinds", () => {
	it("make addresses: the kind, the params and a key built like an identity key", () => {
		expect(Server()).toEqual({ kind: "server", params: {}, key: "server" });
		expect(Session({ id: "S1" })).toEqual({ kind: "session", params: { id: "S1" }, key: "session|S1" });
		expect(Shard({ region: "eu", n: 3 }).key).toBe("shard|eu|3");
		// Escaped like identity keys: two different param lists never make one key.
		expect(Session({ id: "a|b" }).key).not.toBe(Shard({ region: "a" as "eu", n: "b" as unknown as number }).key);
		expect(Session({ id: "a|b" }).key).toBe("session|a\\|b");
	});

	it("follow the params policy of contracts at declaration", () => {
		// @ts-expect-error: params fields are required
		expect(() => hostKind("k", { id: opt(str()) })).toThrow("k.params.id: a param is");
		expect(() => hostKind("")).toThrow(`A host kind's name "": expected lowercase [a-z0-9@/._~-]`);
		expect(() => hostKind("Session")).toThrow("expected lowercase");
		expect(() => hostKind("a:b")).toThrow("expected lowercase");
		expect(() => hostKind("client")).toThrow('"client" is reserved for hosts without an address');
		expect(hostKind("@pi/session.v2_~-").kind).toBe("@pi/session.v2_~-");
	});

	it("check an address's params where it is routed, with the kind's compiled check: invalid/placement", () => {
		const params = kindParams(Session);
		expect(checkAddress("session", params, { id: "S1" }, context).key).toBe("session|S1");
		for (const bad of [{ id: 1 }, {}, { id: "S1", extra: 1 }, null]) {
			let thrown: unknown;
			try {
				checkAddress("session", params, bad, context);
			} catch (error) {
				thrown = error;
			}
			expect(isChordError(thrown, "invalid") && thrown.reason).toBe("placement");
		}
	});

	it("keep their params data only while the kind is referenced", async () => {
		const ref = (() => {
			const Temp = hostKind("temp", { id: str() });
			kindParams(Temp);
			return new WeakRef(Temp);
		})();
		await expectCollected(ref);
	});
});

describe("placement", () => {
	const variants = { v: { state: { n: int() } } };

	it("is not part of the fingerprint and is carried by evolve", () => {
		const placement = ({ session }: { session: string }) => Session({ id: session });
		const placed = remote("app.placed", { version: 1, params: { session: str() }, placement, variants });
		const unplaced = remote("app.placed", { version: 1, params: { session: str() }, variants });
		expect(placed.fingerprint).toBe(unplaced.fingerprint);
		expect(contractData(placed).placement).toBe(placement);
		expect(contractData(unplaced).placement).toBeUndefined();
		const next = evolve(placed, (v) => v.addState("v", "m", int()));
		expect(contractData(next).placement).toBe(placement);
	});

	it("is typed by the contract's params", () => {
		remote("app.typed", {
			version: 1,
			params: { session: str() },
			// @ts-expect-error: the params have no `id`
			placement: ({ id }) => Session({ id }),
			variants,
		});
	});
});
