# AI Bindings

This document catalogs implementation options for applications that declare a Cloudflare Workers AI binding, for example a Worker that expects `env.AI.run(...)` but wants to execute locally through `workers-native` with a local model runtime such as `llama.cpp` / `llama-server`.

It is intentionally a design catalog rather than an implementation spec. The right approach depends on whether the goal is production parity with Cloudflare Workers AI, fully-offline local inference, lightweight demos, or test determinism.

## Binding Shape to Support

Workers AI is configured in Wrangler as a single binding name:

```toml
[ai]
binding = "AI"
```

Worker code then receives the binding on `env` and typically calls `run()` with a Cloudflare model identifier and model-specific input:

```ts
export interface Env {
  AI: Ai;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      prompt: "Explain Workers AI in one sentence.",
    });

    return Response.json(result);
  },
};
```

For `workers-native`, the hard part is not discovering the binding name: Wrangler's unstable helpers already normalize configured bindings into Miniflare worker options. The hard part is deciding what object should be installed at `env.AI` when the application is running outside Cloudflare's network.

## Current Runtime Context

`workers-native` currently relies on Wrangler and Miniflare for binding translation:

1. `src/host/load-wrangler-miniflare.ts` calls Wrangler's unstable helpers:
   - `unstable_readConfig()`
   - `unstable_convertConfigBindingsToStartWorkerBindings()`
   - `unstable_getMiniflareWorkerOptions()`
2. `src/host/miniflare-host.ts` builds a single Miniflare instance from:
   - the primary bundled Worker
   - Wrangler-derived `externalWorkers`
   - `worker-native.toml` `extra_workers`
   - programmatic `extraWorkers`
3. The resulting Miniflare worker options are passed through without AI-specific mutation.

That means AI handling should ideally fit into one of these existing extension seams:

- Wrangler/Miniflare-native binding support, if available.
- A generated or injected binding object in Miniflare options.
- A service-worker adapter declared as an auxiliary Worker.
- A user-owned shim in application code.

## Design Goals

Any approach should be evaluated against these goals:

- **Cloudflare API compatibility:** preserve `env.AI.run(model, input, options?)` as much as possible.
- **Offline behavior:** support local inference without Cloudflare credentials when requested.
- **Runtime predictability:** avoid silently switching between remote and local inference.
- **Native packaging:** make it clear which artifacts are inside the native executable and which must remain external.
- **Security:** avoid exposing local model servers unintentionally or logging prompts/secrets.
- **Testability:** allow deterministic tests without requiring a multi-GB model download.

## Option 1 — Pass Through Wrangler / Miniflare Support

Let Wrangler and Miniflare handle the configured `[ai]` binding exactly as they do today, without `workers-native` adding AI-specific behavior.

### How It Would Work

- User declares `[ai] binding = "AI"` in `wrangler.toml`.
- `workers-native` loads Wrangler-derived Miniflare worker options.
- If Wrangler/Miniflare provide a usable local or remote AI binding, `env.AI` is available automatically.
- If the binding is unsupported locally, startup or request handling fails according to upstream behavior.

### Pros

- Lowest maintenance cost for `workers-native`.
- Tracks upstream behavior as Wrangler and Miniflare evolve.
- Avoids maintaining a partial Workers AI compatibility layer.
- Keeps user expectations aligned with `wrangler dev`.

### Cons

- Does not solve fully-offline local inference by itself.
- Behavior may change across Wrangler versions because the project intentionally consumes Wrangler's unstable helpers.
- Failure modes can be opaque if Miniflare accepts the config but does not provide an operational `env.AI` implementation.

### Fit

Good default baseline. This should remain the first thing to try and the compatibility behavior to preserve when adding any optional local AI support.

## Option 2 — Remote Proxy to Cloudflare Workers AI

Provide or document a mode where `env.AI.run()` calls Cloudflare's hosted Workers AI service from local/native execution.

### How It Would Work

- User still declares `[ai] binding = "AI"`.
- At runtime, `env.AI` is backed by a proxy object that sends inference requests to Cloudflare using the user's account credentials.
- The binding behaves like production for supported models, subject to network availability and account limits.

### Configuration Sketch

```toml
[ai]
binding = "AI"

[worker_native.ai]
mode = "remote"
account_id = "$CLOUDFLARE_ACCOUNT_ID"
api_token_env = "CLOUDFLARE_API_TOKEN"
```

`worker-native.toml` does not currently define `[worker_native.ai]`; this is an illustrative extension shape.

### Pros

