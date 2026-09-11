# Session benchmarks

Run these commands from `packages/agent`.

These benchmarks use deterministic synthetic data and make no claim to reproduce production traffic. Storage and repository fork datasets are linear branches of user-message entries with fixed 256-byte text payloads, deterministic IDs, and 250-entry seed transactions. Repository catalog datasets contain deterministic closed sessions.

## Timing

The timing suite runs scenarios against every target in `storage-targets.ts` and `session-repo-targets.ts`. Read scenarios reuse one immutable fixture per backend/dataset and validate their result once before timing. Every warmup and measured write runs once against an independently prepared fixture, so entry counts, sequence numbers, and durable artifacts start in equivalent states. Implementations are registered under the same Vitest suite so additional backends are directly comparable.

Storage writes cover a single message, a 100-message transaction, and a mixed message/register/usage append to a 1k-entry synthetic branch. Repository scenarios cover creating an empty session, opening or deleting a closed empty session, listing 100, 1k, and 10k closed sessions, and forking the current branch of open 1k- and 10k-entry source sessions. Fixture preparation, transaction generation, and validation happen outside the measured callback.

```sh
npm run bench:session:timing
npm run bench:session:timing -- -t "scan latest"
```

## Loaded footprint

The memory profile starts a fresh Node.js process with forced GC for every backend/dataset pair. Its baseline is recorded before generating and ingesting the dataset, so the result includes retained payload data and backend structures. Temporary generation data should be collected before the final reading, while RSS can still reflect allocator growth.

```sh
npm run bench:session:memory
```

## Storage allocation sampling

The allocation profile prebuilds all transactions, then samples allocations made while committing them. This excludes synthetic payload generation and reports estimated cumulative allocated bytes, including objects later collected, plus the largest sampled allocation sites. V8 sampling is approximate and does not report an exact object count.

```sh
npm run bench:session:allocations
```

Timing results are not CI performance gates. Run them on an otherwise idle machine and compare results produced on the same hardware and Node.js version.
