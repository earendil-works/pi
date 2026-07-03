# migration/atom-remigrate Specification

Capability: one-shot memory corpus dedup + extract pipeline improvement to prevent future redundancy. Targets 90 legacy atoms + all future extract emissions.

## ADDED Requirements

### Requirement: Legacy Atom Migration Script
The system SHALL provide a one-shot script `migrate-legacy-atoms.mts` that performs programmatic 0.65-cosine deduplication against the active atom corpus, with backup + idempotency.

#### Scenario: One-shot programmatic 0.65 dedup migration runs
- **GIVEN** memory.db contains 90 active atoms (90 .md files in `atoms/{type}/`)
- **AND** bge-m3 service runs at `127.0.0.1:11435` (not called by this script — content unchanged, vectors still correct)
- **WHEN** user runs `npx tsx extensions/personal-assistant/scripts/migrate-legacy-atoms.mts`
- **THEN** script backs up memory.db → `memory.db.bak.YYYYMMDD`
- **AND** script reads 90 atoms, sorts by `(access_count DESC, last_access DESC NULLS LAST, created_at DESC)`
- **AND** for each atom, script reads its embedding from `memory_vectors`, calls `findMostSimilarEmbedding(embedding, 0.65)`
- **AND** if hit (not self), script calls `markSupersededNoInsert(hit.id, atom.id, now)` to mark hit archived
- **AND** script outputs "migration done: 90 → 75 active (archived 15). Re-run idempotent."

#### Scenario: Same-cluster 0.65+ cosine pair automatically merges
- **GIVEN** corpus has 2 atoms: "扩增子物种注释结果文件" (embedding A) and "扩增子物种注释结果文件路径" (embedding B), A↔B dense cosine = 0.756
- **AND** sort places A first (higher access_count or last_access)
- **WHEN** script iterates to A
- **THEN** `findMostSimilarEmbedding(A, 0.65)` returns B (cosine 0.756 ≥ 0.65)
- **AND** script calls `markSupersededNoInsert(B.id, A.id, now)`: B marked is_latest=0, parent_id=A, superseded_at=now
- **AND** A unchanged (id preserved, active, the "winner")
- **WHEN** script later iterates to B
- **THEN** B is already is_latest=0, `getActiveAtoms()` filters it out, script skips
- **AND** recall shows only A (B excluded), precision improves

#### Scenario: Atom content length is not expanded
- **GIVEN** 2 atoms with cluster relation; one has 200-char content, the other 300-char
- **WHEN** 0.65 dedup merge (hot atom wins)
- **THEN** winner keeps original content (200 or 300 chars), no lengthening
- **AND** bge-m3 vector still matches (content unchanged)
- **AND** recall shows user the 200 or 300 char version, not 500 chars (token savings)

#### Scenario: Idempotent re-run produces 0 changes
- **GIVEN** first migration completed, corpus no longer has cosine ≥ 0.65 pairs (dedup terminal state)
- **WHEN** user re-runs `npx tsx extensions/personal-assistant/scripts/migrate-legacy-atoms.mts`
- **THEN** second run: for each atom, `findMostSimilarEmbedding(embedding, 0.65)` returns self (cosine 1.0)
- **AND** self-match guard path, no-op
- **AND** 0 markSupersededNoInsert calls, 0 reindex
- **AND** report shows "0 changes (idempotent)"

#### Scenario: Backup creation failure aborts migration safely
- **GIVEN** memory.db is 4.4MB, target backup path disk is full
- **WHEN** `cp memory.db memory.db.bak.YYYYMMDD` fails
- **THEN** script aborts, logs "backup failed, refusing to migrate"
- **AND** 0 atoms changed

#### Scenario: User can rollback migration via backup file
- **GIVEN** migration completed, user runs recall once and finds "扩增子" recall has 1 result but needed 2 (some cluster wrongly merged)
- **WHEN** user runs `cp memory.db.bak.YYYYMMDD memory.db`
- **AND** user restarts bge-m3 service (it auto-rebuilds in-memory index from db on startup)
- **THEN** recall returns to pre-migration state (all ids present, all is_latest=1, content is pre-migration)

