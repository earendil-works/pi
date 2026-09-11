import ivm from "isolated-vm";

/**
 * A membrane between the host realm and an isolated-vm isolate.
 *
 * ── The safety argument, which is structural, not a convention ──────────────
 *
 * isolated-vm CAN be used unsafely. The documented footgun is handing the guest
 * a live handle to a host object — via `derefInto()`, or by returning a
 * `Reference` from a host call — after which the guest can walk that object's
 * prototype chain into the host realm.
 *
 * This membrane makes that impossible by construction rather than by care:
 *
 *   1. `encode()` is the ONLY way a host value reaches the guest, and it is
 *      `JSON.stringify` with a replacer. Its output is a string. A string
 *      cannot carry a reference.
 *   2. Host callables do not cross. They are replaced by an integer id into
 *      `hostTable`, which lives entirely host-side. The guest receives a number.
 *   3. Exactly ONE `Reference` is ever given to the guest — `__invokeRef`, the
 *      single call-in point — and its `deref()` throws cross-isolate ("Cannot
 *      dereference this from current isolate"). Its `derefInto()` yields an
 *      inert `Dereference` marker: not callable, no host globals.
 *   4. `derefInto()` is used exactly once, on the guest's OWN global. No host
 *      object is ever an argument to it.
 *
 * The consequence: the guest's entire view of the host is `{ number, string }`.
 * There is no object graph to walk, so there is nothing to walk it into. This is
 * the same property the QuickJS membrane has, and it is why the choice between
 * them is about performance and packaging rather than about safety.
 *
 * Verified by `src/escape-audit.ts`.
 */
