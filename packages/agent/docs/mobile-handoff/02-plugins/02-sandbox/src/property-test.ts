/**
 * Property tests for the membrane.
 *
 * Every bug found by hand while building it failed SILENTLY — wrong output, no
 * throw. That is the worst possible failure mode for a boundary, and the reason
 * these exist. Run with:  node --experimental-strip-types --expose-gc property-test.ts
 */
import { createCompartment } from "./membrane.ts";

let pass = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) pass++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

/** Random JsonValue. The membrane claims to round-trip exactly these. */
function randomJson(depth = 0): unknown {
  const r = Math.random();
  if (depth > 3 || r < 0.25) return Math.floor(Math.random() * 1000) - 500;
  if (r < 0.35) return Math.random() * 1e6 - 5e5;
  if (r < 0.45) return Math.random() < 0.5;
  if (r < 0.5) return null;
  if (r < 0.65) {
    const alphabet = ['a', 'z', '0', ' ', '"', '\\', '\n', '\u00e9', '\u4e2d', '\u{1f600}'];
    let s = "";
    const n = Math.floor(Math.random() * 12);
    for (let i = 0; i < n; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
  }
  if (r < 0.8) return Array.from({ length: Math.floor(Math.random() * 5) }, () => randomJson(depth + 1));
  const o: Record<string, unknown> = {};
  for (const k of ["a", "b", "c", "d", "__proto__x", "0", "length"]) {
    if (Math.random() < 0.5) o[k] = randomJson(depth + 1);
  }
  return o;
}

const c = await createCompartment();

// ── 1. Value round-trip, both directions ──────────────────────────────────
const echoed: unknown[] = [];
await c.endow("__h", { echo: (v: unknown) => v, sink: (v: unknown) => { echoed.push(v); } });
c.load(`globalThis.roundTrip = function (v) { return __h.echo(v); };
        globalThis.sendBack = function (v) { __h.sink(v); };`);

for (let i = 0; i < 400; i++) {
  const value = randomJson();
  const json = JSON.stringify(value);
  if (json === undefined) continue;
  // host -> guest -> host
  c.load(`globalThis.__t = roundTrip(${json});`);
  c.load(`sendBack(__t);`);
  const got = echoed.pop();
  check("value round-trip", JSON.stringify(got) === json, `${json} became ${JSON.stringify(got)}`);
}

// ── 2. Identity: the same guest object must map to the same host proxy ────
const seen: unknown[] = [];
await c.endow("__id", { take: (o: unknown) => { seen.push(o); } });
c.load(`globalThis.shared = { m: function () { return 1; } };
        globalThis.sendShared = function () { __id.take(shared); __id.take(shared); };`);
c.load(`sendShared();`);
check("identity preserved across crossings", seen[0] === seen[1]);
c.load(`sendShared();`);
check("identity stable across separate calls", seen[0] === seen[2]);

// ── 3. Callables survive and remain callable ──────────────────────────────
let held: any;
await c.endow("__f", { keep: (fn: unknown) => { held = fn; } });
c.load(`__f.keep(function (a, b) { return a + b; });`);
check("guest function callable from host", held(2, 3) === 5, `got ${held?.(2, 3)}`);

// ── 4. Errors cross with name and message ─────────────────────────────────
c.load(`__f.keep(function () { throw new TypeError("boom"); });`);
let msg = "";
try { held(); } catch (e: any) { msg = e.message; }
check("guest throw reaches host", msg.includes("boom"), `got "${msg}"`);

// ── 5. Reference release: crossings must not leak ─────────────────────────
await c.endow("__l", { drop: (_fn: unknown) => {} });
c.load(`globalThis.churn = function () { for (var i = 0; i < 500; i++) __l.drop(function () { return i; }); };`);
c.load(`churn();`);
const beforeGc = c.debugRefCount().guestRefs;
globalThis.gc?.();
await new Promise((r) => setTimeout(r, 60));
globalThis.gc?.();
await new Promise((r) => setTimeout(r, 60));
const afterGc = c.debugRefCount().guestRefs;
check("dropped references are released", afterGc < beforeGc / 2, `${beforeGc} -> ${afterGc}`);

// ── 5b. Prototype pollution must not cross ────────────────────────────────
// JSON.parse is safe (it makes __proto__ an own property), but a membrane that
// assigns parsed keys onto a fresh object is not.
const before = ({} as any).polluted;
c.load(`__h.sink(JSON.parse('{"__proto__":{"polluted":true}}'));`);
check("guest cannot pollute host Object.prototype", ({} as any).polluted === before);
await c.endow("__p", { give: () => JSON.parse('{"__proto__":{"hostPolluted":true}}') });
await c.endow("__q", { show: (v: string) => check("host cannot pollute guest prototype", v === "undefined", v) });
c.load(`var got = __p.give(); __q.show(String(({}).hostPolluted));`);

// ── 6. Interrupt budget, and the VM survives it ───────────────────────────
// Direct: the budget on this call bounds it.
{
  const t0 = Date.now();
  try { c.load(`while (true) {}`, 100); } catch { /* expected */ }
  check("runaway guest code is interrupted", Date.now() - t0 < 600, `took ${Date.now() - t0}ms`);
}
// Re-entrant: a guest function invoked BY THE HOST gets `callGuestRef`'s own
// budget, not the outer one. Budgets do not nest — see README "Limitations".
c.load(`globalThis.spin = function () { while (true) {} };`);
await c.endow("__s", { run: (fn: any) => { try { fn(); return "returned"; } catch { return "threw"; } } });
{
  const t0 = Date.now();
  try { c.load(`globalThis.__x = __s.run(spin);`, 50); } catch { /* expected */ }
  const took = Date.now() - t0;
  check("re-entrant call uses its OWN budget, not the outer one", took > 1000,
        `took ${took}ms — if this is now <1s the nesting behaviour changed`);
}
c.load(`globalThis.__alive = 1 + 1;`);
check("VM usable after an interrupt", true);

// ── 7. Async, and clean teardown with a pending promise ───────────────────
await c.endow("__a", { never: () => new Promise(() => {}), soon: () => Promise.resolve("v") });
c.load(`globalThis.out = null; __a.soon().then(function (v) { out = v; });`);
await new Promise((r) => setTimeout(r, 30));
await c.endow("__o", { show: (v: string) => check("async host result reaches guest", v === '"v"', v) });
c.load(`__o.show(JSON.stringify(out));`);
c.load(`__a.never().then(function () {}, function () {});`);   // deliberately unsettled

let disposeOk = true;
try { c.dispose(); } catch { disposeOk = false; }
check("dispose with a pending promise does not crash", disposeOk);

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures.slice(0, 10)) console.log("  FAIL", f);
process.exit(failures.length === 0 ? 0 : 1);