#### Scenario: Re-run with lower threshold 30 days later
- **GIVEN** first 0.65 dedup run completed, corpus 75 atoms, precision improved but 0.55-0.65 range cluster remnants
- **WHEN** user runs `npx tsx migrate-legacy-atoms.mts --threshold=0.60` (script supports CLI threshold)
- **THEN** second run with 0.60 dedup catches 36 new pairs (90 → 65)
- **AND** 0 mis-merges (sample data shows all real clusters)
- **AND** idempotent: 0.65-merged clusters not re-superseded by 0.60 (already archived)

#### Scenario: 30 days later user wants to re-run on smaller corpus
- **GIVEN** user manually archived 20 atoms before migration
- **WHEN** script scans active atoms, only sees 70
- **THEN** script only processes these 70, backup file size corresponds to full DB (90 rows)
- **AND** log shows "found 70 active atoms (db has N total, N-70 are archived/superseded)"

### Requirement: Cosine Dedup Threshold Alignment
The system SHALL use a single cosine dedup threshold of 0.65 across all write paths, providing a 0.10 buffer above the recall floor (0.55) and catching real cluster pairs that the legacy 0.92 threshold missed.

#### Scenario: supersedeIfSimilar uses 0.65 as default threshold
- **GIVEN** a write path calls `supersedeIfSimilar(index, atomsDir, newAtom, embedding)` without specifying threshold
- **WHEN** the function runs
- **THEN** it calls `findMostSimilarEmbedding(embedding, 0.65)` (0.65 default, not 0.92)

#### Scenario: 0.65 threshold catches real cluster pairs (X101SC)
- **GIVEN** corpus has 2 atoms: "X101SC26052587 客户数据未回传" and "X101SC26052587 当前阻塞状态", cosine 0.708
- **WHEN** 0.65 dedup runs
- **THEN** pair is detected and merged (cosine 0.708 ≥ 0.65)

#### Scenario: 0.65 threshold catches real cluster pairs (iCAMP)
- **GIVEN** corpus has 2 atoms: "iCAMP分组柱状图顺序修复" and "iCAMP bar chart group order fix script", cosine 0.758
- **WHEN** 0.65 dedup runs
- **THEN** pair is detected and merged (cosine 0.758 ≥ 0.65)

#### Scenario: 0.65 threshold does not over-merge (preserves 0.55-0.65 borderline)
- **GIVEN** corpus has 2 atoms with cosine 0.58 (below 0.65)
- **WHEN** 0.65 dedup runs
- **THEN** pair is NOT merged (cosine 0.58 < 0.65, threshold not met)

### Requirement: Extract Pipeline LLM 二次确认 Dedup
The system SHALL, when `executeItem` finds a cosine ≥ 0.65 match between a new extraction item and an existing atom, call an LLM with both contents to determine the correct action (update / supersede / create / skip), rather than auto-superseding.

#### Scenario: Cosine < 0.65 — no LLM call, direct insert
- **GIVEN** extract emits a new topic item, `findMostSimilarEmbedding(0.65)` returns null or cosine < 0.65
- **THEN** executeItem takes create path: `index.insertAtom` + `writeAtomToFile` + bge-m3 reindex
- **AND** LLM dedup confirmation is NOT called (skip LLM cost for the 80% common case)
- **AND** this is the typical new-topic case

#### Scenario: Cosine ≥ 0.65 hit + LLM returns "update" — in-place merge
- **GIVEN** user session mentions "check_seq.py 又改了输出格式,现在支持 JSON"
- **AND** corpus has atom "check_seq.py 脚本位置与输出格式" (tsv format)
- **WHEN** extract LLM emits an item, `executeItem` finds hit with cosine 0.77
- **THEN** executeItem calls LLM 二次确认 with hit.atom + newItem contents
- **AND** LLM returns `{ action: "update", merged: { title: "check_seq.py 脚本位置与输出格式", content: "原 content + 2026-07 新增 JSON 格式支持" } }`
- **THEN** executeItem takes update path: `index.updateAtom(mergedAtom)` in-place, version+1, `writeAtomToFile`, bge-m3 reindex
- **AND** old atom id preserved, new info merged in

