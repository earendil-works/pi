# p3

The successor of p2 (Pi Mobile) on Chord v2. Nothing runs yet: p3 is built in slices (`docs/slices/`).

- `docs/`: the working set (`docs/README.md`): overview, names, workflow, decisions, slice briefs.
- `src/`: base code (a restart changes it): the principal, the API (`src/api/v1/`), later the start script and the
  worker entry.
- `plugins/`: everything else, one directory per plugin.
- `test/`: tests of the whole (topology and end to end); a plugin's own tests sit in its directory.

Commands (Node 24, from this directory): `npm run check`, `npm test`.
