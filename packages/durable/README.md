# @earendil-works/pi-durable

Durable conversation, task, and document runtime for Pi.

This package contains the Pico runtime. Its current public API provides the durable record contracts and detached in-memory storage implementation:

```ts
import { MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
```

The normative design and implementation sequence are in:

- [`docs/pico-v5.md`](docs/pico-v5.md)
- [`docs/pico-v5-handoff.md`](docs/pico-v5-handoff.md)
- [`docs/pico-v5-chord-usage.md`](docs/pico-v5-chord-usage.md)