#### Scenario: Cosine ≥ 0.65 hit + LLM returns "supersede" — new atom replaces old
- **GIVEN** extract emits "扩增子物种注释结果文件" (item), corpus has "扩增子物种注释结果文件路径" (hit, cosine 0.756)
- **WHEN** LLM 二次确认 reviews hit+item
- **THEN** LLM judges this as nearly synonymous (file vs file path, 2 char difference), returns `action: "supersede"`
- **THEN** executeItem takes supersede path: `index.markSupersededTx(hit.id, item, embedding)`, hit marked archived+parent_id=item.id, item exists independently, `writeAtomToFile` + bge-m3 reindex

#### Scenario: Cosine ≥ 0.65 hit + LLM returns "create" — independent new atom
- **GIVEN** extract emits "iCAMP 分组柱状图顺序修复" (item), corpus has "iCAMP 分组顺序 Skill 注册信息" (hit, cosine 0.78)
- **WHEN** LLM 二次确认 reviews hit+item
- **THEN** LLM judges these are different topics (one is fix, one is Skill registration), returns `action: "create"`
- **THEN** executeItem takes create path: hit unchanged, item inserted independently, `writeAtomToFile` + bge-m3 reindex
- **AND** recall shows both atoms, user selects which is relevant

#### Scenario: Cosine ≥ 0.65 hit + LLM returns "skip" — full duplicate, no-op
- **GIVEN** LLM 二次确认 reviews hit+item, judges info fully duplicate (fingerprint dedup missed, but cosine 0.65+ matched)
- **WHEN** LLM returns `action: "skip"`
- **THEN** executeItem writes no files, item dropped, trace logs "dedup-confirm: skip"

#### Scenario: LLM 二次确认 fails (timeout / JSON parse) — fallback to supersede
- **GIVEN** LLM 二次确认 call hits 5s timeout or returns non-JSON
- **THEN** executeItem takes fallback path: `action: "supersede"` (conservative, matches cosine 0.65 hit)
- **AND** logs warn: "LLM dedup confirm failed for item X (hit Y), fell back to supersede"
- **AND** does not interrupt, continues with next item

### Requirement: Tag Vocabulary Injection
The system SHALL compute a top-50 high-frequency tag vocabulary from the active corpus at extract time and inject it into `EXTRACT_PROMPT_V2` so the LLM reuses existing tags rather than inventing near-synonyms.

#### Scenario: Tag dictionary loaded and injected at first extract
- **GIVEN** corpus has 90 atoms loaded
- **WHEN** `extractMemoriesWithCallLlm` is first called
- **THEN** construct prompt by first calling `loadTagVocabulary(index)` (new function), scanning `memory_index.tags` column (JSON parse), tallying frequency, taking top 50
- **AND** inject into prompt top: "## 现有 tag 字典 (优先复用,不要发明新近义 tag)\n" + comma-joined tags
- **AND** tagVocabulary cached in-memory until session end (not recomputed per extract)

#### Scenario: Tag dictionary injection prompt content
- **GIVEN** session triggers `session_before_compact` extract
- **WHEN** LLM receives prompt
- **THEN** prompt contains a section:
  ```
  ## 现有 tag 字典 (优先复用,不要发明新近义 tag)
  amplicon, 16S, MTB, R, 扩增子, 修复, bug, fix, position, location,
  flow, process, rule, prefer, prefer-not, prefer-must, ...
  
  ## Tag 规范
  - 大小写归一: 全部 lowercase (中文不变)
  - 同义合并: 写 "Amplicon" 视作 "amplicon"; 写 "Bug 修复" 视作 "bug fix"
  - 概念性 tag 至少 1 个 (动作/类别)
  - 总数 3-6 个
  ```

#### Scenario: LLM sees updatable new info and updates existing atom
- **GIVEN** user session mentions "check_seq.py 又改了输出格式,现在支持 JSON"
- **AND** corpus has atom "check_seq.py 脚本位置与输出格式" (tsv format)
- **WHEN** extract LLM analyzes this new info
- **THEN** LLM sees "## 主动更新,非扩张" rule in prompt
- **AND** LLM decides: append "2026-07 新增 JSON 格式支持" to existing atom content, do NOT create new atom
- **THEN** `executeItem` takes supersede path (cosine ≥ 0.65 hit, Decision 10), new version replaces old

#### Scenario: LLM emits new item but program dedup catches it (fallback)
- **GIVEN** LLM emits "check_seq.py 新增 JSON 格式支持" but missed the updatable existing atom
- **WHEN** `executeItem` runs fingerprint dedup + 0.65 cosine dedup
- **AND** new atom content_fingerprint matches existing → skip
- **OR** new atom cosine ≥ 0.65 with existing → supersede
- **THEN** existing atom content updated, new atom does not exist independently

