---
status: accepted
---

# Segment active TUI rendering by transcript stability

Active renders will process explicit TUI render regions instead of rebuilding the full transcript. Pi will promote the current Dynamic transcript tail into the Stable transcript at `agent_end`; ordinary text streaming and spinner renders will reuse the stable region, while explicit presentation changes may invalidate it. Existing parameterless `requestRender()` calls remain conservative full invalidations for extension compatibility, and core high-frequency paths opt into region-scoped rendering.

## Considered Options

Per-line memoization reduces allocation but remains proportional to session length. Freezing prior transcript content would be faster but would break historical tool expansion, theme and image settings, and extension renderer invalidation. Application-only caching cannot prevent renderer-level reset, image, and diff scans.

## Consequences

Regular and fullscreen renderers share the region contract. Promotion must not change displayed content, scrollback, selection, overlays, images, viewport, or mode-switch state when transcript content is unchanged; harmless terminal cursor control remains allowed. Stable snapshots retain one prepared line representation plus sparse image metadata rather than duplicating the transcript. Cumulative usage becomes append-only core session state. Context usage keeps its completed-message semantics and caches results until the completed message state changes.

Active renders with overlays, dynamic images, dynamic line shrinkage, terminal resize, or an invalid stable revision fall back to the conservative full path. Correct terminal state takes priority over making these low-frequency cases independent of transcript length.

This decision addresses render-path CPU growth with completed transcript length. Session memory retention and incremental rebuilding of the current streaming message require separate evidence and are outside this decision.
