import { readFileSync } from "node:fs";
import { createCompartment } from "./membrane.ts";
const mounted = new Map(), commands = new Map(), notifications = [], subs = [];
const Tui = {
  slots: { claim: (s, f) => mounted.set(s, f) },
  commands: { add: (n, h) => commands.set(n, h) },
  notify: (m) => notifications.push(m),
};
const Transcript = { tail: { subscribe: (f) => subs.push(f) } };
const c = await createCompartment();
await c.endow("__host", { use: (t) => (t === "Tui" ? Tui : Transcript) });
c.load(readFileSync(new URL("./facet-example.js", import.meta.url), "utf8"));
c.load(`globalThis.__r = __facet.construct({ use: function (t) { return __host.use(t); } });`);
console.log("contributions:", { slots: [...mounted.keys()], commands: [...commands.keys()], subs: subs.length });
const comp = mounted.get("footer")({ label: "presses" });
console.log(comp.render(30).join("\n"));
comp.handleInput("abc");
console.log(comp.render(30).join("\n"));
console.log("command ->", commands.get("footer.reset")());
subs[0]({ entries: [1, 2, 3] });
console.log("notifications:", notifications);
c.dispose();
