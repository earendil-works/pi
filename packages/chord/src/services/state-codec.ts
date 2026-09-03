import { type Decoder, decoder, type Encoder, encoder } from "../delta/index.ts";
import type {
	ServiceInstanceAddress,
	ServiceInstanceSnapshot,
	ServiceProviderUpdate,
	ServiceSubscriptionSnapshot,
} from "../types.ts";
import type { WireServiceProviderUpdate, WireServiceSubscriptionSnapshot } from "./wire.ts";

/** Stateful operation encoders for every replicated state in one service subscription. */
export interface ServiceStateEncoder {
	encodeSnapshot(snapshot: ServiceSubscriptionSnapshot): WireServiceSubscriptionSnapshot;
	encodeUpdate(update: ServiceProviderUpdate): WireServiceProviderUpdate;
}

/** Stateful operation decoders for every replicated state in one service subscription. */
export interface ServiceStateDecoder {
	decodeSnapshot(snapshot: WireServiceSubscriptionSnapshot): ServiceSubscriptionSnapshot;
	decodeUpdate(update: WireServiceProviderUpdate): ServiceProviderUpdate;
}

interface CodecEntry<C> {
	readonly instance: ServiceInstanceAddress | undefined;
	readonly codec: C;
}

class StateCodecRegistry<C> {
	readonly #create: () => C;
	readonly #entries = new Map<string, CodecEntry<C>>();

	constructor(create: () => C) {
		this.#create = create;
	}

	reset(): void {
		this.#entries.clear();
	}

	add(instance: ServiceInstanceAddress | undefined, member: string): C {
		const key = stateKey(instance, member);
		if (this.#entries.has(key)) throw new Error(`Duplicate service state ${describeState(instance, member)}`);
		const codec = this.#create();
		this.#entries.set(key, { instance, codec });
		return codec;
	}

	get(instance: ServiceInstanceAddress | undefined, member: string): C {
		const codec = this.#entries.get(stateKey(instance, member))?.codec;
		if (codec === undefined) throw new Error(`Unknown service state ${describeState(instance, member)}`);
		return codec;
	}

	removeInstance(instance: ServiceInstanceAddress): void {
		for (const [key, entry] of this.#entries) {
			if (sameAddress(entry.instance, instance)) this.#entries.delete(key);
		}
	}
}

export function createServiceStateEncoder(): ServiceStateEncoder {
	const codecs = new StateCodecRegistry<Encoder>(encoder);
	return {
		encodeSnapshot(snapshot) {
			codecs.reset();
			return {
				...snapshot,
				instances: snapshot.instances.map((instance) => encodeInstance(instance, codecs)),
			};
		},
		encodeUpdate(update) {
			switch (update.type) {
				case "state":
					return { ...update, ops: codecs.get(update.instance, update.member).encode(update.ops) };
				case "replaced":
					codecs.reset();
					return { ...update, snapshot: encodeInstance(update.snapshot, codecs) };
				case "spawned":
					return { ...update, instance: encodeInstance(update.instance, codecs) };
				case "unavailable":
					codecs.reset();
					return update;
				case "closed":
					codecs.removeInstance(update.instance);
					return update;
			}
		},
	};
}

export function createServiceStateDecoder(): ServiceStateDecoder {
	const codecs = new StateCodecRegistry<Decoder>(decoder);
	return {
		decodeSnapshot(snapshot) {
			codecs.reset();
			return {
				...snapshot,
				instances: snapshot.instances.map((instance) => decodeInstance(instance, codecs)),
			};
		},
		decodeUpdate(update) {
			switch (update.type) {
				case "state":
					return { ...update, ops: codecs.get(update.instance, update.member).decode(update.ops) };
				case "replaced":
					codecs.reset();
					return { ...update, snapshot: decodeInstance(update.snapshot, codecs) };
				case "spawned":
					return { ...update, instance: decodeInstance(update.instance, codecs) };
				case "unavailable":
					codecs.reset();
					return update;
				case "closed":
					codecs.removeInstance(update.instance);
					return update;
			}
		},
	};
}

function encodeInstance(
	instance: ServiceInstanceSnapshot,
	codecs: StateCodecRegistry<Encoder>,
): WireServiceSubscriptionSnapshot["instances"][number] {
	return {
		...instance,
		members: instance.members.map((member) =>
			member.kind === "state"
				? { ...member, ops: codecs.add(instance.instance, member.name).encode(member.ops) }
				: member,
		),
	};
}

function decodeInstance(
	instance: WireServiceSubscriptionSnapshot["instances"][number],
	codecs: StateCodecRegistry<Decoder>,
): ServiceInstanceSnapshot {
	return {
		...instance,
		members: instance.members.map((member) =>
			member.kind === "state"
				? { ...member, ops: codecs.add(instance.instance, member.name).decode(member.ops) }
				: member,
		),
	};
}

function stateKey(instance: ServiceInstanceAddress | undefined, member: string): string {
	return JSON.stringify([instance?.key ?? null, instance?.generation ?? null, member]);
}

function sameAddress(left: ServiceInstanceAddress | undefined, right: ServiceInstanceAddress): boolean {
	return left?.key === right.key && left.generation === right.generation;
}

function describeState(instance: ServiceInstanceAddress | undefined, member: string): string {
	return instance === undefined ? member : `${instance.key}@${instance.generation}.${member}`;
}
