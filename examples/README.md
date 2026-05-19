# Examples

This directory is organized as runnable Cloudflare Worker scenarios for verification.

Each scenario is intentionally small and focused on one binding shape so it is easy to confirm what works and what does not.

## Verification matrix

| Scenario | Binding shape | Expected with `native-workers` | Verify |
| --- | --- | --- | --- |
| `01-vars-and-durable-object` | `vars` + same-worker Durable Object binding | Working | `bunx native-workers serve --project ./examples/01-vars-and-durable-object` then `curl localhost:8787` |
| `02-service-binding-wrangler-workers` | `[[services]]` resolved via Wrangler `[[workers]]` auxiliary worker | Working | `bunx native-workers serve --project ./examples/02-service-binding-wrangler-workers` then `curl localhost:8787` |
| `03-service-binding-native-config` | `[[services]]` resolved via `native-worker.toml` `[[extra_workers]]` | Working | `bunx native-workers serve --project ./examples/03-service-binding-native-config/caller --native-config ./examples/03-service-binding-native-config/native-worker.toml` then `curl localhost:8787` |
| `04-service-binding-missing-worker` | `[[services]]` with no matching auxiliary worker | Not working (expected failure) | `bunx native-workers serve --project ./examples/04-service-binding-missing-worker` then `curl localhost:8787` |

## Notes

- These scenarios are for local verification only.
- For scenario 4, startup should succeed but request handling should fail because the target service is unresolved.