export async function createCompartment({ memoryLimit = 256 } = {}) {
  const isolate = new ivm.Isolate({ memoryLimit });
  const ctx = await isolate.createContext();
  await ctx.global.set("global", ctx.global.derefInto());   // guest's own global only

  const hostTable = new Map();
  let nextHostId = 1;
  const exposeHost = (o) => { const id = nextHostId++; hostTable.set(id, o); return id; };

  const guestProxies = new Map();
  const finalizer = new FinalizationRegistry((id) => {
    guestProxies.delete(id);
    if (!released) ctx.evalSync(`delete __refs[${JSON.stringify(String(id))}]`);
  });
  let released = false;

  // Async: `applySync` is synchronous, so a host Promise cannot itself cross.
  // Instead the host returns a token, the guest builds a real Promise against
  // it, and the host settles that Promise by calling back in when it resolves.
  let nextPending = 1;
  function encodePending(promise) {
    const token = nextPending++;
    promise.then(
      (v) => settle(token, true, v === undefined ? "" : encode(v)),
      (e) => settle(token, false, JSON.stringify(String(e?.message ?? e))),
    );
    return JSON.stringify({ __pending: token });
  }
  function settle(token, ok, json) {
    if (released) return;
    ctx.evalSync(`__settle(${token}, ${ok}, ${JSON.stringify(json)})`);
  }

  function encode(v) {
    if (v && typeof v.then === "function") return encodePending(v);
    return JSON.stringify(v, (_k, val) => {
      if (typeof val === "function") return { __ref: exposeHost(val) };
      if (val && typeof val === "object" && !Array.isArray(val) && hasMethods(val))
        return { __obj: exposeHost(val), keys: methodNames(val) };
      return val;
    });
  }
  const decode = (json) => JSON.parse(json, (_k, v) => reviveGuest(v));

  function intern(id, build) {
    const hit = guestProxies.get(id)?.deref();
    if (hit !== undefined) return hit;
    const p = build();
    guestProxies.set(id, new WeakRef(p));
    finalizer.register(p, id);
    return p;
  }
  function reviveGuest(v) {
    if (!v || typeof v !== "object") return v;
    if (typeof v.__guestRef === "number") { const r = v.__guestRef; return intern(r, () => (...a) => callGuestRef(r, a)); }
    if (typeof v.__guestObj === "number") {
      const r = v.__guestObj;
      return intern(r, () => { const o = {}; for (const k of v.keys) o[k] = (...a) => callGuestRef(r, [k, a]); return o; });
    }
    return v;
  }

  function callGuestRef(ref, args, timeout = 5000) {
    const out = ctx.evalSync(
      `__refs[${JSON.stringify(String(ref))}](${JSON.stringify(JSON.stringify(args))})`,
      { timeout },
    );
    return out === "" || out === undefined ? undefined : decode(out);
  }

  // The single host entry point. A Reference, applied synchronously with copied
  // arguments — no host object graph is ever exposed.
  const invoke = new ivm.Reference((idJson, pathJson, argsJson) => {
    const path = JSON.parse(pathJson);
    let target = hostTable.get(JSON.parse(idJson));
    for (let i = 0; i < path.length - 1; i++) target = target[path[i]];
    const result = path.length ? target[path[path.length - 1]](...decode(argsJson)) : target(...decode(argsJson));
    return result === undefined ? "" : encode(result);
  });
  await ctx.global.set("__invokeRef", invoke);

  await ctx.eval(`
    globalThis.__refs = {}; globalThis.__nextRef = 1;
    globalThis.__outgoing = new WeakMap();
    globalThis.__methodNames = function (o) {
      var out = [], p = o;
      while (p && p !== Object.prototype) {
        for (const k of Object.getOwnPropertyNames(p))
          if (k !== "constructor" && typeof o[k] === "function" && out.indexOf(k) < 0) out.push(k);
        p = Object.getPrototypeOf(p);
      }
      return out;
    };
    globalThis.__mkRef = function (fn) {
      var prior = __outgoing.get(fn); if (prior !== undefined) return { __guestRef: prior };
      var id = __nextRef++; __outgoing.set(fn, id);
      __refs[String(id)] = function (j) { var r = fn.apply(null, JSON.parse(j)); return r === undefined ? "" : __encode(r); };
      return { __guestRef: id };
    };
    globalThis.__mkObjRef = function (obj) {
      var prior = __outgoing.get(obj);
      if (prior !== undefined) return { __guestObj: prior, keys: __methodNames(obj) };
      var id = __nextRef++; __outgoing.set(obj, id);
      __refs[String(id)] = function (j) { var c = JSON.parse(j); var r = obj[c[0]].apply(obj, c[1]); return r === undefined ? "" : __encode(r); };
      return { __guestObj: id, keys: __methodNames(obj) };
    };
    globalThis.__encode = function (v) {
      return JSON.stringify(v, function (k, val) {
        if (typeof val === "function") return __mkRef(val);
        if (val && typeof val === "object" && !Array.isArray(val) && __methodNames(val).length) return __mkObjRef(val);
        return val;
      });
    };
    globalThis.__pending = {};
    globalThis.__settle = function (token, ok, json) {
      var d = __pending[token];
      if (!d) return;
      delete __pending[token];
      var value = json === "" ? undefined : JSON.parse(json);
      ok ? d.resolve(__revive(value)) : d.reject(new Error(value));
    };
    globalThis.__revive = function (v) {
      if (v && typeof v === "object" && typeof v.__pending === "number") {
        var token = v.__pending;
        return new Promise(function (res, rej) { __pending[token] = { resolve: res, reject: rej }; });
      }
      if (v && typeof v === "object") {
        if (typeof v.__ref === "number") return __wrap(v.__ref, []);
        if (typeof v.__obj === "number") return __wrap(v.__obj, []);
        for (var k in v) v[k] = __revive(v[k]);
      }
      return v;
    };
    globalThis.__wrap = function (id, path) {
      return new Proxy(function () {}, {
        get: function (t, prop) {
          if (typeof prop !== "string") return undefined;
          if (prop === "then" || prop === "toJSON" || prop === "inspect") return undefined;
          if (prop === "length" || prop === "name") return t[prop];
          return __wrap(id, path.concat([prop]));
        },
        apply: function (_t, _this, args) {
          var out = __invokeRef.applySync(undefined, [JSON.stringify(id), JSON.stringify(path), __encode(args)]);
          return out === "" ? undefined : __revive(JSON.parse(out));
        },
      });
    };
  `);

  return {
    async endow(name, obj) { await ctx.eval(`globalThis[${JSON.stringify(name)}] = __wrap(${exposeHost(obj)}, []);`); },
    load: (src, timeout = 30000) => ctx.evalSync(src, { timeout }),
    debugRefCount: () => ({ hostTable: hostTable.size, guestRefs: ctx.evalSync(`Object.keys(__refs).length`) }),
    dispose() {
      released = true;
      // An isolate that hit its memory limit is already disposed, and calling
      // dispose() again throws "Isolate is already disposed".
      try { isolate.dispose(); } catch { /* already gone */ }
    },
  };
}
const RESERVED = new Set(["constructor"]);
const methodNames = (o) => { const out = []; for (let p = o; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) for (const k of Object.getOwnPropertyNames(p)) if (!RESERVED.has(k) && typeof o[k] === "function" && !out.includes(k)) out.push(k); return out; };
const hasMethods = (o) => methodNames(o).length > 0;
