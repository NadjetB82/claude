# AI Agent Coding Standards — OmniRoute

**MANDATORY for all AI agents contributing to this repository.** This document extends AGENTS.md with performance-focused rules that every AI-generated change must satisfy.

---

## Core Philosophy

> **Every line of code in the hot path pays a tax on every request.** OmniRoute processes millions of requests. A 1ms regression × 1M req/day = 1000 seconds/day wasted. A 1MB memory leak × 1M req = 1TB/day allocated.

**Rule**: Optimize for the 99th percentile request, not the average. The tail latency determines user experience.

---

## Hot Path Rules (ZERO TOLERANCE)

### 1. No Synchronous I/O in Request Path

```typescript
// ❌ FORBIDDEN - Blocks event loop
const settings = db.prepare("SELECT * FROM settings").get();

// ✅ REQUIRED - Pre-computed/cached
const settings = getCachedSettings(); // In-memory, < 1μs
```

**Enforcement**: `check:hot-path-io` gate (to be added). Any `db.prepare`, `fs.readFileSync`, `JSON.parse` of large payloads in request path fails CI.

### 2. No Unbounded Allocations Per Request

```typescript
// ❌ FORBIDDEN - New object every request
const headers = { ...baseHeaders, Authorization: `Bearer ${key}` };

// ✅ REQUIRED - Reuse, mutate, or pool
const headers = getPooledHeaders();
headers.Authorization = `Bearer ${key}`;
return headers;
```

**Targets per request**:

- Object allocations: < 500
- String allocations: < 100
- Array allocations: < 50

### 3. No Linear Searches in Hot Path

```typescript
// ❌ FORBIDDEN - O(n) per request
const executor = executors.find((e) => e.provider === provider);

// ✅ REQUIRED - O(1) Map/Set lookup
const executor = executorRegistry.get(provider); // Pre-built Map
```

**Mandatory**: All provider/model/connection lookups use `Map` or `Object` (hash map), never `Array.find/filter`.

### 4. No Regex in Hot Path Without Pre-compilation

```typescript
// ❌ FORBIDDEN - Compiled every call
if (/^cc\//.test(model)) ...

// ✅ REQUIRED - Module-level constant
const CLAUDE_PREFIX_RE = /^cc\//;
if (CLAUDE_PREFIX_RE.test(model)) ...
```

**Rule**: Every regex used in request path must be a `const` at module scope with comment `// hot-path`.

### 5. No `JSON.parse/stringify` of Request/Response Bodies Unless Necessary

```typescript
// ❌ FORBIDDEN - Parse entire body to check one field
const body = JSON.parse(rawBody);
if (body.stream) ...

// ✅ REQUIRED - Streaming parse or header check
const stream = rawHeaders.get('x-stream') === 'true';
// Or use TransformStream for streaming JSON parse
```

---

## Memory Management Rules

### 6. All Caches Must Have Bounds + Eviction

```typescript
// ❌ FORBIDDEN - Unbounded growth
const cache = new Map();

// ✅ REQUIRED - Bounded with LRU
import { boundedMap } from "@/lib/quota/boundedMap";
const cache = boundedMap("my-cache", 10_000, "lru");
```

**Standard cache sizes** (adjust per use case):

- Learned limits: 2048
- Connection pools: 100 per provider
- Request deduplication: 10,000
- Circuit breaker state: 500 providers

### 7. All Timers/Intervals Must Be `unref()`'d

```typescript
// ❌ FORBIDDEN - Keeps process alive
setInterval(cleanup, 60_000);

// ✅ REQUIRED - Doesn't block shutdown
const timer = setInterval(cleanup, 60_000);
timer.unref?.();
```

### 8. No Closure Capture of Large Objects in Long-Lived Callbacks

```typescript
// ❌ FORBIDDEN - Captures entire request body
setTimeout(() => log(requestBody), 1000);

// ✅ REQUIRED - Extract only needed fields
const { model, provider } = requestBody;
setTimeout(() => log({ model, provider }), 1000);
```

### 9. WeakMap/WeakRef for Observer Patterns

```typescript
// ❌ FORBIDDEN - Strong ref prevents GC
const subscribers = new Map<Request, Set<Callback>>();

// ✅ REQUIRED - Weak ref allows GC
const subscribers = new WeakMap<Request, Set<Callback>>();
```

---

## Concurrency & Parallelism Rules

### 10. Parallelize Independent Async Operations

```typescript
// ❌ FORBIDDEN - Sequential when independent
const quota = await checkQuota();
const rateLimit = await checkRateLimit();
const breaker = await checkBreaker();

// ✅ REQUIRED - Parallel
const [quota, rateLimit, breaker] = await Promise.all([
  checkQuota(),
  checkRateLimit(),
  checkBreaker(),
]);
```

