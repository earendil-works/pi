import ivm from "isolated-vm";
const rss = () => process.memoryUsage().rss / 1024 / 1024;

// 1. Are two CONTEXTS in one isolate isolated from each other?
{
  const iso = new ivm.Isolate({ memoryLimit: 64 });
  const a = iso.createContextSync(), b = iso.createContextSync();
  a.evalSync(`globalThis.secret = "from-A"`);
  console.log("context B sees A's global:", b.evalSync(`typeof globalThis.secret`));
  // Can a spin in A be timed out without harming B?
  try { a.evalSync(`while(true){}`, { timeout: 100 }); } catch { /* expected */ }
  console.log("B usable after A was interrupted:", b.evalSync(`1+1`) === 2);
  // Does A's memory bomb kill B?
  try { a.evalSync(`var x=[]; for(;;) x.push(new Array(50000).fill(1));`, { timeout: 15000 }); }
  catch (e: any) { console.log("A bomb:", e.message.slice(0, 45)); }
  try { console.log("B after A's bomb:", b.evalSync(`1+1`)); }
  catch (e: any) { console.log("B after A's bomb: DEAD -", e.message.slice(0, 40)); }
  try { iso.dispose(); } catch {}
}

// 2. Cost per facet, both ways.
for (const mode of ["one isolate, N contexts", "N isolates"]) {
  const before = rss(), t = Date.now();
  const held: any[] = [];
  const shared = mode.startsWith("one") ? new ivm.Isolate({ memoryLimit: 512 }) : null;
  for (let i = 0; i < 50; i++) {
    const iso = shared ?? new ivm.Isolate({ memoryLimit: 32 });
    const ctx = iso.createContextSync();
    ctx.evalSync(`var c = { render: function () { return ["x"]; } };`);
    held.push(iso);
  }
  console.log(`50 facets, ${mode.padEnd(24)}: ${(((rss() - before) / 50) * 1024).toFixed(0)} KB each, ${Date.now() - t} ms`);
  if (shared) { try { shared.dispose(); } catch {} } else for (const i of held) { try { i.dispose(); } catch {} }
}
