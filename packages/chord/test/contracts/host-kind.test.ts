import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { bool, evolve, hostKind, int, oneOf, opt, remote, str } from "../../src/contracts/index.ts";
import { addressOfKey, contractData, keyOfAddress, kindOfKey, kindParams } from "../../src/contracts/internal.ts";
import { isChordError } from "../../src/data/index.ts";
import { checkAddress } from "../../src/data/internal.ts";
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

	it("check an address's params where it is routed, with the kind's compiled check: invalid/host_address", () => {
		const params = kindParams(Session);
		expect(checkAddress("session", params, { id: "S1" }, context).key).toBe("session|S1");
		for (const bad of [{ id: 1 }, {}, { id: "S1", extra: 1 }, null]) {
			let thrown: unknown;
			try {
				checkAddress("session", params, bad, context);
			} catch (error) {
				thrown = error;
			}
			expect(isChordError(thrown, "invalid") && thrown.reason).toBe("host_address");
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

describe("hostAddress", () => {
	const variants = { v: { state: { n: int() } } };

	it("is not part of the fingerprint and is carried by evolve", () => {
		const hostAddress = ({ session }: { session: string }) => Session({ id: session });
		const onSession = remote("app.placed", { version: 1, params: { session: str() }, hostAddress, variants });
		const onServer = remote("app.placed", {
			version: 1,
			params: { session: str() },
			hostAddress: () => Server(),
			variants,
		});
		expect(onSession.fingerprint).toBe(onServer.fingerprint);
		expect(contractData(onSession).hostAddress).toBe(hostAddress);
		const next = evolve(onSession, (v) => v.addState("v", "m", int()));
		expect(contractData(next).hostAddress).toBe(hostAddress);
	});

	it("is typed by the contract's params", () => {
		remote("app.typed", {
			version: 1,
			params: { session: str() },
			// @ts-expect-error: the params have no `id`
			hostAddress: ({ id }) => Session({ id }),
			variants,
		});
	});
});

describe("address keys", () => {
	const Flag = hostKind("flag", { on: bool(), id: str() });

	it("decode into addresses: str, int and bool fields, oneOf literals, escaped parts, a kind without params", () => {
		for (const address of [
			Session({ id: "a|b\\c" }),
			Shard({ region: "us", n: 12 }),
			Flag({ on: false, id: "" }),
			Server(),
		]) {
			expect(addressOfKey(kindOf(address.kind), address.key)).toEqual(address);
		}
		expect(() => addressOfKey(Session, "shard|eu|1")).toThrow("not an address key of session");
		expect(kindOfKey("session|S1")).toBe("session");
		expect(kindOfKey("server")).toBe("server");
	});

	it("of a value are computed from its params, refused for anything that is not an address of the kind", () => {
		expect(keyOfAddress(Session, Session({ id: "S1" }))).toBe("session|S1");
		// A forged key is not taken: the key comes from the params.
		expect(keyOfAddress(Session, { kind: "session", params: { id: "S1" }, key: "session|S2" })).toBe("session|S1");
		for (const value of [
			"session|S1",
			null,
			Shard({ region: "eu", n: 1 }),
			{ kind: "session", params: { id: 1 } },
			{ kind: "session", params: {} },
			{ kind: "session", params: { id: "S1", extra: 1 } },
		]) {
			expect(keyOfAddress(Session, value)).toBeUndefined();
		}
		expect(keyOfAddress(Shard, { kind: "shard", params: { region: "asia", n: 1 } })).toBeUndefined();
		expect(keyOfAddress(Shard, { kind: "shard", params: { region: "eu", n: 1.5 } })).toBeUndefined();
		expect(keyOfAddress(Flag, { kind: "flag", params: { on: "true", id: "x" } })).toBeUndefined();
	});

	/** The declared kind named `name`. */
	function kindOf(name: string) {
		return [Session, Shard, Flag, Server].find((kind) => kind.kind === name)!;
	}
});