**Rule**: Any 2+ independent async calls in sequence → `Promise.all` or `Promise.allSettled`.

### 11. Use `Promise.allSettled` for Fallback Chains

```typescript
// ❌ FORBIDDEN - Stops at first failure
for (const target of targets) {
  try {
    return await execute(target);
  } catch {}
}

// ✅ REQUIRED - All fire, pick best result
const results = await Promise.allSettled(targets.map(execute));
const success = results.find((r) => r.status === "fulfilled");
```

### 12. Limit Concurrency with Semaphores, Not Queues

```typescript
// ❌ FORBIDDEN - Unbounded parallelism
targets.map((t) => execute(t)); // 1000 concurrent fetches!

// ✅ REQUIRED - Bounded
const semaphore = new Semaphore(10);
await Promise.all(targets.map((t) => semaphore.run(() => execute(t))));
```

---

## Database Rules

### 13. No Raw SQL in Handlers — Ever

```typescript
// ❌ FORBIDDEN
db.exec("UPDATE connections SET last_used = ?", [Date.now()]);

// ✅ REQUIRED - Domain module
await updateConnectionLastUsed(connectionId);
```

### 14. Prepared Statements Only — No String Interpolation

```typescript
// ❌ FORBIDDEN - SQL injection risk + no plan caching
db.exec(`SELECT * FROM connections WHERE provider = '${provider}'`);

// ✅ REQUIRED
const stmt = db.prepare("SELECT * FROM connections WHERE provider = ?");
stmt.all(provider);
```

### 15. Batch Writes — Never Write Per Request

```typescript
// ❌ FORBIDDEN - 1 write per request
await db.run("INSERT INTO logs ...");

// ✅ REQUIRED - Batch + async flush
logBuffer.push(entry);
if (logBuffer.length >= 100) flushLogs(); // Background
```

---

## TypeScript Rules for Performance

### 16. Avoid `any` — It Disables Optimization

```typescript
// ❌ FORBIDDEN - JIT can't optimize
function process(data: any) { ... }

// ✅ REQUIRED - Explicit types enable JIT
interface RequestData { model: string; stream: boolean; }
function process(data: RequestData) { ... }
```

### 17. Use `const` Assertions for Literal Types

```typescript
// ❌ FORBIDDEN - Widened type
const STRATEGIES = ["priority", "weighted", "auto"];

// ✅ REQUIRED - Narrow literal type
const STRATEGIES = ["priority", "weighted", "auto"] as const;
// Type: readonly ["priority", "weighted", "auto"]
```

### 18. Prefer `type` over `interface` for Performance

```typescript
// ✅ PREFERRED - Type aliases resolve faster
type ProviderConfig = { baseUrl: string; timeout: number };
```

---

## Streaming Rules

### 19. Never Buffer Entire Stream in Memory

```typescript
// ❌ FORBIDDEN - O(response size) memory
const text = await response.text();
return new Response(transform(text));

// ✅ REQUIRED - TransformStream pipeline
return new Response(response.body.pipeThrough(new TransformStream(transformer)));
```

### 20. Always Handle Backpressure

```typescript
// ❌ FORBIDDEN - Ignores backpressure
controller.enqueue(chunk);

// ✅ REQUIRED - Respects writable strategy
const writer = stream.getWriter();
await writer.ready;
writer.write(chunk);
```

---

## Rust/Native Module Integration Rules

### 21. Use N-API for Hot Path Computation

| Task           | JS Library   | Rust Alternative     | When to Use           |
| -------------- | ------------ | -------------------- | --------------------- |
| Token counting | `tiktoken`   | `tiktoken-rs`        | > 1000 tokens/request |
| JSON parse     | `JSON.parse` | `simd-json`          | > 10KB bodies         |
| Compression    | Custom JS    | `lz4`/`zstd`         | > 1MB contexts        |
| Hashing        | `crypto`     | `xxhash`/`blake3`    | High volume           |
| Rate limiting  | `bottleneck` | Token bucket in Rust | > 10K req/s           |

### 22. Native Module Pattern

```typescript
// TypeScript wrapper (open-sse/utils/native.ts)
interface NativeModule {
  countTokens(text: string, model: string): number;
  compressRtk(input: string): string;
  rateLimitCheck(key: string, limit: number, windowMs: number): boolean;
}

// Load once at startup
let native: NativeModule | null = null;
export async function getNative(): Promise<NativeModule> {
  if (!native) {
    try {
      native = await import("../native/omniroute_native.node");
    } catch {
      native = fallbackImplementation; // Graceful degradation
    }
  }
  return native;
}
```

---

## Error Handling Rules

### 23. No `try/catch` in Hot Path Without Purpose

```typescript
// ❌ FORBIDDEN - Catch without handling
try {
  await risky();
} catch {}

// ✅ REQUIRED - Specific handling or let propagate
try {
  await risky();
} catch (e) {
  if (isRecoverable(e)) return fallback();
  throw e; // Re-throw with context
}
```

