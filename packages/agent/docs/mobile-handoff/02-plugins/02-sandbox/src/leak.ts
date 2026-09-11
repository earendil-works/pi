import { createCompartment } from "./membrane.ts";
const c = await createCompartment();
let seen = 0;
await c.endow("__l", { drop: (_fn: unknown) => { seen++; } });
c.load(`globalThis.churn = function (n) { for (var i = 0; i < n; i++) __l.drop(function () { return i; }); };`);

const rss = () => process.memoryUsage().rss / 1024 / 1024;
const before = rss();
c.load(`churn(20000);`, 60000);
const peak = c.debugRefCount();
const afterChurn = rss();

globalThis.gc?.(); await new Promise((r) => setTimeout(r, 100));
globalThis.gc?.(); await new Promise((r) => setTimeout(r, 100));
const settled = c.debugRefCount();

console.log(`20000 crossings: host called ${seen}x`);
console.log(`  guest refs:  ${peak.guestRefs} -> ${settled.guestRefs}`);
console.log(`  host table:  ${peak.hostTable} -> ${settled.hostTable}`);
console.log(`  rss: ${before.toFixed(0)} -> ${afterChurn.toFixed(0)} -> ${rss().toFixed(0)} MB`);

// Cost of the release path: one evalSync crossing per finalized ref.
const t = Date.now();
c.load(`churn(5000);`, 60000);
globalThis.gc?.(); await new Promise((r) => setTimeout(r, 200));
console.log(`  5000 more + gc: ${Date.now() - t} ms, refs now ${c.debugRefCount().guestRefs}`);
c.dispose();