- Highest behavioral parity with deployed Workers AI.
- No local model installation or GPU/CPU tuning required.
- Supports Cloudflare-specific models, response schemas, and future features more naturally than a local shim.

### Cons

- Requires network access and Cloudflare credentials.
- Not suitable for offline demos or edge-of-network deployments.
- Prompts, generated output, and model inputs leave the machine.
- Native executable is no longer self-contained in a practical sense because it depends on remote service availability.

### Security Notes

- Never embed API tokens into compiled artifacts.
- Prefer environment variables or Wrangler's existing credential mechanisms.
- Avoid logging prompts, headers, account IDs with secrets, or response bodies.

### Fit

Best for development parity and smoke tests where Cloudflare access is acceptable. Not a `llama.cpp` solution.

## Option 3 — Local `llama.cpp` HTTP Adapter

Create a Workers AI-compatible adapter object whose `run()` method forwards supported model calls to a local `llama.cpp` server, such as `llama-server` or `llama-cpp-python`'s OpenAI-compatible server.

### How It Would Work

- User starts a local model server separately:

  ```bash
  llama-server -m ./models/llama-3.1-8b-instruct.Q4_K_M.gguf --host 127.0.0.1 --port 8080
  ```

- `workers-native` installs an `env.AI` shim.
- `env.AI.run("@cf/meta/llama-3.1-8b-instruct", { prompt })` maps to an OpenAI-compatible request:

  ```http
  POST http://127.0.0.1:8080/v1/chat/completions
  ```

- The adapter translates the local response back into the expected Workers AI response shape.

### Model Mapping

Cloudflare model names should not be assumed to be valid local model names. Provide an explicit mapping:

```toml
[worker_native.ai]
mode = "llamacpp"
binding = "AI"
base_url = "http://127.0.0.1:8080"

[[worker_native.ai.models]]
cloudflare = "@cf/meta/llama-3.1-8b-instruct"
local = "llama-3.1-8b-instruct-q4"
endpoint = "chat"
```

### Request Translation Examples

Text-generation style input:

```ts
await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
  prompt: "Write a haiku about local inference.",
});
```

Could translate to:

```json
{
  "model": "llama-3.1-8b-instruct-q4",
  "messages": [
    { "role": "user", "content": "Write a haiku about local inference." }
  ]
}
```

Chat-style input, if the Worker already passes messages:

```ts
await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
  messages: [
    { role: "system", content: "Be concise." },
    { role: "user", content: "What is Miniflare?" },
  ],
});
```

Could translate directly to the local `messages` array.

### Pros

- Practical local/offline implementation path.
- Keeps Worker application code unchanged for common `env.AI.run()` cases.
- Allows users to choose model files, quantization, context size, hardware acceleration, and server lifecycle.
- Avoids bundling very large model artifacts into the native executable.

### Cons

- Only approximates Workers AI semantics.
- Requires response-shape translation per task type.
- Local model quality, token limits, tool support, JSON-mode behavior, and streaming behavior may differ from Cloudflare's hosted model.
- Requires users to run and secure an additional local process.

### Implementation Notes

- Start with text-generation/chat models only.
- Fail fast for unsupported model families instead of returning misleading output.
- Require explicit model mappings to avoid accidental model substitution.
- Default `base_url` to loopback only; never default to a LAN listener.
- Keep timeout and maximum body-size controls configurable.
- Consider exposing a diagnostic endpoint or startup log that reports model mapping names without logging prompts.

### Fit

Best candidate for `llama.cpp`-style support. It offers useful offline behavior while keeping the model runtime outside `workers-native`'s packaging and release lifecycle.

## Option 4 — Spawn and Supervise `llama.cpp` from `workers-native`

Have `workers-native` start `llama-server` automatically when the native host starts, then wire `env.AI` to that server.

### How It Would Work

- User config points to a `llama-server` binary and model file.
- `runMiniflareHost()` or a related helper spawns the server before Miniflare starts.
- The AI adapter waits for readiness, then forwards `env.AI.run()` calls to the local server.
- On shutdown, `workers-native` terminates the child process.

### Configuration Sketch

```toml
[worker_native.ai]
mode = "managed_llamacpp"
binding = "AI"
server_path = "./vendor/llama-server"
model_path = "./models/llama-3.1-8b-instruct.Q4_K_M.gguf"
host = "127.0.0.1"
port = 18080
args = ["--ctx-size", "4096"]
```

### Pros

- One-command developer experience.
- Reduces setup drift between users.
- Makes readiness checks and lifecycle cleanup explicit.

### Cons

