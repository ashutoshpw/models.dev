# Capability Registry Contract

This document defines the stable JSON contract that routers and other external
applications use to consume capability metadata from the models.dev catalog.

## Endpoints

| Endpoint | Payload | Use |
| --- | --- | --- |
| `GET /api.json?type=all` | `ProviderMap`: providers keyed by provider ID, each with `models` | provider-specific routing and overrides |
| `GET /models.json?type=all` | `ModelMetadataMap`: canonical models keyed by `<lab>/<model>` | canonical defaults, aliases, benchmarks |
| `GET /catalog.json?type=all` | `{ schema_version, generated_at, aliases, providers, models }` | single-fetch registry snapshot |
| `GET /model-schema.json?type=all` | JSON Schema with a provider/model ID enum | request validation |

`?type=` defaults to standard models; pass `type=all` for the full registry
(including `type = "decision"` entries). Responses are cached publicly for one
hour (`Cache-Control: public, max-age=3600`).

## Payload shapes

```jsonc
// catalog.json
{
  "schema_version": 1,
  "generated_at": "2026-09-22T18:04:00.000Z",
  "aliases": {
    "acme/gpt-5.4-latest": "acme/gpt-5.4",          // canonical alias
    "openrouter/openai/gpt-5.4-latest": "openrouter/openai/gpt-5.4" // provider alias
  },
  "models": {
    "openai/gpt-5.4": {
      "id": "openai/gpt-5.4",
      "aliases": ["acme/gpt-5.4-latest"],
      "capabilities": {
        "tasks": { "text_generation": { "status": "supported", "evidence": ["https://..."], "verified_at": "2026-09-22" } },
        "inputs": { "files": { "status": "supported", "formats": ["application/pdf"], "evidence": ["https://..."], "verified_at": "2026-09-22" } },
        "features": { "explicit_prompt_caching": { "status": "unsupported", "evidence": ["https://..."], "verified_at": "2026-09-22" } }
      }
    }
  },
  "providers": {
    "acme": {
      "models": {
        "gpt-5.4": {
          "id": "gpt-5.4",
          "canonical": "openai/gpt-5.4",
          "capabilities": {
            "tasks": { "text_generation": { "status": "supported", "evidence": ["https://..."], "verified_at": "2026-09-22" } },
            "endpoints": {
              "transports": { "http": { "status": "supported", "evidence": ["https://..."], "verified_at": "2026-09-22" } },
              "operations": { "chat": { "status": "supported", "evidence": ["https://..."], "verified_at": "2026-09-22" } }
            }
          }
        }
      }
    }
  }
}
```

Versioning: `schema_version` changes only for breaking changes. New optional
keys are additive; consumers must ignore unknown keys. `generated_at` is
present on HTTP responses and omitted from the deterministic SDK snapshot
payload.

## Tri-state semantics

Every capability node has a status:

| Status | Meaning |
| --- | --- |
| `"supported"` | Confirmed by at least one `evidence` URL verified at `verified_at` |
| `"unsupported"` | Explicit negative, also evidence-backed |
| `"unknown"` | Declared unknown (`{ "status": "unknown" }`) or **absent** |

- **Absent means unknown.** Never treat a missing node as `false`.
- A provider entry's `capabilities` is already resolved: canonical defaults
  deep-merged with provider overrides at catalog generation time. Entries with
  `base_model` inherit during the merge; first-party entries that resolve to a
  same-ID canonical model (for example `providers/openai/.../gpt-5.4.toml` and
  `models/openai/gpt-5.4.toml`) receive the same defaults.
- Explicit negatives and unknowns on provider entries win over canonical
  defaults. `base_model_omit` resets an inherited node to absent.
- When a provider sets a legacy boolean (for example `tool_call = false`) that
  contradicts an inherited canonical capability, generation resolves that
  capability to unknown instead of claiming support. Legacy booleans remain
  available to pre-capability consumers; capabilities are authoritative.

## Resolution algorithm

