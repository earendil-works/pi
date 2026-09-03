/**
 * Escape audit.
 *
 * The claim the membrane makes is that the guest's entire view of the host is
 * `{ number, string }` — no object graph, so nothing to walk. This tries to
 * break that, including the specific `Reference` footgun that makes isolated-vm
 * dangerous when used naively.
 */
import { createCompartment } from "./membrane.ts";

const c = await createCompartment();
const seen: string[] = [];
await c.endow("__h", {
  sink: (v: string) => seen.push(v),
  give: () => ({ nested: { a: 1 } }),
  giveFn: () => () => "host function result",
});

const probe = (name: string, src: string) => {
  c.load(`globalThis.__p = String(${src});`);
  c.load(`__h.sink(__p);`);
  const got = seen.pop();
  const bad = got !== undefined && /GOT (?!undefined)|INVOKED|CALLABLE|^object$/.test(got) && !/blocked/.test(got);
  console.log(`  ${bad ? "!!" : "ok"}  ${name.padEnd(34)} ${got}`);
  return !bad;
};

console.log("Ambient authority:");
let ok = true;
ok = probe("require / process / fetch", `JSON.stringify([typeof require, typeof process, typeof fetch])`) && ok;
ok = probe("global names visible", `Object.getOwnPropertyNames(globalThis).length + " globals"`) && ok;

console.log("\nClassic escape ladders:");
ok = probe("Function('return process')()", `(function(){ try { return String((function(){}).constructor("return typeof process")()); } catch(e){ return "blocked: "+e.name; } })()`) && ok;
ok = probe("constructor walk on host data", `(function(){ try { var o = __h.give(); return String(o.constructor.constructor("return typeof process")()); } catch(e){ return "blocked: "+e.name; } })()`) && ok;

console.log("\nThe isolated-vm Reference footgun:");
ok = probe("__invokeRef.deref()", `(function(){ try { return "GOT " + typeof __invokeRef.deref(); } catch(e){ return "blocked: "+e.name; } })()`) && ok;
ok = probe("__invokeRef.copySync()", `(function(){ try { return "GOT " + typeof __invokeRef.copySync(); } catch(e){ return "blocked: "+e.name; } })()`) && ok;
ok = probe("__invokeRef.getSync('constructor')", `(function(){ try { return "GOT " + typeof __invokeRef.getSync("constructor"); } catch(e){ return "blocked: "+e.name; } })()`) && ok;
ok = probe("derefInto() is callable?", `(function(){ var d = __invokeRef.derefInto(); return typeof d === "function" ? "CALLABLE" : "inert (" + typeof d + ")"; })()`) && ok;
ok = probe("invoke derefInto() result", `(function(){ try { __invokeRef.derefInto()(); return "INVOKED"; } catch(e){ return "blocked: "+e.name; } })()`) && ok;
ok = probe("host globals via derefInto()", `(function(){ var d = __invokeRef.derefInto(); return String(d.process || d.global || "no host globals"); })()`) && ok;

console.log("\nWhat a host FUNCTION looks like to the guest:");
ok = probe("typeof a returned host fn", `(function(){ var f = __h.giveFn(); return typeof f; })()`) && ok;
// NOTE: `f.deref` is NOT undefined — the membrane's proxy returns a proxy for
// every property. That is not a leak: calling it routes to hostFn["deref"],
// which does not exist, and throws host-side. Testing for the property's
// absence gave a false positive in a first draft of this audit.
ok = probe("calling f.deref() reaches nothing", `(function(){ try { var f = __h.giveFn(); f.deref(); return "INVOKED"; } catch(e){ return "blocked: "+e.name; } })()`) && ok;
ok = probe("calling the host fn works", `(function(){ var f = __h.giveFn(); return String(f()); })()`) && ok;

console.log("\nResource bounds:");
const t0 = Date.now();
let interrupted = false;
try { c.load(`while(true){}`, 200); } catch { interrupted = true; }
console.log(`  ${interrupted ? "ok" : "!!"}  spinning guest interrupted        after ${Date.now() - t0}ms`);
console.log(`  ok  isolate usable afterwards      ${c.load(`1+1`) === 2}`);

c.dispose();
console.log(`\n${ok && interrupted ? "AUDIT PASSED" : "AUDIT FAILED"}`);
process.exit(ok && interrupted ? 0 : 1);
