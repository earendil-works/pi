# Compaction Endpoint: Full Example

This file shows, end-to-end, what Mu expects from the upstream OpenAI/Codex compaction endpoint, how Mu stores it, and how it gets used on the next turn.

## Short answer

- The compaction endpoint returns `output: ResponseItem[]`, not just one summary string.
- The most important item is often an opaque item like:
  - `{ "type": "compaction", "encrypted_content": "..." }`
  - or Codex alias `{ "type": "compaction_summary", "encrypted_content": "..." }`
- Mu serializes that opaque item into the session file inside `context_compaction.replacementMessages`.
- On the next turn, Mu replays that opaque item back to OpenAI/Codex.
- There is no known client-side decrypt path in Mu or in upstream `openai/codex`; it is treated as opaque backend state.

---

## 1) Example compact endpoint response

This is the shape Mu expects from `POST .../responses/compact`.

```json
{
  "output": [
    {
      "type": "message",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "Goal: finish the auth adapter migration.\n\nDone: switched provider wiring, added replay support.\n\nNext: verify the session resume path and rerun checks.",
          "annotations": []
        }
      ],
      "status": "completed"
    },
    {
      "type": "compaction",
      "encrypted_content": "eyJvcGFxdWUiOnRydWUsInRoaXNJc0p1c3RBbkV4YW1wbGUiOnRydWV9"
    },
    {
      "type": "message",
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "Continue from the compacted context and finish verification."
        }
      ]
    }
  ]
}
```

Notes:

- The first `message` is human-readable compacted history.
- The `compaction` item is opaque replay state.
- The trailing `user` message is also replayable history.
- For Codex, the opaque item may come back as `compaction_summary`; upstream aliases that to `Compaction`.

---

## 2) How Mu converts that into replacement messages

Mu converts the response into `replacementMessages` for the compacted thread.

Conceptually, the example above becomes this in memory:

```json
[
  {
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "Goal: finish the auth adapter migration.\n\nDone: switched provider wiring, added replay support.\n\nNext: verify the session resume path and rerun checks."
      }
    ],
    "api": "openai-responses",
    "provider": "openai",
    "model": "gpt-5",
    "usage": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0,
      "totalTokens": 0,
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "total": 0
      }
    },
    "stopReason": "stop",
    "timestamp": 1700000000000
  },
  {
    "role": "user",
    "content": [],
    "timestamp": 1700000000001,
    "__muCompactResponseItem": {
      "type": "compaction",
      "encrypted_content": "eyJvcGFxdWUiOnRydWUsInRoaXNJc0p1c3RBbkV4YW1wbGUiOnRydWV9"
    }
  },
  {
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "Continue from the compacted context and finish verification."
      }
    ],
    "timestamp": 1700000000002
  }
]
```

Important detail:

- The opaque compaction item is attached to a hidden carrier message under `__muCompactResponseItem`.
- That message has empty visible `content`, so transcript views may make it look like “nothing is there,” even though it is preserved.

---

## 3) What gets written to the session file

When Mu applies the compaction, it writes a `context_compaction` entry to the session `.jsonl` file.

Example:

```json
{
  "type": "context_compaction",
  "id": "msg_123",
  "parentId": "msg_122",
  "timestamp": "2026-03-07T01:23:45.000Z",
  "replacementMessages": [
    {
      "role": "assistant",
      "content": [
        {
          "type": "text",
          "text": "Goal: finish the auth adapter migration.\n\nDone: switched provider wiring, added replay support.\n\nNext: verify the session resume path and rerun checks."
        }
      ],
      "api": "openai-responses",
      "provider": "openai",
      "model": "gpt-5",
      "usage": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "totalTokens": 0,
        "cost": {
          "input": 0,
          "output": 0,
          "cacheRead": 0,
          "cacheWrite": 0,
          "total": 0
        }
      },
      "stopReason": "stop",
      "timestamp": 1700000000000
    },
    {
      "role": "user",
      "content": [],
      "timestamp": 1700000000001,
      "__muCompactResponseItem": {
        "type": "compaction",
        "encrypted_content": "eyJvcGFxdWUiOnRydWUsInRoaXNJc0p1c3RBbkV4YW1wbGUiOnRydWV9"
      }
    },
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Continue from the compacted context and finish verification."
        }
      ],
      "timestamp": 1700000000002
    }
  ]
}
```

This is the part that matters for restart/resume:

- the opaque `__muCompactResponseItem` is present in `replacementMessages`
- so it survives serialization

---

## 4) What gets sent on the next model turn

When that compacted session is resumed and Mu prepares the next API request, it sees the hidden carrier and replays the raw opaque item back to the provider.

