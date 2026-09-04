# chord

Standalone Rust application-composition runtime used by Pi. Chord provides cancellation/value contexts, facet activation and reverse-order teardown, typed service identities, remote service calls, mutable replicated JSON state, and validated delta operations for replace/set/delete/string append/front-truncate/array splice.

```rust
use chord::{Context, Tracker, apply};
use serde_json::json;
let mut tracker = Tracker::new(json!({"output": ""}));
let base = tracker.flush();
let replica = apply(serde_json::Value::Null, &base)?;
```