#### Scenario: Corpus empty — tag dictionary injection is empty string
- **GIVEN** user first launch, corpus 0 atoms
- **WHEN** first extract triggers
- **THEN** `loadTagVocabulary` returns empty set, prompt's "## 现有 tag 字典" section reads "(空,自由 emit)"
- **AND** no error, extract proceeds normally

#### Scenario: Corpus at 1000 atoms — dictionary scan stays fast
- **GIVEN** corpus has 1000 atoms
- **WHEN** `loadTagVocabulary` scans all active atom tags columns
- **THEN** single scan ~50ms, cached in-memory for the whole session
- **AND** user does not perceive delay (session_before_compact already has 1-2s LLM call)

### Requirement: Program-Side Tag Normalization
The system SHALL normalize LLM-emitted tags in `executeItem` to ensure corpus-wide tag consistency, including lowercase folding, dictionary match priority, and concept-tag count check.

#### Scenario: Tag lowercase normalization (Chinese unchanged)
- **GIVEN** LLM emits `["Amplicon", "X101SC", "16S", "扩增子"]`
- **WHEN** `normalizeTag` is called on each (no dictionary)
- **THEN** result is `["amplicon", "x101sc", "16s", "扩增子"]` (Chinese unchanged via Unicode range detection)

#### Scenario: Tag dictionary match priority (MGM stays MGM)
- **GIVEN** dictionary contains "MGM"
- **WHEN** `normalizeTag` is called on "MGM" with that dictionary
- **THEN** returns "MGM" (not lowercased, because dictionary match takes priority)

#### Scenario: Tag dictionary match priority (Amplicon folds to amplicon)
- **GIVEN** dictionary contains "amplicon" (lowercase canonical)
- **WHEN** `normalizeTag` is called on "Amplicon" with that dictionary
- **THEN** returns "amplicon" (dictionary canonical form used)