So the next request input will conceptually include something like:

```json
[
  {
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "output_text",
        "text": "Goal: finish the auth adapter migration.\n\nDone: switched provider wiring, added replay support.\n\nNext: verify the session resume path and rerun checks.",
        "annotations": []
      }
    ],
    "status": "completed"
  },
  {
    "type": "compaction",
    "encrypted_content": "eyJvcGFxdWUiOnRydWUsInRoaXNJc0p1c3RBbkV4YW1wbGUiOnRydWV9"
  },
  {
    "role": "user",
    "content": [
      {
        "type": "input_text",
        "text": "Continue from the compacted context and finish verification."
      }
    ]
  },
  {
    "role": "user",
    "content": [
      {
        "type": "input_text",
        "text": "Please continue the task."
      }
    ]
  }
]
```

That is the key point: the compact blob is not just stored for display or audit; it is replayed into the next request.

---

## 5) Can you decrypt `encrypted_content`?

Probably not in any useful supported way.

What we can say with confidence:

- Mu does not decrypt it.
- Upstream `openai/codex` also appears to treat compaction `encrypted_content` as opaque replay state.
- I did not find a client-side compaction decrypt path in Mu or in upstream Codex.

Important nuance:

- Some upstream tests use fake or synthetic `encrypted_content` values.
- For example, tests may use placeholder strings like `"ENCRYPTED_COMPACTION_SUMMARY"` or mock base64-encoded values.
- That does **not** mean production compaction payloads are intended for user-side decoding.

So the practical answer is:

- **for real production use:** treat it as opaque and replay it verbatim
- **for debugging:** inspect the human-readable `message` items around it, not the blob itself

### New real-world findings from a live Mu session

After inspecting an actual compacted Mu session entry, the saved `compaction_summary.encrypted_content` looked like this:

```text
gAAAAABpq10eanf9BhIkjwLekoW32Tkm6bwBlUbfXxccA1y8i3Lwxa4LtwMWczPwQTjgRw1ZVuW0lhq8_XjvsBKjkz3ldOxsx2SrbjP-7594tgyDpkLEyzHk...
```

That strongly matches a Fernet-style token format.

When decoded as URL-safe base64, the token structure looked like:

- version byte: `0x80`
- embedded timestamp: `2026-03-06T23:02:54Z`
- IV length: 16 bytes
- ciphertext length: 4544 bytes
- HMAC trailer present

That means:

- this is not plain JSON
- this is not just a base64-encoded markdown summary
- there is real authenticated encryption involved

### But there is a practical way to recover the contents

Even though Mu and upstream Codex do not expose a local decrypt function, the backend itself can interpret the blob when it is replayed.

Using the real saved compaction blob from a Mu session and sending it back through `openai-codex` with a follow-up question, the backend was able to recover a highly specific structured summary of the hidden state, including:

- the compaction-goal description
- the actual modified file paths
- the commit SHAs
- the resulting version number `0.24.36`

So, in practice:

- **local cryptographic decryption:** not available
- **backend-assisted semantic recovery by replaying the blob:** yes, this works

### Important portability clue

Replaying the same blob through `openai-codex` worked.

Replaying that same blob through `openai` `gpt-5` failed with:

```text
400 The encrypted content for item ... could not be verified. Reason: Encrypted content organization_id did not match the target organization.
```

That strongly suggests:

- the blob is cryptographically bound to backend/provider org context
- the server validates provenance before using it
- this is not intended to be a provider-agnostic portable plaintext summary

So the most accurate answer is:

- you generally cannot decrypt it locally
- but you *can* often recover its meaning by replaying it to the same backend/provider context that created it

---

## 6) Relevant Mu files

- Compaction response types and conversion:
  - `packages/coding-agent/src/compaction-adapter.ts`
- Hidden opaque-item carrier:
  - `packages/ai/src/compact-history.ts`
- Replay into OpenAI Responses:
  - `packages/ai/src/providers/openai-responses.ts`
- Replay into OpenAI Codex Responses:
  - `packages/ai/src/providers/openai-codex-responses.ts`
- Session persistence of replacement messages:
  - `packages/coding-agent/src/session-manager.ts`

## 7) Relevant upstream Codex files

- Response item type includes compaction:
  - `openai/codex/codex-rs/protocol/src/models.rs`
- Compaction endpoint docs and handling:
  - `openai/codex/codex-rs/codex-api/README.md`
  - `openai/codex/codex-rs/core/src/compact_remote.rs`
- ResponseItem schema examples:
  - `openai/codex/codex-rs/app-server-protocol/schema/typescript/ResponseItem.ts`