- Much larger security and platform surface area.
- Binary compatibility differs across macOS/Linux, CPU/GPU backends, and architectures.
- Model files are too large to treat like ordinary embedded runtime assets.
- Child-process management introduces port conflicts, zombie-process risks, startup timeouts, and log handling concerns.
- Harder to keep `workers-native` focused on Worker packaging rather than model serving.

### Security Notes

- Continue using argument arrays, not shell strings.
- Resolve binary and model paths relative to the app root or config file.
- Default to loopback.
- Do not inherit or print sensitive environment variables unnecessarily.
- Treat model files and server binaries as local executable/data supply-chain inputs.

### Fit

Useful for polished demos, but probably not the first implementation. Prefer Option 3 first; add managed lifecycle only if repeated user workflows justify it.

## Option 5 — Auxiliary Service Worker Adapter

Represent AI as a local auxiliary Worker reached through an internal service binding, while the primary Worker uses a small compatibility wrapper.

### How It Would Work

- `worker-native.toml` registers an extra Worker such as `local-ai-worker`.
- The application binds it as a service binding, for example `env.LOCAL_AI.fetch(...)`.
- Application code or a small library turns `env.AI.run()` calls into service requests to `LOCAL_AI`.
- The auxiliary Worker calls `llama.cpp`, a mock, or another local backend.

### Example

```toml
[[extra_workers]]
name = "local-ai-worker"
script_path = "./dist/local-ai/index.js"
modules = true
```

```ts
export function createAiFromService(service: Fetcher): Ai {
  return {
    async run(model: string, input: unknown) {
      const response = await service.fetch("http://local-ai/run", {
        method: "POST",
        body: JSON.stringify({ model, input }),
      });

      return response.json();
    },
  } as Ai;
}
```

### Pros

- Uses `workers-native`'s existing `extraWorkers` mechanism.
- Keeps backend logic in normal Worker code, which is easy to test and bundle.
- Can support multiple local AI backends without changing `workers-native` internals.

### Cons

- Requires application code changes unless `workers-native` also injects `env.AI`.
- Not transparent to apps that already depend directly on `[ai] binding = "AI"`.
- Adds another binding and routing concept for users to understand.

### Fit

Good for advanced users and prototypes. Less ideal as the primary answer to "my existing app declares `[ai] binding = \"AI\"`" because it does not preserve the binding contract by itself.

## Option 6 — Application-Level Shim Only

Document a userland pattern where applications provide their own `Ai` object during local/native runs.

### How It Would Work

- Worker code checks for `env.AI`.
- If absent, it creates a local adapter from environment variables.
- The adapter calls `llama.cpp`, OpenAI-compatible APIs, fixtures, or mocks.

### Example

```ts
function getAi(env: { AI?: Ai }): Ai {
  if (env.AI) return env.AI;
  return createLocalAi({ baseUrl: "http://127.0.0.1:8080" });
}
```

### Pros

- No `workers-native` implementation required.
- Maximum flexibility for each application.
- Works even when Miniflare does not understand an AI binding.

### Cons

- Every application has to solve the same compatibility problem.
- Can diverge from production code paths.
- Does not help third-party apps that expect `env.AI` to exist.

### Fit

Good documentation fallback. Not sufficient as built-in binding support.

## Option 7 — Deterministic Mock Binding for Tests

Provide a fake `env.AI` implementation for tests and demos that do not need real inference.

### How It Would Work

- User config selects `mode = "mock"`.
- `env.AI.run()` returns fixture responses based on model name and input matching.
- Tests can assert application behavior without a model server.

### Configuration Sketch

```toml
[worker_native.ai]
mode = "mock"
binding = "AI"

[[worker_native.ai.fixtures]]
model = "@cf/meta/llama-3.1-8b-instruct"
match_prompt = "health check"
response_json = { response = "ok" }
```

### Pros

- Fast and deterministic.
- CI-friendly.
- No credentials, model downloads, GPU, or network required.
- Useful for validating that binding injection and application control flow work.

### Cons

- Does not validate model quality, tokenization, streaming, or schema behavior.
- Can hide prompt-format bugs if overused.

### Fit

Strong companion feature even if real inference is implemented. It should be clearly labeled as a mock and never confused with Cloudflare parity.

## Option 8 — Compile-Time Rewriting or Polyfill Injection

Rewrite Worker bundles or inject a polyfill module during build so references to `env.AI` are replaced or initialized with a local adapter.

### How It Would Work

- During `workers-native build`, inspect or transform the bundled Worker.
- Add an import or wrapper that provides `env.AI` when absent.
- Route calls to a configured backend.

### Pros

- Can be transparent at runtime.
- Could work even if Miniflare does not expose custom binding injection hooks.