```ts
function resolveModel(catalog, providerID, modelID) {
  const direct = catalog.providers[providerID]?.models[modelID];
  if (direct) return direct;

  const aliasID = `${providerID}/${modelID}`;
  const target = catalog.aliases[aliasID];
  if (target?.includes("/")) {
    const [aliasProvider, ...rest] = target.split("/");
    const aliased = catalog.providers[aliasProvider]?.models[rest.join("/")];
    if (aliased) return aliased;
  }
  return catalog.models[target ?? aliasID]; // canonical alias fallback
}

function effectiveCapability(model, axis, key) {
  const node = model.capabilities?.[axis]?.[key];
  return node?.status === "supported" || node?.status === "unsupported"
    ? node
    : { status: "unknown" };
}
```

`model.canonical` (when present) is the canonical model ID this provider entry
serves. Resolve canonical defaults through `catalog.models[model.canonical]`.
`base_model` is an authoring-time pointer and never appears in JSON.

## Tasks are not modalities

`modalities` describes data shapes (`input`/`output` arrays). `capabilities.tasks`
describes what a model does. An embedding model or reranker may legitimately
have `output: ["text"]`; it must declare `tasks.embeddings` or
`tasks.reranking` and must **not** be treated as `text_generation` unless that
task is declared. Consumers may still use `modalities.input` for coarse input
coverage, but the capability contract never derives task values from
modalities.

`tasks.evaluation` means the endpoint exposes a dedicated scoring/evaluation
operation. Benchmark results on `models.json` are metadata about a model, and a
general LLM used as a judge is an application workflow; neither implies the
`evaluation` task.

## Router recipes

### 1. Resolve provider overrides

```ts
const providerModel = resolveModel(catalog, "openrouter", "openai/gpt-5.4");
const supportsTools =
  effectiveCapability(providerModel, "features", "tool_calling").status === "supported";
const fileFormats =
  effectiveCapability(providerModel, "inputs", "files").formats ?? []; // formats live on the node
```

### 2. Custom models

Routers keep custom or fine-tuned models local and overlay them onto canonical
metadata instead of writing them to the catalog:

```jsonc
{
  "id": "my-router/support-tuned",
  "canonical": "meta/llama-3.1-8b",
  "capabilities": {
    "tasks": { "text_generation": { "status": "supported", "evidence": ["https://internal/docs"], "verified_at": "2026-09-22" } },
    "features": { "tool_calling": { "status": "unsupported", "evidence": ["https://internal/docs"], "verified_at": "2026-09-22" } }
  }
}
```

Merge rule: start from `catalog.models[canonical]`, apply local overrides with
the same semantics as provider overrides (objects deep-merge, arrays replace,
`status = "unknown"` clears inherited evidence).

### 3. Fallback combos

```ts
const required = ["text_generation"];
const combo = ["anthropic/claude-opus-4.6", "openai/gpt-5.4", "google/gemini-3.1-pro"];
const usable = combo.filter((id) => {
  const [providerID, ...rest] = id.split("/");
  const model = resolveModel(catalog, providerID, rest.join("/"));
  if (!model) return false;
  if (model.limits?.context !== undefined && requiredContext > model.limits.context) return false;
  return required.every(
    (task) => effectiveCapability(model, "tasks", task).status === "supported",
  );
});
```

The registry supplies metadata for preflight filtering; runtime failure
handling (retries, cooldowns, health) stays in the router. Do not treat
`unknown` as a failure — only `unsupported` is a negative claim.

### 4. Cached snapshots

- Pin `@opencode-ai/models/snapshot` (exports `providers`, `models`, `aliases`,
  `schemaVersion`, `generatedAt`) when determinism matters; regenerate by
  upgrading the package.
- For HTTP consumers, respect `Cache-Control: max-age=3600`; use
  `generated_at` to detect staleness and `schema_version` to gate parsers.
- With `?type=all` responses, resolve aliases only within the same response;
  filtered responses prune aliases whose targets were filtered out.
- A catalog snapshot is safe to cache for a session; capability declarations
  change only on catalog releases and every declaration carries `verified_at`.

## Evidence policy

Declarations marked `supported` or `unsupported` must carry at least one
`evidence` URL and a `verified_at` date. Sources must be official provider or
lab documentation (API references, model pages, pricing/features docs).
Capabilities are never inferred solely from model names, tool-calling support,
or the presence of cache pricing. Unverifiable claims stay unknown.

## Coverage

`bun run coverage:capabilities` regenerates
[docs/capabilities/coverage.md](coverage.md), which shows per-task coverage and
remaining unknown gaps. CI fails when the committed report is stale.