#### Scenario: LLM emits all-proper-noun tags — concept warning
- **GIVEN** LLM emits `["Amplicon", "X101SC", "16S"]` (all proper nouns, no concept/* tags)
- **WHEN** `conceptTagCount` runs on these tags
- **THEN** returns 0
- **AND** executeItem logs warn: "item X lacks concept tag (0/N tags are concept/*)"
- **AND** item is still written (warning, not rejection — don't lose data)

### Requirement: EXTRACT_PROMPT_V2 Active Update Rule
The system SHALL include an "## 主动更新,非扩张" section in `EXTRACT_PROMPT_V2` instructing the LLM to prefer updating existing atoms over creating new ones when the new information belongs to an existing topic.

#### Scenario: EXTRACT_PROMPT_V2 contains active-update rule
- **WHEN** `EXTRACT_PROMPT_V2` is read
- **THEN** it contains the section:
  ```
  ## 主动更新,非扩张 (重要!)
  
  - 如果新信息可归入 corpus 已有的 atom (主题/对象/项目相同), 优先更新该 atom 的 content, 不要为这条信息创建新 atom
  - 更新方式: 在 content 末尾追加新段落, 标注日期 (e.g. "2026-07 新增 JSON 格式支持")
  - 仅在信息属于全新主题/新对象/新项目时才创建新 atom
  - 这是 corpus 持续精炼的关键: 主动合并而非堆叠
  ```

## MODIFIED Requirements

### Requirement: supersedeIfSimilar Default Threshold
<!-- Originally: `supersedeIfSimilar` uses 0.92 cosine as the default dedup threshold. New: 0.65. -->
The `supersedeIfSimilar` function in `extensions/personal-assistant/dedup.ts` SHALL use 0.65 as the default cosine similarity threshold for dedup decisions when the caller does not specify `threshold`. The function SHALL continue to accept an optional `threshold` parameter for callers that want a different value (e.g. CLI migration script with `--threshold=0.60`).

#### Scenario: Caller does not specify threshold — 0.65 used
- **GIVEN** a write path calls `supersedeIfSimilar(index, atomsDir, newAtom, embedding)` without threshold arg
- **WHEN** the function calls `index.findMostSimilarEmbedding(embedding, threshold)`
- **THEN** it uses `0.65` as the threshold

#### Scenario: Caller specifies threshold — that value used
- **GIVEN** a write path calls `supersedeIfSimilar(index, atomsDir, newAtom, embedding, 0.80)`
- **WHEN** the function calls `index.findMostSimilarEmbedding(embedding, threshold)`
- **THEN** it uses `0.80` (caller's value, not the default)

#### Scenario: Cosine 0.64 pair not merged
- **GIVEN** corpus has 2 atoms with cosine 0.64
- **WHEN** `supersedeIfSimilar` runs with default threshold
- **THEN** pair is NOT merged (0.64 < 0.65)

#### Scenario: Cosine 0.66 pair merged
- **GIVEN** corpus has 2 atoms with cosine 0.66
- **WHEN** `supersedeIfSimilar` runs with default threshold
- **THEN** pair is merged (0.66 ≥ 0.65)

#### Scenario: Self-match guard — cosine 1.0 returns create
- **GIVEN** caller is PATCHing an existing atom, the most similar match is the atom itself (cosine 1.0)
- **WHEN** `supersedeIfSimilar` runs
- **THEN** returns `{ status: "create", atom: newAtom }` (self-match guard, no superseded attempt that would fail PRIMARY KEY)

### Requirement: markSupersededTx Behavior (unchanged, but new no-insert variant)
The `markSupersededTx` method in `extensions/personal-assistant/storage.ts` SHALL continue to perform INSERT new row + UPDATE old row in one transaction. A NEW companion method `markSupersededNoInsert(oldId, parentId, now)` SHALL perform ONLY the UPDATE (mark old as archived, set parent_id, set superseded_at) without inserting a new row, for use by the migration script where the "winner" atom already exists with a different id.

#### Scenario: markSupersededTx inserts new row + marks old archived
- **GIVEN** extract emits new item, `supersedeIfSimilar` finds hit
- **WHEN** `markSupersededTx(hit.id, newAtom, embedding)` runs
- **THEN** INSERT new row with new id + UPDATE old row `is_latest=0, superseded_at=now` in single transaction

#### Scenario: markSupersededNoInsert only updates old row
- **GIVEN** migration script identifies cluster pair (winner A, hit B)
- **WHEN** `markSupersededNoInsert(B.id, A.id, now)` runs
- **THEN** UPDATE `memory_index` SET `is_latest=0, parent_id=A.id, superseded_at=now` WHERE id=B.id
- **AND** no INSERT of new row
- **AND** B's vector in `memory_vectors` unchanged (content unchanged, vector still correct)

#### Scenario: Migration script uses markSupersededNoInsert
- **GIVEN** migration script processes corpus and finds 0.65 cosine pair (winner A, hit B)
- **WHEN** script calls `markSupersededNoInsert(B.id, A.id, now)` for each pair
- **THEN** B rows marked archived + parent_id=A
- **AND** `getActiveAtoms()` no longer returns B
- **AND** recall uses A only (B excluded from active corpus)

### Requirement: ExecutePlan Signature (extended with callLlm)
The `executePlan` function in `extensions/personal-assistant/extraction.ts` SHALL accept an optional `callLlm` parameter that is passed through to `executeItem` for the LLM 二次确认 dedup decision path. When `callLlm` is undefined, the legacy behavior is preserved (no LLM 二次确认, `supersedeIfSimilar` auto-supersede path).

#### Scenario: executePlan with callLlm — LLM 二次确认 enabled
- **GIVEN** `extractMemoriesWithCallLlm` calls `executePlan(index, atomsDir, plan, callLlm)` with the LLM callback
- **WHEN** `executeItem` finds cosine ≥ 0.65 hit
- **THEN** executeItem uses callLlm to confirm the dedup action
- **AND** behavior follows the LLM 二次确认 scenarios above

#### Scenario: executePlan without callLlm — legacy behavior
- **GIVEN** a test calls `executePlan(index, atomsDir, plan)` without callLlm
- **WHEN** executeItem runs
- **THEN** executeItem skips LLM 二次确认, falls back to `supersedeIfSimilar` auto-supersede
- **AND** legacy behavior preserved (backward compatibility)

### Requirement: ExecuteItem Behavior (cosine hit → LLM 二次确认)
The `executeItem` function in `extensions/personal-assistant/extraction.ts` SHALL, when finding a cosine ≥ 0.65 match between a new extraction item and an existing atom, call the LLM 二次确认 to determine the action (update/supersede/create/skip) rather than auto-supersede. The function SHALL also normalize tags and warn on missing concept tags before write.

#### Scenario: executeItem normalizes tags before write
- **GIVEN** LLM emits item with `tags: ["Amplicon", "16S", "扩增子"]`
- **WHEN** executeItem processes this item
- **THEN** it calls `normalizeTag` on each tag
- **AND** writes the atom with `tags: ["amplicon", "16s", "扩增子"]` (lowercased, Chinese unchanged)

#### Scenario: executeItem warns on missing concept tag
- **GIVEN** LLM emits item with `tags: ["amplicon", "16s"]` (no concept/* tag)
- **WHEN** executeItem processes this item
- **THEN** it calls `conceptTagCount(tags)` → 0
- **AND** logs warn: "item X lacks concept tag (0/2 tags are concept/*)"
- **AND** still writes the atom (warn, not reject)

#### Scenario: executeItem cosine ≥ 0.65 hit triggers LLM 二次确认
- **GIVEN** new item embedding has cosine 0.77 with existing atom
- **WHEN** executeItem calls `findMostSimilarEmbedding(embedding, 0.65)`
- **THEN** it finds the hit
- **AND** calls `confirmDedupAction(callLlm, hit.atom, newItem)` for the LLM 二次确认
- **AND** applies the action returned by LLM (update/supersede/create/skip)

#### Scenario: executeItem LLM 二次确认 returns update — in-place merge
- **GIVEN** executeItem called `confirmDedupAction`, LLM returned `action: "update"` with `merged: { title, summary, content, tags }`
- **WHEN** executeItem applies the action
- **THEN** it calls `index.updateAtom(mergedAtom, embedding)` (in-place, version+1)
- **AND** calls `writeAtomToFile(mergedAtom, atomsDir)`
- **AND** calls bge-m3 `reindexOne(mergedAtom.id)` (HTTP, 5s timeout, failure logged warn)
- **AND** returns `{ status: "update", atom: mergedAtom }`

#### Scenario: executeItem LLM 二次确认 returns supersede — old archived, new independent
- **GIVEN** executeItem called `confirmDedupAction`, LLM returned `action: "supersede"`
- **WHEN** executeItem applies the action
- **THEN** it calls `index.markSupersededTx(hit.id, newAtom, embedding)`
- **AND** calls `writeAtomToFile(finalNew, atomsDir)`
- **AND** calls bge-m3 `reindexOne(finalNew.id)`
- **AND** returns `{ status: "supersede", atom: finalNew }`

#### Scenario: executeItem LLM 二次确认 returns create — new independent, hit unchanged
- **GIVEN** executeItem called `confirmDedupAction`, LLM returned `action: "create"`
- **WHEN** executeItem applies the action
- **THEN** it calls `index.insertAtom(newAtom, vector)` (hit unchanged)
- **AND** calls `writeAtomToFile(newAtom, atomsDir)`
- **AND** calls bge-m3 `reindexOne(newAtom.id)`
- **AND** returns `{ status: "create", atom: newAtom }`

#### Scenario: executeItem LLM 二次确认 returns skip — no-op
- **GIVEN** executeItem called `confirmDedupAction`, LLM returned `action: "skip"`
- **WHEN** executeItem applies the action
- **THEN** it writes no files, makes no DB changes
- **AND** logs trace: "dedup-confirm: skip"
- **AND** returns `{ status: "skip", atom: hit.atom }` (the hit, not the new item)

#### Scenario: executeItem LLM 二次确认 call fails — fallback to supersede
- **GIVEN** executeItem called `confirmDedupAction`, LLM call timed out or returned non-JSON
- **WHEN** executeItem catches the failure
- **THEN** it falls back to `action: "supersede"` (conservative, matches cosine 0.65 hit)
- **AND** logs warn: "LLM dedup confirm failed for item X (hit Y), fell back to supersede"
- **AND** calls `index.markSupersededTx(hit.id, newAtom, embedding)` (same as scenario "LLM returns supersede")

## REMOVED Requirements

(none)

## RENAMED Requirements

(none)