### Cons

- Fragile: `env` is user-controlled application structure, not a stable import to rewrite.
- Risks changing application semantics.
- Hard to support across module formats and framework-generated Workers.
- Difficult to explain and debug.

### Fit

Avoid unless no runtime binding injection path is available. Runtime configuration is more maintainable than source or bundle rewriting.

## Recommended Path

Recommended staged approach:

1. **Document current pass-through behavior.** Make clear that `workers-native` currently relies on Wrangler/Miniflare and does not guarantee local Workers AI execution.
2. **Add an explicit local adapter mode, not implicit magic.** If implemented, require users to opt into something like `mode = "llamacpp"`.
3. **Start with external `llama.cpp` server support.** Do not spawn or package model runtimes initially.
4. **Require explicit model mappings.** Avoid pretending that Cloudflare model IDs and local GGUF files are interchangeable.
5. **Support deterministic mocks separately.** Keep tests fast and make CI independent of model downloads.
6. **Consider managed `llama.cpp` lifecycle later.** Only add it after the adapter shape, safety controls, and user demand are clear.

## Compatibility Matrix

| Approach | Preserves `env.AI.run()` | Offline | Requires Cloudflare credentials | Requires local model server | Best use |
| --- | --- | --- | --- | --- | --- |
| Wrangler/Miniflare pass-through | If upstream supports it | Depends on upstream | Depends on upstream | No | Baseline compatibility |
| Remote Cloudflare proxy | Yes | No | Yes | No | Production-like local dev |
| Local `llama.cpp` adapter | Yes for supported calls | Yes | No | Yes | Offline inference |
| Managed `llama.cpp` | Yes for supported calls | Yes | No | Managed by `workers-native` | One-command demos |
| Auxiliary Worker adapter | With app wrapper | Yes | No | Optional | Advanced prototypes |
| App-level shim | With app code | Yes | No | Optional | Per-app flexibility |
| Mock binding | Yes for fixtures | Yes | No | No | Tests and CI |
| Compile-time rewriting | Potentially | Yes | No | Optional | Last resort |

## Open Questions

- Which Workers AI task families should be supported first: text generation, embeddings, image classification, speech, or reranking?
- What response shapes must be normalized for the first supported models?
- Should streaming responses be supported in the first version or rejected with a clear error?
- Where should AI adapter config live: `worker-native.toml`, environment variables, programmatic `runMiniflareHost()` options, or all three?
- Does Miniflare expose a stable enough hook for injecting an arbitrary binding object, or would support need to be modeled as a plugin/custom service?
- How should model readiness be checked without adding long startup delays to non-AI Workers?
- Should remote Cloudflare proxy mode be implemented by `workers-native`, delegated to Wrangler behavior, or left out entirely?

## Testing Strategy for Future Implementation

If AI binding support is implemented later, use layered tests:

1. **Unit tests for model mapping.** Verify Cloudflare IDs map to local backend names and unsupported IDs fail clearly.
2. **Unit tests for request translation.** Cover prompt input, chat messages, options, malformed input, and unsupported task types.
3. **Unit tests for response translation.** Cover successful responses, backend errors, timeouts, malformed JSON, and streaming rejection/handling.
4. **Integration test with mock backend.** Run a tiny HTTP server that mimics OpenAI-compatible responses; do not require real `llama.cpp` in CI.
5. **Optional manual fixture for real `llama.cpp`.** Document how maintainers can run a local GGUF model outside CI.
6. **Security regression checks.** Confirm prompts and credential-like headers are not logged.

## Security and Operations Considerations

- Bind local model servers to `127.0.0.1` by default.
- Treat prompts, completions, embeddings, and model inputs as potentially sensitive.
- Do not log request bodies or response bodies by default.
- Use explicit timeouts so stalled model inference does not hang the Worker indefinitely.
- Bound request and response sizes.
- Avoid embedding large model files into native executables by default.
- Keep user-controlled binary paths and model paths resolved relative to a clear root.
- If child processes are introduced later, use argument arrays and deterministic cleanup.

## Summary

For applications that declare Workers AI bindings, the safest near-term position is to preserve Wrangler/Miniflare pass-through behavior and clearly document that local AI execution is not guaranteed by `workers-native` today.

For `llama.cpp` support, the most practical first-class approach is an explicit local adapter that provides `env.AI.run()` and forwards supported calls to an already-running loopback `llama.cpp` OpenAI-compatible server. This keeps application code mostly unchanged while avoiding premature responsibility for model downloads, binary distribution, GPU setup, and child-process lifecycle management.