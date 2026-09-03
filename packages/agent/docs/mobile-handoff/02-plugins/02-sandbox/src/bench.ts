/**
 * Cost of the isolate, the membrane, and a real component at transcript scale.
 * Compare against `../facet-sandbox-poc` (QuickJS) and native.
 */
import ivm from "isolated-vm";
import { readFileSync } from "node:fs";
import { createCompartment } from "./membrane.ts";

// ── membrane crossing ─────────────────────────────────────────────────────
{
  const c = await createCompartment();
  await c.endow("__h", { echo: (v: unknown) => v });
  c.load(`globalThis.spin = function (n) { for (var i = 0; i < n; i++) __h.echo("x"); };`);
  c.load(`spin(2000);`);
  const N = 20000, t = Date.now();
  c.load(`spin(${N});`, 60000);
  console.log(`membrane crossing:            ${((Date.now() - t) * 1000 / N).toFixed(1)} µs`);
  c.dispose();
}

// ── isolate creation ──────────────────────────────────────────────────────
{
  const before = process.memoryUsage().rss, t = Date.now();
  const held = Array.from({ length: 50 }, () => {
    const iso = new ivm.Isolate({ memoryLimit: 32 });
    const ctx = iso.createContextSync();
    ctx.evalSync(`var c = { render: function () { return ["x"]; } };`);
    return iso;
  });
  console.log(`50 isolates:                  ${(((process.memoryUsage().rss - before) / 50) / 1024).toFixed(0)} KB each, ${Date.now() - t} ms total`);
  for (const i of held) i.dispose();
}

// ── real Markdown at transcript scale ─────────────────────────────────────
{
  const iso = new ivm.Isolate({ memoryLimit: 512 });
  const ctx = iso.createContextSync();
  ctx.global.setSync("global", ctx.global.derefInto());
  const t = Date.now();
  ctx.evalSync(readFileSync(new URL("./markdown-bundle.js", import.meta.url), "utf8"), { timeout: 60000 });
  console.log(`146 KB bundle load:           ${Date.now() - t} ms`);
  for (const [label, pts] of [["small", 2], ["typical", 8], ["large", 35]] as [string, number][]) {
    ctx.evalSync(`__bench(${pts}, 20, 50)`, { timeout: 120000 });      // warm the JIT
    const ms = ctx.evalSync(`__bench(${pts}, 300, 3)`, { timeout: 300000 });
    console.log(`300 markdown components, ${label.padEnd(8)} ${ms.toFixed(0)} ms per full repaint`);
  }
  iso.dispose();
}
