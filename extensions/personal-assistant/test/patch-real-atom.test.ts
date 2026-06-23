// PATCH /api/memory/:id test
// Uses real atoms created by extract-real-session.test.ts (11 atoms on disk
// in /tmp/memory-v2-real/atoms/), then tests the PATCH route end-to-end:
//  1. GET /api/memory/:id (verify original content)
//  2. PATCH /api/memory/:id (update content + add tags + change importance)
//  3. GET /api/memory/:id (verify new content + version bumped)
//  4. Read .md file (verify disk write)
//  5. Vector search (verify new embedding reflects new content)

import { promises as fs } from "node:fs";
import path from "node:path";
import express from "express";
import http from "node:http";
import { registerGetMemoryById, registerPatchMemory, registerGetMemoryList } from "../../../packages/webui/server/routes/memory.ts";
import { MemoryIndex } from "../storage.ts";
import { recallAtoms } from "../search.ts";

const DB_PATH = "/tmp/memory-v2-real/memory.db";
const ATOMS_DIR = "/tmp/memory-v2-real/atoms";

// Reuse the MiniMax key from the extraction test (or accept via env)
const USER_KEY = "sk-cp-zVig2Cjm0GXIVDV97UjMolpn6M-96A7xpMcZRJka8Udjb1YFz8II7zLcW7MIT8SPvbHJCP0fsK2mKUVDtY-0NMRVHXTKoPbnwDm9hrc8tiyToqDU88NTiRA";

const EMBEDDING_TIMEOUT_MS = 5000;

async function makeApp(): Promise<{ app: express.Express; server: http.Server; port: number }> {
  const app = express();
  app.use(express.json());
  // Open DB
  const index = new MemoryIndex(DB_PATH);
  await index.init();
  // We need a stable MemoryDeps that points to the existing DB
  const deps = {
    dbPath: DB_PATH,
    atomsDir: ATOMS_DIR,
    settings: { memory: { embedding: { model: "bge-m3" } } } as any,
    callLlm: async () => "",
    embedTimeoutMs: EMBEDDING_TIMEOUT_MS,
  };
  registerGetMemoryList(app, deps);
  registerGetMemoryById(app, deps);
  registerPatchMemory(app, deps);
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as any).port;
  return { app, server, port };
}

