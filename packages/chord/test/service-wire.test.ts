import { describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "../src/context/index.ts";
import {
	createRemoteServiceEndpoint,
	createServiceCatalogueCall,
	createServiceStateDecoder,
	createServiceStateEncoder,
	createServiceSubscribeCall,
	createServiceUnsubscribeCall,
	decodeServiceControlCall,
	defineService,
	parseServiceCall,
	parseServiceCatalogue,
	parseServiceProviderUpdate,
	parseServiceSubscriptionSnapshot,
	parseWireServiceProviderUpdate,
	parseWireServiceSubscriptionSnapshot,
	RemoteServiceProvider,
	type ReplicatedState,
	replicatedState,
	type ServiceProviderUpdate,
	type ServiceSubscriptionSnapshot,
} from "../src/index.ts";

describe("service wire protocol", () => {
	test("encodes control calls and validates service values", () => {
		expect(decodeServiceControlCall(createServiceCatalogueCall())).toEqual({ type: "catalogue" });
		expect(
			parseServiceCatalogue([
				{ serviceId: "pi.models", mode: "singleton" },
				{ serviceId: "pi.dialogs", mode: "keyed" },
			]),
		).toEqual([
			{ serviceId: "pi.models", mode: "singleton" },
			{ serviceId: "pi.dialogs", mode: "keyed" },
		]);
		const subscribe = createServiceSubscribeCall("subscription-1", "pi.models", "singleton");
		expect(decodeServiceControlCall(subscribe)).toEqual({
			type: "subscribe",
			subscriptionId: "subscription-1",
			serviceId: "pi.models",
			mode: "singleton",
		});
		expect(decodeServiceControlCall(createServiceUnsubscribeCall("subscription-1"))).toEqual({
			type: "unsubscribe",
			subscriptionId: "subscription-1",
		});
		expect(
			parseServiceCall({
				serviceId: "pi.question-dialog",
				instance: { key: "invocation-1", generation: 2 },
				member: "submit",
				args: [{ outcome: "selected", index: 0 }],
			}),
		).toMatchObject({ member: "submit" });
	});

	test("rejects malformed service values", () => {
		expect(() => parseServiceCall({ serviceId: "pi.models", member: "list", args: [], extra: true })).toThrow(
			"Invalid service call",
		);
		expect(() => parseServiceCatalogue([{ serviceId: "pi.models", mode: "unknown" }])).toThrow(
			"Invalid service catalogue",
		);
		expect(() => parseServiceProviderUpdate({ type: "state", member: "state", sequence: 0, ops: [] })).toThrow(
			"Invalid service state update",
		);
		expect(() =>
			parseWireServiceProviderUpdate({ type: "state", member: "state", sequence: 1, ops: [["?", 0]] }),
		).toThrow();
	});

	test("validates decoded and wire snapshots and updates", () => {
		const snapshot: ServiceSubscriptionSnapshot = {
			serviceId: "pi.models",
			mode: "singleton",
			instances: [
				{
					members: [{ name: "state", kind: "state", sequence: 0, ops: [["r", { revision: 1 }]] }],
				},
			],
		};
		expect(parseServiceSubscriptionSnapshot(snapshot)).toBe(snapshot);
		const encoder = createServiceStateEncoder();
		const wireSnapshot = encoder.encodeSnapshot(snapshot);
		expect(parseWireServiceSubscriptionSnapshot(wireSnapshot)).toBe(wireSnapshot);
		const update: ServiceProviderUpdate = {
			type: "state",
			member: "state",
			sequence: 1,
			ops: [["s", ["revision"], 2]],
		};
		expect(parseServiceProviderUpdate(update)).toBe(update);
		const wireUpdate = encoder.encodeUpdate(update);
		expect(parseWireServiceProviderUpdate(wireUpdate)).toBe(wireUpdate);
	});

	test("keeps one operation codec pair for one subscription state", () => {
		const enc = createServiceStateEncoder();
		const dec = createServiceStateDecoder();
		const snapshot: ServiceSubscriptionSnapshot = {
			serviceId: "pi.models",
			mode: "singleton",
			instances: [
				{
					members: [{ name: "state", kind: "state", sequence: 0, ops: [["r", { revision: 0 }]] }],
				},
			],
		};
		expect(dec.decodeSnapshot(enc.encodeSnapshot(snapshot))).toEqual(snapshot);

		const first: ServiceProviderUpdate = {
			type: "state",
			member: "state",
			sequence: 1,
			ops: [["s", ["revision"], 1]],
		};
		const second: ServiceProviderUpdate = {
			type: "state",
			member: "state",
			sequence: 2,
			ops: [["s", ["revision"], 2]],
		};
		const firstWire = enc.encodeUpdate(first);
		const secondWire = enc.encodeUpdate(second);
		expect(firstWire).toMatchObject({ ops: [["s", ["revision"], 1]] });
		expect(secondWire).toMatchObject({
			ops: [
				["#", 0, ["revision"]],
				["s", 0, 2],
			],
		});
		expect(dec.decodeUpdate(firstWire)).toEqual(first);
		expect(dec.decodeUpdate(secondWire)).toEqual(second);
	});

	test("isolates operation dictionaries between states and subscriptions", () => {
		const snapshot: ServiceSubscriptionSnapshot = {
			serviceId: "pi.states",
			mode: "singleton",
			instances: [
				{
					members: [
						{ name: "left", kind: "state", sequence: 0, ops: [["r", { revision: 0 }]] },
						{ name: "right", kind: "state", sequence: 0, ops: [["r", { revision: 0 }]] },
					],
				},
			],
		};
		const firstEncoder = createServiceStateEncoder();
		const firstDecoder = createServiceStateDecoder();
		const secondEncoder = createServiceStateEncoder();
		const secondDecoder = createServiceStateDecoder();
		firstDecoder.decodeSnapshot(firstEncoder.encodeSnapshot(snapshot));
		secondDecoder.decodeSnapshot(secondEncoder.encodeSnapshot(snapshot));

		const update = (member: string, sequence: number, revision: number): ServiceProviderUpdate => ({
			type: "state",
			member,
			sequence,
			ops: [["s", ["revision"], revision]],
		});
		const firstLeft = firstEncoder.encodeUpdate(update("left", 1, 1));
		const firstRight = firstEncoder.encodeUpdate(update("right", 1, 1));
		const secondLeft = firstEncoder.encodeUpdate(update("left", 2, 2));
		const secondRight = firstEncoder.encodeUpdate(update("right", 2, 2));
		expect(firstLeft).toMatchObject({ ops: [["s", ["revision"], 1]] });
		expect(firstRight).toMatchObject({ ops: [["s", ["revision"], 1]] });
		expect(secondLeft).toMatchObject({
			ops: [
				["#", 0, ["revision"]],
				["s", 0, 2],
			],
		});
		expect(secondRight).toMatchObject({
			ops: [
				["#", 0, ["revision"]],
				["s", 0, 2],
			],
		});
		expect(firstDecoder.decodeUpdate(firstLeft)).toEqual(update("left", 1, 1));
		expect(firstDecoder.decodeUpdate(firstRight)).toEqual(update("right", 1, 1));
		expect(firstDecoder.decodeUpdate(secondLeft)).toEqual(update("left", 2, 2));
		expect(firstDecoder.decodeUpdate(secondRight)).toEqual(update("right", 2, 2));

		const independentLeft = secondEncoder.encodeUpdate(update("left", 1, 1));
		expect(independentLeft).toMatchObject({ ops: [["s", ["revision"], 1]] });
		expect(secondDecoder.decodeUpdate(independentLeft)).toEqual(update("left", 1, 1));

		const leftBase: ServiceProviderUpdate = {
			type: "state",
			member: "left",
			sequence: 3,
			ops: [["r", { revision: 3 }]],
		};
		expect(firstDecoder.decodeUpdate(firstEncoder.encodeUpdate(leftBase))).toEqual(leftBase);
		const thirdRight = firstEncoder.encodeUpdate(update("right", 3, 3));
		expect(thirdRight).toMatchObject({ ops: [["s", 0, 3]] });
		expect(firstDecoder.decodeUpdate(thirdRight)).toEqual(update("right", 3, 3));
	});

	test("creates and removes keyed instance codecs with their lifecycle", () => {
		const enc = createServiceStateEncoder();
		const dec = createServiceStateDecoder();
		const snapshot: ServiceSubscriptionSnapshot = {
			serviceId: "pi.dialogs",
			mode: "keyed",
			instances: [],
		};
		expect(dec.decodeSnapshot(enc.encodeSnapshot(snapshot))).toEqual(snapshot);
		const address = { key: "dialog-1", generation: 1 };
		const spawned: ServiceProviderUpdate = {
			type: "spawned",
			instance: {
				instance: address,
				members: [{ name: "request", kind: "state", sequence: 0, ops: [["r", { value: 0 }]] }],
			},
		};
		expect(dec.decodeUpdate(enc.encodeUpdate(spawned))).toEqual(spawned);
		const update: ServiceProviderUpdate = {
			type: "state",
			instance: address,
			member: "request",
			sequence: 1,
			ops: [["s", ["value"], 1]],
		};
		expect(dec.decodeUpdate(enc.encodeUpdate(update))).toEqual(update);
		const closed: ServiceProviderUpdate = { type: "closed", instance: address };
		expect(dec.decodeUpdate(enc.encodeUpdate(closed))).toEqual(closed);
		expect(() => enc.encodeUpdate({ ...update, sequence: 2 })).toThrow("Unknown service state");
	});
});

interface Counter {
	readonly state: ReplicatedState<{ value: number }>;
}

const Counter = defineService<Counter>("test.counter");

test("remote service endpoints publish and clean up provider subscriptions", async () => {
	const provider = new RemoteServiceProvider([Counter]);
	const state = replicatedState({ value: 0 });
	provider.provide(Counter, { state });
	const endpoint = createRemoteServiceEndpoint(provider);
	const updates: ServiceProviderUpdate[] = [];
	const publish = (_subscriptionId: string, update: ServiceProviderUpdate): void => {
		updates.push(update);
	};

	await expect(endpoint.invoke(createServiceCatalogueCall(), publish, BACKGROUND_CONTEXT)).resolves.toEqual([
		{ serviceId: Counter.id, mode: "singleton" },
	]);
	await expect(
		endpoint.invoke(
			createServiceSubscribeCall("subscription-1", Counter.id, "singleton"),
			publish,
			BACKGROUND_CONTEXT,
		),
	).resolves.toMatchObject({ serviceId: Counter.id, mode: "singleton" });

	state.state.value = 1;
	state.publish(BACKGROUND_CONTEXT);
	expect(updates).toEqual([{ type: "state", member: "state", sequence: 1, ops: [["s", ["value"], 1]] }]);
	endpoint.dispose();
	state.state.value = 2;
	state.publish(BACKGROUND_CONTEXT);
	expect(updates).toHaveLength(1);
	provider.dispose();
});
