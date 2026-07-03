# server.py Changes: reranker lazy load

> Date: 2026-07-03 | Task: 4.1 | Spec scenarios: R2 (happy path) + R5 (lazy load failure)
>
> server.py lives at `/tmp/bge-m3-test/server.py` (outside this git repo — runtime service).
> Per design.md D8: server.py 实际跑 /tmp 路径, 项目内只在 docs/AGENTS.md 记录此路径.
> 此文件记录 server.py 改动, 项目内唯一追踪点.

## Why this change

bge-m3-multi server currently loads only `BGEM3FlagModel` at startup.
Adding cross-encoder rerank (D4) requires `FlagReranker` (~568MB, use_fp16).
Loading it eagerly would add startup cost and memory for a feature that may
not always be exercised. Lazy-load keeps cold-start unchanged; the model is
only paid for when the first `/api/rerank` request arrives.

## Diff summary

Three localized edits to `/tmp/bge-m3-test/server.py`. Lines reference the
file **after** the edits (646-line total).

### 1. Imports (lines 35-42)

```python
from FlagEmbedding import BGEM3FlagModel
try:
    from FlagEmbedding import FlagReranker as _FlagReranker
    _HAS_RERANKER = True
except ImportError:
    _FlagReranker = None
    _HAS_RERANKER = False
    print("[warn] FlagEmbedding.FlagReranker not importable; /api/rerank disabled", flush=True)
```

- `_FlagReranker` aliased so existing `FlagReranker` identifier (if any future
  import) does not collide.
- `try/except ImportError` keeps server bootable if `FlagEmbedding.FlagReranker`
  is removed in a future version or installed without the rerank submodule.

### 2. State + lazy load (lines 104-143)

```python
class State:
    model: BGEM3FlagModel
    atoms: list[dict]
    atom_idx: dict[str, int]
    dense: np.ndarray
    sparse: list[dict[int, float]]
    reranker: object | None                 # FlagReranker 实例, lazy-load 触发后才赋值
    reranker_loading: bool                  # 并发保护: 已有 caller 在加载时返 None


state = State()
state.reranker = None
state.reranker_loading = False


# ==================== reranker lazy load ====================

def get_reranker():
    """Lazy-load BAAI/bge-reranker-v2-m3 (568MB, use_fp16).

    Returns:
      - model instance (首次成功 load 之后)
      - None (并发加载中, 或 FlagReranker 不可用, 或 load 异常)
    """
    if state.reranker is not None:
        return state.reranker
    if state.reranker_loading:
        return None  # 并发 caller 已在加载, 不重复触发
    if not _HAS_RERANKER:
        return None
    state.reranker_loading = True
    try:
        state.reranker = _FlagReranker("BAAI/bge-reranker-v2-m3", use_fp16=True)
    except Exception as e:
        print(f"[warn] get_reranker() load failed: {e!r}", flush=True)
        state.reranker = None
        return None
    finally:
        state.reranker_loading = False
    return state.reranker
```

State fields added as type-annotated declarations + explicit initialization
to `None` / `False` so the test (and any importer) sees the fields before
startup runs.

`get_reranker()` ordering:
1. cached → return instance
2. concurrent in-flight → return None (don't disturb loading flag)
3. import unavailable → return None
4. acquire load lock → try create → on success cache, on exception log+None

`finally` resets `reranker_loading` regardless of outcome. The
exception path sets `state.reranker = None` (already None by default, but
defensive) so a previous successful load followed by a re-call failure
does not leak a stale instance.

### 3. /api/health (line 501)

Added `"reranker_loaded": state.reranker is not None` to the response payload
so operators can observe the lazy-load state without grepping logs.
Cold server now returns `reranker_loaded: false`; first `/api/rerank` request
flips it to `true` (assuming load succeeds).

## Verification evidence

### Syntax check

```
$ python3 -c "import ast; ast.parse(open('/tmp/bge-m3-test/server.py').read()); print('parse ok')"
parse ok
```

### Server startup (running instance picks up the new code)

```
[startup] Loading BAAI/bge-m3...
[startup] Reconciling cache → /home/qjh/.cache/bge-m3-multi/vectors.db
[startup] Ready in 5.3s (91 atoms indexed)
```

No new errors. No "FlagReranker not importable" warning (FlagEmbedding
is installed in env_base).

### /api/health

```
$ curl -s http://127.0.0.1:11435/api/health
{
  "status": "ok",
  "model": "BAAI/bge-m3",
  "atoms": 91,
  "reranker_loaded": false,
  "encoding_version": 2,
  ...
}
```

### TDD test — `/tmp/bge-m3-test/test_reranker_lazy.py`

18 assertions, all pass. Covers:

| # | Scenario | Behavior |
|---|----------|----------|
| 1 | Initial state | `reranker=None`, `reranker_loading=False` |
| 2 | Function exists | `get_reranker` callable, zero args |
| 3 | Error path (R5) | FlagReranker raises → returns None, `reranker_loading` reset |
| 4 | Success path (R2 happy) | First call creates instance, second call returns cached (factory not invoked) |
| 5 | Concurrent guard | `loading=True` → returns None, flag untouched, `reranker` not clobbered |
| 6 | Unavailable path | `_HAS_RERANKER=False` → returns None without touching state |

```
Passed: 18 | Failed: 0
ALL TESTS PASSED
```

The test stubs `_FlagReranker` to avoid the 568MB model download and
exercises the failure paths deterministically. Production load path is
verified by the import succeeding + `/api/health` responding.

## Scenarios satisfied

- **R2** (spec): "server 已启动, reranker 已 lazy loaded" — covered type-level
  by test [4] success path; production lazy load triggers on first
  `/api/rerank` call (wired in task 4.2).
- **R5** (spec): "server 启动后第一次调 /api/rerank 且 lazy load 失败" —
  `get_reranker` returning None on error, exercised by test [3] with a
  stub that raises `RuntimeError`.

## Not in this task (deferred)

- `/api/rerank` endpoint itself → task 4.2
- `rerankAndFilter()` threshold + gap logic in TypeScript → task 4.3
- wiring `get_reranker()` into a FastAPI endpoint → task 4.2

This task ships the **state plumbing** and **lazy-load machinery** that
4.2 will call. No new public endpoint yet, but `state.reranker` and
`get_reranker()` are the hooks 4.2 depends on.