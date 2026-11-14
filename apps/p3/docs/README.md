# p3 docs

The working set: short, current, updated as slices are built. Everything older is in `archive/` (the record of how
we got here; not a reference for building).

| File | What it is |
| --- | --- |
| `overview.md` | what p3 is, its goals, the parts we build, in what order |
| `names.md` | one name per thing, used everywhere (code, contracts, panes, docs) |
| `workflow.md` | how a slice is specified, built, reviewed and handed over |
| `decisions.md` | the owner's decisions, newest last (the record; older entries may be superseded by newer ones) |
| `slices/` | one brief per slice; a slice's brief is filled out in detail before it is built |

Rules for this folder:

- A doc here is current or it is moved to `archive/`.
- When a slice changes what a doc says (a name, a part, a decision), the doc changes in the same commit.
- Chord's own design is in `packages/chord/docs/design.md`; Chord changes p3 needs are specified there
  (`packages/chord/docs/admission/design.md`), and the slice brief points to them.