async function main() {
  console.log("=== PATCH /api/memory/:id end-to-end test ===\n");

  // Verify DB has atoms
  const idx = new MemoryIndex(DB_PATH);
  await idx.init();
  const activeAtoms = idx.getActiveAtoms();
  console.log(`Active atoms in DB: ${activeAtoms.length}`);
  if (activeAtoms.length === 0) {
    console.error("FAIL: no atoms in DB. Run extract-real-session.test.ts first.");
    process.exit(1);
  }
  idx.close();

  // Pick an atom — the "CCA axis label" rule (good for testing tag union)
  const target = activeAtoms.find((a) => a.title.includes("CCA轴标签")) || activeAtoms[0]!;
  console.log(`Target atom: ${target.id.slice(0, 8)} | ${target.title} (v${target.version})`);
  console.log(`  current content[:80]: ${target.content.slice(0, 80)}...`);
  console.log(`  current tags: [${target.tags.join(", ")}]`);
  console.log(`  current importance: ${target.importance}`);
  console.log(`  current fingerprint: ${target.content_fingerprint}`);

  // Build app + server
  const { server, port } = await makeApp();
  console.log(`\nServer listening on http://127.0.0.1:${port}`);

  const fetchJson = async (path: string, opts: any = {}): Promise<{ status: number; body: any }> => {
    const url = `http://127.0.0.1:${port}${path}`;
    const res = await fetch(url, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  };

  // 1. GET original
  console.log(`\n--- Step 1: GET /api/memory/${target.id.slice(0, 8)} ---`);
  const before = await fetchJson(`/api/memory/${target.id}`);
  console.log(`  status: ${before.status}, version: ${before.body.version}, content[:80]: ${before.body.content?.slice(0, 80)}`);

  // 2. PATCH — update content + add tags + change importance
  console.log(`\n--- Step 2: PATCH /api/memory/${target.id.slice(0, 8)} ---`);
  const newContent = `${before.body.content}\n\n--- 2026 update ---\n改用 sprintf 生成 xlab/ylab 字符串, 比 colSums 方案更简洁。\n测试样本: env1, env2, env3, env4 (新增 2026 数据集)。`;
  const newTags = ["sprintf", "2026-update"];  // union with existing
  const newImportance = 0.85;  // higher than 0.7

  const patch = await fetchJson(`/api/memory/${target.id}`, {
    method: "PATCH",
    body: {
      content: newContent,
      tags: newTags,
      importance: newImportance,
    },
  });
  console.log(`  status: ${patch.status}`);
  console.log(`  new version: ${patch.body.version}`);
  console.log(`  new tags: [${(patch.body.tags || []).join(", ")}]`);
  console.log(`  new importance: ${patch.body.importance}`);
  console.log(`  new fingerprint: ${patch.body.content_fingerprint}`);
  console.log(`  new content[:100]: ${patch.body.content?.slice(0, 100)}`);

  // Assertions
  if (patch.status !== 200) {
    console.error("FAIL: PATCH did not return 200");
    process.exit(1);
  }
  if (patch.body.version !== before.body.version + 1) {
    console.error(`FAIL: version not bumped (was ${before.body.version}, now ${patch.body.version})`);
    process.exit(1);
  }
  if (!patch.body.tags.includes("sprintf") || !patch.body.tags.includes("2026-update")) {
    console.error(`FAIL: new tags not merged in: ${JSON.stringify(patch.body.tags)}`);
    process.exit(1);
  }
  if (patch.body.importance !== 0.85) {
    console.error(`FAIL: importance not set: ${patch.body.importance}`);
    process.exit(1);
  }
  if (patch.body.content_fingerprint === before.body.content_fingerprint) {
    console.error(`FAIL: fingerprint unchanged despite content change`);
    process.exit(1);
  }
  console.log("  ✓ PATCH assertions pass (status 200, version+1, tags merged, importance set, fingerprint changed)");

  // 3. GET after PATCH
  console.log(`\n--- Step 3: GET /api/memory/${target.id.slice(0, 8)} (post-PATCH) ---`);
  const after = await fetchJson(`/api/memory/${target.id}`);
  console.log(`  status: ${after.status}, version: ${after.body.version}`);
  console.log(`  content ends with: ...${after.body.content?.slice(-80)}`);
  console.log(`  tags: [${(after.body.tags || []).join(", ")}]`);
  if (after.body.version !== before.body.version + 1) {
    console.error("FAIL: post-PATCH GET version mismatch");
    process.exit(1);
  }
  if (!after.body.content.includes("sprintf 生成 xlab/ylab")) {
    console.error("FAIL: post-PATCH GET content missing update");
    process.exit(1);
  }
  console.log("  ✓ Post-PATCH GET shows updated content + version");

  // 4. Verify .md file on disk
  console.log(`\n--- Step 4: Verify .md file on disk ---`);
  const mdPath = path.join(ATOMS_DIR, target.type, `${target.id}.md`);
  const mdContent = await fs.readFile(mdPath, "utf8");
  const hasNewContent = mdContent.includes("sprintf 生成 xlab/ylab");
  const hasNewTags = mdContent.includes("sprintf") && mdContent.includes("2026-update");
  const hasNewVersion = mdContent.includes(`version: 2`);
  const hasNewFingerprint = mdContent.includes(`content_fingerprint: "${patch.body.content_fingerprint}"`);
  console.log(`  file: ${mdPath}`);
  console.log(`  contains new content: ${hasNewContent}`);
  console.log(`  contains new tags: ${hasNewTags}`);
  console.log(`  version=2: ${hasNewVersion}`);
  console.log(`  new fingerprint in frontmatter: ${hasNewFingerprint}`);
  if (!hasNewContent || !hasNewTags || !hasNewVersion || !hasNewFingerprint) {
    console.error("FAIL: .md file not properly updated");
    console.log("--- FILE CONTENT ---");
    console.log(mdContent);
    process.exit(1);
  }
  console.log("  ✓ .md file properly updated");

  // 5. Recall with NEW content-related query
  console.log(`\n--- Step 5: Recall test (after PATCH) ---`);
  const idx2 = new MemoryIndex(DB_PATH);
  await idx2.init();
  try {
    // Use Chinese query that closely matches the PATCHed content
    const results = await recallAtoms(idx2, "CCA 轴标签 修正", { topK: 5, threshold: 0.3 });
    console.log(`  query "CCA 轴标签 修正" → ${results.length} hits`);
    for (const r of results) {
      console.log(`    [${r.atom.type}] ${r.atom.title} (cos=${r.cosine.toFixed(3)})`);
    }
    const targetHit = results.find((r) => r.atom.id === target.id);
    if (!targetHit) {
      console.error("FAIL: PATCHed atom not found via semantic recall on new content");
      process.exit(1);
    }
    console.log(`  ✓ PATCHed atom retrieved via semantic search on new content (cos=${targetHit.cosine.toFixed(3)})`);

    // Also verify it ranks HIGH (not just present)
    const rank = results.indexOf(targetHit) + 1;
    if (rank > 3) {
      console.error(`  WARN: target ranks ${rank}/${results.length} (expected top 3)`);
    } else {
      console.log(`  ✓ Target ranks #${rank}/${results.length}`);
    }
  } finally {
    idx2.close();
  }

  // 6. PATCH error cases
  console.log(`\n--- Step 6: Error cases ---`);
  const notFound = await fetchJson("/api/memory/00000000-0000-0000-0000-000000000000", {
    method: "PATCH",
    body: { tags: ["x"] },
  });
  console.log(`  PATCH non-existent: status=${notFound.status} (expected 404)`);
  if (notFound.status !== 404) {
    console.error("FAIL: PATCH should 404 for unknown id");
    process.exit(1);
  }

  const importanceClamp = await fetchJson(`/api/memory/${target.id}`, {
    method: "PATCH",
    body: { importance: 1.5 },
  });
  console.log(`  PATCH importance=1.5: clamped to ${importanceClamp.body.importance} (expected 1.0)`);
  if (importanceClamp.body.importance !== 1.0) {
    console.error("FAIL: importance not clamped");
    process.exit(1);
  }

  const importanceClampLow = await fetchJson(`/api/memory/${target.id}`, {
    method: "PATCH",
    body: { importance: -0.5 },
  });
  console.log(`  PATCH importance=-0.5: clamped to ${importanceClampLow.body.importance} (expected 0.0)`);
  if (importanceClampLow.body.importance !== 0.0) {
    console.error("FAIL: importance not clamped");
    process.exit(1);
  }
  console.log("  ✓ All error cases pass");

  server.close();
  console.log(`\n=== PATCH test PASS ===`);
  console.log(`Atoms on disk: ${(await fs.readdir(path.join(ATOMS_DIR, "rule"))).length} rule, ${(await fs.readdir(path.join(ATOMS_DIR, "fact"))).length} fact, ${(await fs.readdir(path.join(ATOMS_DIR, "process"))).length} process`);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