### 24. Error Objects Must Be Lightweight

```typescript
// ❌ FORBIDDEN - Captures stack every time
throw new Error(`Failed for ${provider}/${model}`);

// ✅ REQUIRED - Pre-constructed or lazy
const err = new ProviderError(provider, model, code);
Error.captureStackTrace(err, execute); // Only when thrown
throw err;
```

---

## Testing Rules for Performance

### 25. Every Optimization Must Have Benchmark

```typescript
// tests/perf/bench-<feature>.test.ts
import { bench, describe } from "node:test";

describe("compression", () => {
  bench("RTK compression 10KB", () => {
    compressRtk(largeInput);
  });
});
```

**Run**: `npm run bench:compression` before/after changes.

### 26. Memory Leak Tests Required for New Caches

```typescript
// tests/unit/memory-<cache>.test.ts
test("cache evicts under pressure", async () => {
  const cache = createCache(100);
  for (let i = 0; i < 1000; i++) cache.set(i, largeObject);
  await gc();
  assert(cache.size <= 100);
});
```

---

## Code Review Checklist (AI Self-Review)

Before submitting any PR, the AI agent MUST verify:

| Check                          | Pass/Fail | Notes |
| ------------------------------ | --------- | ----- |
| No sync I/O in request path    | ☐         |       |
| Allocations < thresholds       | ☐         |       |
| All lookups O(1)               | ☐         |       |
| All regex pre-compiled         | ☐         |       |
| No full JSON parse in path     | ☐         |       |
| All caches bounded + eviction  | ☐         |       |
| All timers unref'd             | ☐         |       |
| No large closure captures      | ☐         |       |
| Independent async parallelized | ☐         |       |
| Concurrency bounded            | ☐         |       |
| No raw SQL in handlers         | ☐         |       |
| Prepared statements only       | ☐         |       |
| Writes batched                 | ☐         |       |
| No `any` in hot path           | ☐         |       |
| `const` assertions used        | ☐         |       |
| Streams not buffered           | ☐         |       |
| Backpressure handled           | ☐         |       |
| Native modules considered      | ☐         |       |
| Errors lightweight             | ☐         |       |
| Benchmarks included            | ☐         |       |
| Memory tests included          | ☐         |       |

---

## Performance Regression Gate

**New CI Gate**: `check:perf-regression`

```bash
# Runs before merge
npm run bench:compression
npm run bench:heap-body
npm run bench:routing-events
npm run bench:highwatermark

# Fails if:
# - P50 latency increases > 5%
# - P99 latency increases > 10%
# - Heap growth > 10MB over 10K requests
# - Bundle size increases > 2%
```

---

## Migration Guide for Existing Code

When touching existing code, apply these transformations:

| Pattern                          | Transformation                     |
| -------------------------------- | ---------------------------------- |
| `Array.find` in hot path         | → `Map.get`                        |
| `JSON.parse(body)` for one field | → Header check or streaming parse  |
| `new Map()` without bound        | → `boundedMap(name, limit, 'lru')` |
| `setInterval` without `unref`    | → `.unref()`                       |
| Sequential `await`               | → `Promise.all`                    |
| `try/catch` swallowing errors    | → Remove or handle specifically    |
| `any` type                       | → Explicit interface               |
| Large object in closure          | → Extract primitives               |

---

## Enforcement

1. **Pre-commit**: `lint-staged` runs ESLT with performance rules
2. **CI**: `check:perf-regression` gate blocks merges with regressions
3. **Code Review**: Human reviewers verify checklist
4. **Nightly**: `nightly-perf` workflow tracks trends

---

## Appendix: Quick Reference

### Import Aliases (Use These)

```typescript
import { boundedMap } from "@/lib/quota/boundedMap";
import { getCachedSettings } from "@/lib/db/readCache";
import { getExecutor } from "@omniroute/open-sse/executors/registry";
import { getCircuitBreaker } from "@omniroute/open-sse/shared/utils/circuitBreaker";
```

### Common Utilities (Use Instead of Inline)

```typescript
// Timing
import { measure } from "@/lib/perf/measure"; // measure('label', fn)

// Memory
import { getHeapStats } from "@/lib/perf/heap";

// Logging (pino, not console)
import { createRequestLogger } from "@omniroute/open-sse/utils/requestLogger";
```

### Environment-Specific Optimizations

```typescript
// Only in production
if (process.env.NODE_ENV === 'production') {
  // Enable aggressive caching
}

// Never in hot path
if (process.env.DEBUG) { ... } // Gate debug code
```

---

**Last Updated**: 2026-10-11
**Version**: 1.0
**Enforcement**: Mandatory for all AI-generated code. Human contributors strongly encouraged to follow.
