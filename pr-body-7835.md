## Summary

The edit tool rejects calls where `edits` is a single object (or a JSON string holding one object) instead of an array. Some models wrap their arguments for the edit tool in a single object `{oldText, newText}` rather than `[{oldText, newText}]`.

The existing `prepareEditArguments` function already handles stringified arrays but does not handle:
- Stringified single objects: `edits: '{"oldText": "...", "newText": "..."}'`
- Native single objects: `edits: {oldText: "...", newText: "..."}`

## Changes

- When `args.edits` is a JSON string that parses to a single object with `oldText`/`newText`, wrap it into a one-element array
- When `args.edits` is a plain object (not array, not string) with `oldText`/`newText` properties, wrap it into a one-element array

## Example

Before:
```
Validation failed for tool "edit":
  - edits.0: must be object
```

After: Object is normalized to `[{oldText, newText}]` and the edit is applied normally.

Fixes #7835