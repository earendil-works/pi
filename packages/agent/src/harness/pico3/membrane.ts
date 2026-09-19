/**
 * A transaction-scoped revocable membrane over a Chord-tracked document.
 *
 * Every object reached through a document proxy is wrapped lazily; all wrappers of one
 * transaction share one liveness flag; identity is preserved by a WeakMap. Mutations forward
 * to the underlying Chord proxy so its tracker records ops. At transaction finish — success,
 * callback failure, validation failure, storage failure — `revoke()` flips the flag and every
 * retained wrapper, root or nested, throws on any operation.
 *
 * Assigning one wrapper into another (`a.list = b.list`) is rejected: Chord stores the value it
 * is given, and a stored proxy is the classic footgun. Assign plain values; splice in place.
 */
export class Membrane {
	private alive = true;
	private readonly wrappers = new WeakMap<object, object>();
	private readonly isWrapper = new WeakSet<object>();
	private readonly what: string;

	constructor(what: string) {
		this.what = what;
	}

	revoke() {
		this.alive = false;
	}

	wrap<T extends object>(target: T): T {
		const hit = this.wrappers.get(target);
		if (hit !== undefined) return hit as T;
		const m = this;
		const dead = () => new TypeError(`document proxy (${m.what}) used outside its transaction`);
		const out = (v: unknown): unknown => (typeof v === "object" && v !== null ? m.wrap(v) : v);
		const inp = (value: unknown): unknown => {
			if (typeof value !== "object" || value === null) return value;
			m.assertPlainInput(value, new WeakSet());
			return JSON.parse(JSON.stringify(value)) as unknown;
		};
		const proxy = new Proxy(target, {
			get(t, key, receiver) {
				if (!m.alive) throw dead();
				const v = Reflect.get(t, key, receiver === proxy ? t : receiver);
				if (typeof v === "function") {
					// Methods run against the tracked target. Callback arguments (array elements and
					// the array itself) must cross back through the membrane before user code sees them.
					return (...args: unknown[]) => {
						if (!m.alive) throw dead();
						const safeArgs = args.map((arg) => {
							if (typeof arg !== "function") return inp(arg);
							return function (this: unknown, ...callbackArgs: unknown[]) {
								if (!m.alive) throw dead();
								return Reflect.apply(arg, this, callbackArgs.map(out));
							};
						});
						return out(Reflect.apply(v, t, safeArgs));
					};
				}
				return out(v);
			},
			set(t, key, value) {
				if (!m.alive) throw dead();
				if (key === "__proto__") throw new TypeError(`document proxy (${m.what}) cannot change prototypes`);
				return Reflect.set(t, key, inp(value) as never);
			},
			deleteProperty(t, key) {
				if (!m.alive) throw dead();
				return Reflect.deleteProperty(t, key);
			},
			has(t, key) {
				if (!m.alive) throw dead();
				return Reflect.has(t, key);
			},
			ownKeys(t) {
				if (!m.alive) throw dead();
				return Reflect.ownKeys(t);
			},
			getOwnPropertyDescriptor(t, key) {
				if (!m.alive) throw dead();
				const d = Reflect.getOwnPropertyDescriptor(t, key);
				if (d === undefined) return undefined;
				// Descriptors must not leak a raw nested object.
				if ("value" in d) (d as { value: unknown }).value = out(d.value);
				return d;
			},
			defineProperty(t, key, descriptor) {
				if (!m.alive) throw dead();
				if ("get" in descriptor || "set" in descriptor)
					throw new TypeError(`document proxy (${m.what}) cannot define accessors`);
				const safe = "value" in descriptor ? { ...descriptor, value: inp(descriptor.value) } : descriptor;
				return Reflect.defineProperty(t, key, safe);
			},
			getPrototypeOf(t) {
				if (!m.alive) throw dead();
				return Reflect.getPrototypeOf(t);
			},
			setPrototypeOf() {
				if (!m.alive) throw dead();
				throw new TypeError(`document proxy (${m.what}) cannot change prototypes`);
			},
			isExtensible(t) {
				if (!m.alive) throw dead();
				return Reflect.isExtensible(t);
			},
			preventExtensions() {
				if (!m.alive) throw dead();
				throw new TypeError(`document proxy (${m.what}) cannot change extensibility`);
			},
		});
		this.wrappers.set(target, proxy);
		this.isWrapper.add(proxy);
		return proxy as T;
	}

	private assertPlainInput(value: object, seen: WeakSet<object>): void {
		if (this.isWrapper.has(value))
			throw new TypeError(`assigning a document proxy into a document (${this.what}); assign a plain value`);
		if (seen.has(value)) throw new TypeError(`assigning a cyclic value into a document (${this.what})`);
		seen.add(value);
		for (const nested of Object.values(value)) {
			if (typeof nested === "object" && nested !== null) this.assertPlainInput(nested, seen);
		}
		seen.delete(value);
	}
}
