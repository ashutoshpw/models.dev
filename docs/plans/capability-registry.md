# Capability Metadata & Router Contract — Implementation Plan

**Author:** Platform eng (draft)
**Date:** 2026-09-22
**Status:** Draft
**Target:** this fork of models.dev (`ashutoshpw/models.dev`), branch `dev`

---

## 1. Problem

models.dev is a catalog of models and the providers that serve them. Today it answers
"who serves what, at what price, with which limits and modalities". It does **not**
answer the questions an AI router must answer before dispatch:

- Which **task** does this entry actually perform? (`modalities.output = ["text"]` is
  true for chat models, embeddings, rerankers, and judges alike.)
- Which **input kinds and file formats** does this concrete provider endpoint accept?
- Which **features** are available *on this host* (tools, grounding, cache modes)?
- Which **transports and API operations** does the serving endpoint expose (HTTP, SSE,
  WebSocket; chat/responses/embeddings/images/audio/realtime/...)?
- Is a capability **confirmed, explicitly unavailable, or simply unknown**?
- How do provider-specific entries and aliases map back to a canonical model so a router
  (and its custom models and fallback chains) can reason about capability equivalence?

Consumers currently approximate this from model names, `tool_call`, or the presence of
`cache_read` pricing. That is inference, not metadata, and it misroutes traffic.

## 2. Goal

Extend the catalog so that the generated JSON/API is a **stable, evidence-backed
capability registry** any router can consume: canonical model defaults, per-provider
overrides (including negatives), explicit unknown, aliases/canonical refs, and a
documented contract with resolution examples.

**Success criteria**

1. A router can decide *task*, *inputs/formats*, *features*, and *transports/operations*
   for any catalog entry without name-based inference.
2. Supported / unsupported / unknown are distinguishable for every capability axis;
   missing metadata resolves to unknown by contract.
3. Provider entries inherit canonical defaults, can override any single capability
   (including `unsupported`), and can reset to unknown (`status = "unknown"` or
   `base_model_omit`).
4. Every `supported`/`unsupported` authored declaration carries at least one evidence URL
   and a `verified_at` date; validation rejects declarations without them.
5. Embeddings and rerankers are never implied to be text generators; benchmarks never
   imply a dedicated evaluation operation.
6. `bun validate`, core tests, SDK type-parity tests, and function tests pass; existing
   TOMLs and existing JSON consumers are unaffected (all additions optional/additive).
7. A generated coverage report shows per-task coverage and the remaining unknown gaps.

## 3. Scope

### In scope (v1)

- Structured `capabilities` on canonical (`models/<lab>/<model>.toml`) and provider
  (`providers/<id>/models/.../*.toml`) entries: `tasks`, `inputs` (with file formats),
  `features`, provider-scoped `endpoints` (transports + operations).
- Tri-state status (`supported` | `unsupported` | `unknown`), evidence URLs, `verified_at`.
- Canonical `aliases`; resolved `canonical` reference and flattened alias map in generated
  output.
- Generation/merge normalization, validation refinements, sync preservation.
- SDK types/snapshot, API payloads, docs, tests, coverage script.
- Population of a representative verified set across every task.
- Stable JSON contract + router examples (provider override resolution, custom models,
  fallback combos, cached snapshot).

### Out of scope

- Routing policy execution (health checks, retries, load balancing) — registry supplies
  metadata only.
- A universal capability schema for arbitrary non-catalog endpoints.
- Automatic capability probing / live testing of providers.
- New API endpoints beyond additive fields on `api.json` / `models.json` / `catalog.json`.
- Changing existing field semantics (`modalities`, `reasoning`, `tool_call`, cost, limits).
- UI redesign beyond capability badges/search tokens.

## 4. Current state (audit summary)

### Data & schema — `packages/core/src/schema.ts`

| Concern | Current state | Ref |
|---|---|---|
| Canonical model | strict `ModelMetadata`, optional booleans/dates/modalities/limit/links/weights/benchmarks | `schema.ts:223-248` (`ModelMetadataBase` / `ModelMetadata`) |
| Provider model | strict `ModelShape`/`AuthoredModelShape` via `refineModel` (reasoning ⇒ `reasoning_options`, tiers unique, cost rules) | `schema.ts:250-380` |
| Modalities | hardcoded enum `text \| audio \| image \| video \| pdf`, `{input[], output[]}` | `schema.ts:150-159` |
| Provider model `provider` | request-shape overrides `{npm, api, shape, body, headers}` | `schema.ts` ModelBase |
| Reasoning controls | `reasoning_options`: `toggle` / `effort` / `budget_tokens` | `schema.ts:25-71` |
| Benchmarks | `BenchmarkResult[]` (name, score, metric, harness, variant, dataset, version, source URL, date) | `schema.ts:209-221` |
| Links/license/weights | canonical-only; explicitly **not** inherited | `generate.ts:177-189` |

### Merge & inheritance — `packages/core/src/generate.ts`

- `base_model` + `base_model_omit` (dot paths) resolved before validation; pointer fields
  never emitted (`generate.ts:156-238`).
- Deep merge via Remeda `mergeDeep`: objects deep-merge, primitives/arrays replace;
  `structuredClone` protects the base.
- Inherited keys exclude `id`, `benchmarks`, `license`, `links`, `weights`.
- `base_model_omit` walks object paths, never arrays, and removes empty parents.

### API / SDK / web

- Static variants built in `packages/web/script/build.ts:82-94`: `_api*`, `_models*`,
  `_catalog*` (default / `-all` / `-decision`).
- Worker `packages/function/src/worker.ts`: `/api.json`, `/models.json`, `/catalog.json`
  (+ `?type=`), `/model-schema.json` (ID enum only); `Cache-Control: public, max-age=3600`.
- SDK `packages/sdk`: hand-written types mirroring core, checked for **exact mutual
  assignability** (`packages/sdk/test/types.ts`); generated snapshot embeds the catalog
  (`packages/sdk/script/generate.ts`); client methods `providers()`, `models()`,
  `catalog()`.
- Web renders canonical/provider tables, facts, search from in-memory `generateCatalog`.
- Root `models.json` is **not** generator output — it is a checked-in third-party dataset
  and must not be touched.

### Sync — `packages/core/src/sync/index.ts`

- Sync rewrites provider TOMLs from `translateModel()` output; preservation is opt-in per
  field: `preserveBaseModel`, `preserveDescription`, `preserveReasoningOptions`,
  headers/symlinks (`sync/index.ts:334-380, 549-591`).
- **Any new hand-authored provider field would be dropped on the next sync** unless a
  preserve helper is added **and the serializer emits it**. `formatToml()` manually emits
  a fixed field list (`sync/index.ts:1005-1080`), so a preserved `capabilities`/`aliases`/
  `canonical` object would be silently discarded at write time. Both the preserve helper
  and `formatToml()` must support the new fields; a parser round-trip test must prove it.

### Tests & CI

- Core: schema/generate/filter + per-provider sync suites.
- `bun validate` = full catalog parse + merge; CI `.github/workflows/validate.yml` runs it
  plus SDK tests. `sync-models.yml` runs hourly and validates.

## 5. Design overview

Two layers, mirroring successful prior art (OpenRouter endpoint records, AI SDK model
kinds, Anthropic `capabilities`, Bedrock host metadata):

```
Canonical model (models/<lab>/<model>.toml)
  tasks        – what the model does            (tri-state + evidence)
  inputs       – accepted kinds + file formats  (tri-state + evidence/privacy)
  features     – reasoning/tools/search/cache   (tri-state + evidence)
  aliases[]    – alternate canonical IDs
        │ inherits by default (mergeDeep)
        ▼
Provider model (providers/<id>/models/.../*.toml)
  capabilities.tasks/inputs/features  – overrides incl. explicit negatives / unknown
  capabilities.endpoints              – transports + operations (provider-only)
  aliases[]                           – provider-scoped alternate IDs
  canonical (output)                  – resolved canonical reference
```

Principles:

1. **Reuse** `modalities`, `reasoning`, `tool_call`, `structured_output`, `limit`, cost,
   and `benchmarks` unchanged. Capabilities are additive and take precedence only for
   their own tri-state question; contradictions with legacy booleans are validation errors.
2. **Missing = unknown** everywhere. `unknown` is never inferred to `supported`. The
   capability contract does **not** derive capability values from `modalities`; legacy
   consumers keep using `modalities` unchanged, but router-facing resolution treats any
   absent capability node as unknown.
3. **Evidence or it isn't confirmed.** Confirmed/negative declarations require
   `evidence` (URL list) and `verified_at`. Names, tool-calling flags, or cache pricing
   are explicitly not evidence.
4. **Explicit negatives.** A provider can say `status = "unsupported"` per capability and
   can reset to unknown with `status = "unknown"` or `base_model_omit`.
5. **Tasks ≠ modalities.** `tasks` are only declared, never derived from
   `modalities.output`.
6. **Benchmarks ≠ evaluation task.** `benchmarks` stay metadata on canonical models; the
   `evaluation` task means the endpoint exposes a dedicated scoring/judge operation.

## 6. Schema design

All new fields are optional at both layers. Exact zod/TS shapes (final naming locked at
implementation, but the plan assumes these):

Zod 3.24.2 constraints that shape the implementation:

- A refined schema (`ZodEffects`) has no `.extend()`. Build plain strict objects first
  (`DeclarationBase`), extend those, then wrap each with `.refine()`.
- `z.record(enum, value)` parses sparse objects at runtime but **infers all keys as
  required**, which contradicts "absent = unknown". Do **not** use it for capability
  maps. Use a keyed-map helper that builds an optional-property strict object from a fixed
  key list (inference: `Partial<Record<K, V>>`), e.g.
  `capabilityMap(CapabilityTasks, Declaration)` implemented with
  `z.object(Object.fromEntries(keys.map((k) => [k, value.optional()]))).strict()`.
  (`z.partialRecord` is not available in this Zod version; do not depend on it.)
- `AuthoredModelShape.deepPartial()` (used by `ExistingModel` / `SyncedModel` in
  `sync/index.ts:54-66`) does not unwrap `ZodEffects`; capability fields are optional, so
  deepPartial should leave them intact, but this must be covered by a sync parse test
  before relying on it.

```ts
// packages/core/src/schema.ts
export const CapabilityStatus = z.enum(["supported", "unsupported", "unknown"]);

// Strict YYYY-MM-DD (stricter than the existing DateString, which allows YYYY-MM)
const VerificationDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDate);

// RFC 6838 media type, e.g. application/pdf, text/plain, image/png
const MediaType = z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i);

const DeclarationBase = z.object({
  status: CapabilityStatus,
  evidence: z.array(UrlString).min(1).optional(),   // required unless unknown
  verified_at: VerificationDate.optional(),         // required unless unknown
}).strict();

const declarationRules = (d: z.infer<typeof DeclarationBase>) =>
  d.status === "unknown"
    ? d.evidence === undefined && d.verified_at === undefined
    : d.evidence !== undefined && d.verified_at !== undefined;

export const Declaration = DeclarationBase.refine(declarationRules, {
  message: "supported/unsupported require evidence + verified_at; unknown forbids them",
});

const InputDeclarationBase = DeclarationBase.extend({
  formats: z.array(MediaType).min(1).optional(),
}).strict();

export const InputDeclaration = InputDeclarationBase
  .refine(declarationRules, { message: /* same */ "…" })
  .refine((d) => d.formats === undefined || d.status === "supported", {
    message: "formats require status = supported",
  });

export const CapabilityTask = z.enum([
  "text_generation", "image_generation", "video_generation", "transcription",
  "speech_synthesis", "realtime_conversation", "embeddings", "reranking", "evaluation",
]);
export const CapabilityInput = z.enum(["text", "image", "audio", "video", "files"]);
export const CapabilityFeature = z.enum([
  "reasoning", "tool_calling", "structured_output", "web_search",
  "implicit_prompt_caching", "explicit_prompt_caching",
]);
export const Transport = z.enum(["http", "sse", "websocket"]);
export const Operation = z.enum([
  "chat", "responses", "completions", "embeddings", "images", "videos",
  "transcriptions", "speech", "rerank", "realtime", "evaluate",
]);

// capabilityMap(keys, valueSchema) => strict z.object with every key optional
const Capabilities = z.object({
  tasks: capabilityMap(CapabilityTask.options, Declaration).optional(),
  inputs: capabilityMap(CapabilityInput.options, InputDeclaration).optional(),
  features: capabilityMap(CapabilityFeature.options, Declaration).optional(),
}).strict();

const EndpointCapabilities = z.object({
  transports: capabilityMap(Transport.options, Declaration).optional(),
  operations: capabilityMap(Operation.options, Declaration).optional(),
}).strict();
```

`UrlString` / `DateString` already exist internally (`schema.ts:114-176`); `VerificationDate`
and `MediaType` are new internal helpers. The SDK keeps hand-written types, so these
validators do not need to be exported publicly.

TOML ergonomics (canonical file):

```toml
# models/openai/gpt-5.4.toml
aliases = ["openai/gpt-5.4-latest"]

[capabilities.tasks.text_generation]
status = "supported"
evidence = ["https://platform.openai.com/docs/models/gpt-5.4"]
verified_at = "2026-09-01"

[capabilities.tasks.embeddings]
status = "unsupported"

[capabilities.inputs.image]
status = "supported"
evidence = ["https://platform.openai.com/docs/guides/vision"]
verified_at = "2026-09-01"

[capabilities.inputs.files]
status = "supported"
formats = ["application/pdf", "text/plain"]
evidence = ["https://platform.openai.com/docs/guides/pdf-files"]
verified_at = "2026-09-01"

[capabilities.features.tool_calling]
status = "supported"
evidence = ["https://platform.openai.com/docs/guides/function-calling"]
verified_at = "2026-09-01"
```

Provider override + endpoints:

```toml
# providers/example/models/gpt-5-4.toml
base_model = "openai/gpt-5.4"

[capabilities.tasks.text_generation]
status = "supported"
evidence = ["https://docs.example.com/models/gpt-5-4"]
verified_at = "2026-09-10"

[capabilities.features.explicit_prompt_caching]
status = "unsupported"

[capabilities.features.implicit_prompt_caching]
status = "unknown"          # does not inherit the canonical claim's evidence

[capabilities.endpoints.transports]
[capabilities.endpoints.transports.http]
status = "supported"
evidence = ["https://docs.example.com/api/streaming"]
verified_at = "2026-09-10"
[capabilities.endpoints.transports.sse]
status = "supported"
evidence = ["https://docs.example.com/api/streaming"]
verified_at = "2026-09-10"
[capabilities.endpoints.transports.websocket]
status = "unsupported"

[capabilities.endpoints.operations]
[capabilities.endpoints.operations.chat]
status = "supported"
[capabilities.endpoints.operations.responses]
status = "unsupported"
```

### Field placement rules

| Field | Canonical (`models/`) | Provider (`providers/.../models/`) | Notes |
|---|---|---|---|
| `capabilities.tasks` | yes (defaults) | yes (overrides) | inherited by default |
| `capabilities.inputs` | yes | yes | inherited; `formats` provider-specific |
| `capabilities.features` | yes | yes | inherited |
| `capabilities.endpoints` | **no** (schema rejects) | yes | provider serving endpoint only |
| `aliases` | yes (canonical alias IDs) | yes (provider-scoped alias IDs) | **not inherited** into providers |
| `canonical` | no | optional authored reference; also generated | see §8 |

### Definitions (normative wording for docs)

- `text_generation` — produces free-form text tokens from a prompt.
- `image_generation` / `video_generation` — synthesize pixels/frames.
- `transcription` — speech-to-text.
- `speech_synthesis` — text-to-speech.
- `realtime_conversation` — bidirectional low-latency session.
- `embeddings` — produces vector representations.
- `reranking` — scores/reorders a candidate list.
- `evaluation` — the endpoint exposes a **dedicated scoring/evaluation operation** (judge
  API, reward/verifier endpoint). A model that has `benchmarks`, or that is *used* as a
  judge by an application, does **not** satisfy this definition.

## 7. Merge & resolution semantics

Reused as-is: `mergeDeep` (objects deep-merge, primitives/arrays replace), `base_model_omit`
dot paths. Additions:

1. **Inheritance:** `capabilities.tasks|inputs|features` are inheritable (not added to the
   exclusion list). `aliases` **is added to the exclusion list** so canonical alias IDs do
   not leak onto provider entries. `canonical` is generated per provider model.
2. **Explicit negative override:** provider writes `status = "unsupported"`; deep merge
   replaces the status, the provider's `evidence` array replaces the canonical one.
   Validator requires the provider override to carry its own evidence (§12).
3. **Reset to unknown:** provider writes `status = "unknown"`; generation normalization
   deletes inherited `evidence`/`verified_at` from that node, so the output is a clean
   `{ status = "unknown" }`. `base_model_omit = ["capabilities.features.web_search"]`
   removes the node entirely (absent = unknown).
4. **Provider exposes fewer capabilities:** either negative override or omit. Router reads
   the resolved value; provenance is available from `canonical` + evidence URLs.
5. **Legacy `modalities` stays orthogonal.** Existing consumers may continue reading
   `modalities.input` for coarse coverage, but the capability contract never synthesizes
   capability nodes from it. In particular, `output: ["text"]` does not imply
   `text_generation` (see §16 regression test).

Resolution algorithm (router-facing, in the contract doc):

```
effective(providerId, modelId):
  pm <- catalog.providers[providerId].models[modelId]
  for axis in [tasks, inputs, features, endpoints]:
    node <- pm.capabilities?.axis?[key]
    if node.status == "supported" or "unsupported" -> resolved(node.status, node.evidence)
    else -> UNKNOWN
```

Note: the registry already merges canonical defaults into provider entries at generation
time, so a provider entry showing `status = "supported"` may carry canonical evidence; the
entry's `canonical` field tells the consumer where the claim originates.

## 8. Aliases and canonical references

**Canonical aliases** (`models/`): `aliases = ["openai/gpt-5.4-latest"]`. Rules:
non-empty, shaped `<lab>/<model>`, unique across the whole catalog, and must not shadow an
existing canonical ID. Emitted on `models.json` entries and flattened into a
`catalog.aliases` map (`alias → canonical id`).

**Provider aliases** (provider file): `aliases = ["claude-opus-4-6-latest"]` scoped to the
provider; flattened as `<providerId>/<alias> → <providerId>/<modelId>`.

**Canonical reference** (provider-authored `canonical`, resolved output `canonical`):

- `canonical` is allowed in provider TOMLs as an authored reference (`AuthoredModelShape`)
  and emitted in generated output (`ModelShape`). It is an ordinary optional field; the
  generator recomputes/validates it, it is never inherited from canonical metadata, and it
  is preserved by sync.
- Resolution order (unambiguous; authored explicit reference wins over inference):
  1. `base_model` target if present. If an authored `canonical` also exists it must equal
     `base_model`, otherwise validation fails.
  2. else authored `canonical` (must resolve to an existing canonical model).
  3. else `<providerId>/<modelId>` if a matching canonical file exists (first-party hosts).
  4. else omitted (unknown relationship).

`base_model` itself remains parse-time-only and never appears in output. The generated
`canonical` field exposes the resolved relationship in the API without leaking the
inheritance pointer (the existing assertion at `packages/core/test/generate.test.ts:102-105`
stays green; new tests must assert `canonical` presence).

Consumers resolve an ID with: exact key → provider alias map → canonical alias map →
`canonical` field. No fuzzy matching.

## 9. Catalog generation & stable JSON contract

### Generation changes (`packages/core/src/generate.ts`, `schema.ts`)

- Add `assertProviderCapabilityEvidence(authoredModel)` run **pre-merge** in the
  `base_model` branch (before `mergeDeep`) so a provider changing a status must supply its
  own `evidence`/`verified_at`; canonical evidence must never back a changed provider claim.
- Add `normalizeCapabilities(model)` (strip `evidence`/`verified_at` on `status = "unknown"`)
  applied to canonical and merged provider models.
- Add `resolveCanonical(providerId, modelId, baseModel, authoredCanonical)` (§8 precedence).
- Exclude `aliases` from **both** `inheritableModelMetadata` implementations
  (`generate.ts:177-189`, `sync/index.ts:754-767`); keep `capabilities` inheritable.
- Build `aliases` index (canonical + provider scoped), fail on collisions.
- `generateCatalog()` returns `{ providers, models, aliases }` (new additive key); this
  changes exact-equality tests in `packages/sdk/test/types.ts:19` and must be updated with
  the SDK types in the same change.
- `provider` entries gain generated `canonical?: string`.
- `packages/core/src/filter.ts` must preserve the new top-level keys and alias entries for
  surviving targets; it currently returns only `{ providers, models }`. Update
  `filterCatalogByModelType`, `filterProvidersByModelType`, `filterModelsByModelType`,
  their types, and `packages/core/test/filter.test.ts`.

### Stable contract

`catalog.json` (and `_catalog*.json`) becomes:

```json
{
  "schema_version": 1,
  "generated_at": "2026-09-22T00:00:00Z",
  "aliases": {
    "openai/gpt-5.4-latest": "openai/gpt-5.4",
    "openrouter/anthropic/claude-opus-4.6-latest": "openrouter/anthropic/claude-opus-4.6"
  },
  "providers": { "...": { "models": { "...": { "canonical": "openai/gpt-5.4", "capabilities": { "...": {} } } } } },
  "models": { "...": { "aliases": ["openai/gpt-5.4-latest"], "capabilities": { "...": {} } } }
}
```

- `/api.json` (`ProviderMap`) and `/models.json` (`ModelMetadataMap`) keep their exact
  top-level shapes; new fields are additive inside entries.
- Versioning policy: `schema_version` increments only on breaking changes; additive keys do
  not bump. Consumers ignore unknown keys.
- `?type=` filtering must filter `aliases` to surviving targets.
- Snapshot: `@opencode-ai/models/snapshot` embeds `{ providers, models, aliases }` plus
  existing `generatedAt`; HTTP responses stay `Cache-Control: public, max-age=3600`.
- `/model-schema.json` ID enum may include aliases (additive) — optional.

## 10. API / SDK / web surface

| Surface | Change |
|---|---|
| `packages/core/src/filter.ts` | preserve `aliases`/`schema_version`/`generated_at` through `?type=` filtering |
| `packages/web/script/build.ts` | emit `aliases`, `schema_version`, `generated_at` in `_catalog*.json` |
| `packages/web/src/server.ts` | same for dev endpoints |
| `packages/function/src/worker.ts` | pass-through; alias-aware `?type=` filtering; optional alias IDs in `/model-schema.json` |
| `packages/sdk/src/types.ts` | `CapabilityStatus`, `Declaration`, `Capabilities`, `EndpointCapabilities`, `CapabilityTask/Input/Feature`, `Operation`, `Transport`; add `aliases`/`schema_version` to `Catalog` and `canonical`/`capabilities` to `Model`/`ModelMetadata` |
| `packages/sdk/script/generate.ts` | `loadCatalog()`/`snapshotPayload()` must carry `aliases`; snapshot emits it |
| `packages/sdk/src/snapshot.js` + `snapshot.d.ts` (generated/hand-written) | export `aliases`; update snapshot tests (`packages/sdk/test/*`) |
| `packages/sdk/src/generated.ts` (generated) | regenerate family union (unchanged unless families change) |
| `packages/sdk/src/client.ts` | unchanged; `resolveModel(id)` helper deferred (see Open Question 6), resolution documented instead |
| `packages/web/src/render.tsx` | render task/feature/endpoint badges on model/provider pages; add task slugs to search index (`index.ts` `SearchIndexItem.tokens`) |
| `packages/web/src/shared.ts` | task/feature icon or label helper (reuse `capabilitySummary`) |

## 11. Sync preservation (blocking)

Add to `packages/core/src/sync/index.ts` (mirroring `preserveReasoningOptions`):

- `preserveCapabilities(model, existing)` — carry authored `capabilities`, `aliases`, and
  authored `canonical` from the existing file when the translated model does not produce
  them; deep-merge capability objects so sync updates to other fields don't drop
  declarations.
- Call it in the translation pipeline before `SyncedAuthoredModel.safeParse`, and for
  metadata namespaces (`SyncedMetadata` → written via `formatMetadataToml`).
- **Serializers must emit the fields**: extend `formatToml()` (`sync/index.ts:1005-1080`)
  and `formatMetadataToml()` to write `aliases`, `canonical`, and nested capability
  tables/arrays. Without this, preserved objects are dropped at write time.
- Parser side is covered by adding the fields to `ModelMetadataBase`/`ModelBase`
  (`ExistingModel`, `SyncedAuthoredModel` are derived from `AuthoredModelShape`). Verify
  `deepPartial()` behavior with the refined capability fields (see §6).
- Ensure `sameModel()`/`stable()` comparisons include preserved fields; otherwise sync
  reports "unchanged" while the in-memory object differs.
- Add a sync round-trip test: a file with capabilities + aliases survives a no-op sync and
  a field-updating sync byte-for-byte (modulo header handling), and a re-sync is
  idempotent.

## 12. Validation rules (`bun validate`)

Schema-level:

1. Strict objects: unknown keys rejected everywhere (existing behavior).
2. `Declaration`: `supported`/`unsupported` ⇒ `evidence` (≥1 valid URL) + `verified_at`
   (valid `YYYY-MM-DD`); `unknown` ⇒ neither.
3. `formats`: media-type strings, only on `inputs.files`, only with `supported`.
4. `capabilities.endpoints` rejected in canonical files (already enforced by strict
   narrower schema on `ModelMetadata`).
5. Enum values restricted to the fixed slugs.
6. Alias format/namespace checks; alias uniqueness across the catalog; no alias equal to an
   existing canonical/provider model ID.

Cross-field refinements:

7. Legacy consistency: `tool_call` vs `features.tool_calling.status`,
   `reasoning` vs `features.reasoning.status`, `structured_output` vs
   `features.structured_output.status` — contradiction = error (equality ok).
8. Input consistency: explicit `inputs.<kind>.status = "unsupported"` while
   `modalities.input` contains that kind = error (`pdf ⇔ files`).
9. Endpoint consistency: an operation whose mapped task is explicitly `unsupported` =
   error. Normative operation → task mapping:

   | Operation | Task |
   |---|---|
   | `chat`, `responses`, `completions` | `text_generation` |
   | `embeddings` | `embeddings` |
   | `images` | `image_generation` |
   | `videos` | `video_generation` |
   | `transcriptions` | `transcription` |
   | `speech` | `speech_synthesis` |
   | `rerank` | `reranking` |
   | `realtime` | `realtime_conversation` |
   | `evaluate` | `evaluation` |

   An operation may be `supported` while its task is unknown (the endpoint exists but the
   task axis was not verified), but never while the task is explicitly `unsupported`.
   Multi-task endpoints declare one node per operation, each independently.
10. Provider-authored capability override must include evidence. Implemented as
    `assertProviderCapabilityEvidence()` called on the authored provider TOML **before**
    `mergeDeep` in the `base_model` branch (`generate.ts`), because post-merge validation
    cannot tell inherited evidence from provider evidence. Covered by a test that a
    provider status flip without evidence fails.
11. Cost inference guard: `cost.cache_read`/`cache_write` do **not** set
    `implicit/explicit_prompt_caching`; no automation exists or is added.
12. No task derivation from modalities: generation never synthesizes `tasks`.

## 13. Population plan (verified representative set)

Declarations require fetching the cited source and recording `verified_at` at edit time.
Candidates identified in the catalog (evidence URLs to be collected per model from the
lab/provider docs; no declaration without one):

| Task | Candidate entries (canonical) |
|---|---|
| `text_generation` | `openai/gpt-5.4`, `anthropic/claude-opus-4-6`, `cohere/command-a-reasoning-08-2025`, `openai/gpt-oss-20b` |
| `image_generation` | `openai/gpt-image-1`, `google/gemini-3.1-flash-image`, `xai/grok-imagine-image-2.0` |
| `video_generation` | `google/veo-3.1-fast-generate-preview`, `google/veo-3.1-lite-generate-preview`, `xai/grok-imagine-video-1.5`, `google/gemini-omni-flash-preview` |
| `transcription` | `openai/whisper-large-v3`, `openai/gpt-realtime-whisper`, `xai/grok-voice-stt-1.0`, `google/gemini-3.5-transcribe-live` |
| `speech_synthesis` | `xai/grok-voice-tts-1.0`, `google/gemini-3.1-flash-tts-preview`, `google/gemini-2.5-flash-tts` |
| `realtime_conversation` | `openai/gpt-realtime-2.1`, `google/gemini-3.1-flash-live-preview`, `google/gemini-3.5-live-translate-preview` |
| `embeddings` | `google/gemini-embedding-001`, `google/gemini-embedding-2`, `nvidia/llama-nemotron-embed-vl-1b-v2`; provider `openai/text-embedding-3-large` |
| `reranking` | `nvidia/llama-nemotron-rerank-vl-1b-v2`; provider-only `nvidia/rerank-qa-mistral-4b`, `regolo-ai/qwen3-reranker-4b` (add canonical lab entries where required by AGENTS.md) |
| `evaluation` | **none confirmed** — `benchmarks` do not qualify. Leave unknown except a dedicated scoring endpoint if one is found and documented (e.g. verify `typesafe/jev-latest` exposes a scoring operation before declaring). |

Provider-scope population (transports/operations, endpoints/evidence):

- First-party: `openai`, `anthropic`, `google`, `xai`, `cohere`, `nvidia`.
- Relays/native: `openrouter`, `amazon-bedrock`, `cloudflare-workers-ai`, `vercel`.

Negative/unknown examples to include (prove tri-state end-to-end):

- A relay declaring `endpoints.transports.websocket = "unsupported"`.
- A provider overriding a canonical `supported` to `unsupported` with its own evidence.
- A provider using `status = "unknown"` to refuse inheritance of a canonical claim.

## 14. Coverage report

New script `packages/core/script/capability-coverage.ts` (root script
`coverage:capabilities`):

- Per task: counts of `supported` / `unsupported` / `unknown` across canonical models,
  plus per-provider overrides.
- Per feature and per input (incl. declared `formats`).
- Endpoints: providers declaring transports/operations; operations without a matching task.
- Evidence health: declarations with evidence, stale `verified_at` (> 12 months) listed
  informationally, alias collisions (must be 0).
- Gap list: canonical models by lab with zero task declarations (the "unknown" backlog).
- Output: `docs/capabilities/coverage.md` (committed, regenerated by the script),
  `--json` for CI artifacts, and `--check` which exits non-zero when the committed report
  is stale (deterministic ordering: tasks/features/inputs sorted by slug, gaps sorted by
  id).
- Root `package.json` gains `"coverage:capabilities": "bun ./packages/core/script/capability-coverage.ts"`.
- `.github/workflows/validate.yml` gains a coverage step (`--check`) so a catalog change
  that alters coverage must update the report; validation itself gates
  evidence/consistency. Coverage is informational for unknown gaps (unknown is legal).

## 15. Documentation & router contract

New `docs/capabilities/contract.md` (stable contract + examples):

1. **Registry resolution** — canonical defaults → provider overrides → unknown; the
   algorithm from §7 with a worked JSON example for one provider model.
2. **Custom models** — router-local overlay format: reference a canonical ID
   (`canonical: "meta/llama-3.1-8b"`) and apply local capability overrides; the registry
   is a base layer, routers keep local entries out of the catalog.
3. **Fallback combos** — ordered provider-model candidate lists; prefilter by required
   tasks/features/inputs/limits using resolved capabilities; example JSON for a combo and
   the filter predicate; note that the registry does not execute fallbacks (OpenRouter
   `models[]` / LiteLLM `fallbacks` remain the runtime mechanism).
4. **Cached snapshot consumption** — `generated_at`, `schema_version`, 3600s HTTP cache,
   SDK snapshot pinning for deterministic behavior, cache-busting guidance.
5. **Tri-state semantics** — absent = unknown; `unsupported` is a negative claim with
   evidence; consumers must not downgrade unknown to false.
6. **Aliases** — resolution order and examples.

Update `README.md` (capability section + API contract link), `AGENTS.md` (field ownership,
evidence policy, "never infer from names/tools/cache pricing", evaluation definition),
`sync.md` (sync preserves capability fields).

## 16. Tests

| Area | Additions |
|---|---|
| `packages/core/test/schema.test.ts` | enum/format validation; evidence+date required; `verified_at` rejects `YYYY-MM`; unknown forbids evidence; endpoints rejected on canonical; contradictions with `tool_call`/`reasoning`/`structured_output`; alias rules; sparse capability maps parse and infer as optional keys |
| `packages/core/test/generate.test.ts` | canonical→provider inheritance; per-key negative override; pre-merge evidence assertion fails on evidence-less status flip; `status = "unknown"` strips inherited evidence; `base_model_omit` reset; arrays replaced (evidence/formats); aliases not inherited; generated `canonical` resolution (base_model / authored / same-id) incl. `base_model` vs conflicting authored `canonical` error; alias map + collision errors |
| new `packages/core/test/capabilities.test.ts` | resolution fixture covering tasks/inputs/features/endpoints; operation↔task consistency table; regression: an embeddings/reranker entry with legacy `modalities.output = ["text"]` and no `text_generation` declaration resolves to `unknown` for `text_generation` (contract never uses `output` as a task proxy) |
| `packages/core/test/filter.test.ts` | `?type=` filter preserves `aliases`/`schema_version`/`generated_at` and prunes aliases whose targets are filtered out |
| `packages/core/test/sync.test.ts` (+ one provider suite) | capability/alias/canonical preservation round-trip through both `preserveCapabilities()` **and** `formatToml()`; idempotent re-sync |
| `packages/function/test/worker.test.ts` | payloads include new fields; alias-aware `?type=`; contract keys `schema_version`/`aliases` on catalog endpoints |
| `packages/sdk/test/types.ts` + snapshot tests | exact assignability for new types, `Catalog.aliases`/`schema_version`; snapshot exports `aliases` |
| web | build smoke; badges render; search index contains task tokens |
| CI | `bun validate` + `bun test` + SDK tests + coverage `--check` run on PRs |

## 17. Compatibility & migration

- **All new TOML fields optional**; zero changes required to existing entries.
- Generated JSON is additively changed; no existing key changes type or meaning.
- SDK types gain optional fields; `Catalog` gains required `aliases`/`schema_version` in the
  generated snapshot (SDK release note).
- Web UI ignores unknown fields until badges land; no consumer breakage.
- Legacy booleans remain the fast-path for old consumers; capabilities win when both exist
  (and cannot contradict).
- Root `models.json` untouched.
- If upstream contribution is desired later: design is additive, TOML-native, and keeps
  `base_model` parse-time-only, so it is mergeable upstream after review.

## 18. Workstreams & acceptance criteria

**WS1 — Schema & generation core** (`packages/core/src/schema.ts`,
`packages/core/src/generate.ts`, `packages/core/src/filter.ts`,
`packages/core/test/schema.test.ts`, `packages/core/test/generate.test.ts`,
`packages/core/test/capabilities.test.ts`, `packages/core/test/filter.test.ts`)
Acceptance: new types validate (Zod 3.24-compatible); sparse maps infer optional keys;
inheritance/negatives/unknown-reset/aliases/`canonical` covered by tests; pre-merge
evidence assertion works; top-level keys survive filtering; `bun validate` green; no
existing test regressions.

**WS2 — Sync preservation** (`packages/core/src/sync/index.ts`,
`packages/core/test/sync.test.ts` + one provider suite)
Acceptance: `preserveCapabilities()` plus `formatToml()`/`formatMetadataToml()` round-trip
capability/alias/canonical fields; idempotent sync; deepPartial parse verified.

**WS3 — SDK/API/web exposure** (`sdk/src/types.ts`, `sdk/script/generate.ts`,
`snapshot.js`/`snapshot.d.ts`, `sdk/test/*`, `web/script/build.ts`, `web/src/server.ts`,
`function/src/worker.ts`, `function/test/worker.test.ts`)
Acceptance: type-parity tests pass; snapshot exports `aliases`; `catalog.json` carries
`schema_version`, `generated_at`, `aliases`; `?type=` filtering alias-aware at both build
and worker; SDK client methods unchanged.

**WS4 — Population** (canonical + provider TOMLs from §13)
Acceptance: every task axis has verified entries (except `evaluation`, documented gap);
every declaration has evidence + `verified_at`; at least one negative and one explicit
unknown override in-tree; `bun validate` green.

**WS5 — Coverage report** (`packages/core/script/capability-coverage.ts`, root
`package.json` script, `.github/workflows/validate.yml` step)
Acceptance: script generates `docs/capabilities/coverage.md` + JSON and supports
`--check`; report matches catalog; CI fails on stale committed report.

**WS6 — Documentation & contract** (`docs/capabilities/contract.md`, `README.md`,
`AGENTS.md`, `sync.md`)
Acceptance: stable contract + four router examples (override resolution, custom models,
fallback combos, cached snapshot); no timeline language; links resolve.

**WS7 — Web surfacing** (optional, `render.tsx`, `shared.ts`, `index.ts`)
Acceptance: model/provider pages show task/feature/endpoint badges; search matches task
slugs; no layout regressions.

Dependency order: WS1 → WS2/WS3/WS4 (WS4 depends on WS1) → WS5 → WS6; WS7 after WS3.

**Definition of done**

- [ ] `bun validate` and `bun test` pass; SDK tests (types + snapshot) pass.
- [ ] `catalog.json` additive fields documented and versioned; top-level keys survive
      `?type=` filtering.
- [ ] All declarations evidence-backed; no inference from names/tools/pricing.
- [ ] Tri-state provable via in-tree examples; embeddings/rerank separation regression test.
- [ ] Sync round-trip preserves capabilities/aliases/canonical.
- [ ] Coverage report committed (`--check` green) with remaining gaps listed.
- [ ] Router contract examples executable as documented.

## 19. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Sync silently drops hand-authored capabilities | High — data loss | WS2 preservation + round-trip tests; validate after sync in CI |
| Merge arrays replace inherited evidence | Medium — attribution loss | Validator requires provider evidence on overrides; generation strips stale evidence on `unknown` |
| Over-declaration / capability rot | Medium — misrouting | Evidence+date mandatory; coverage report surfaces stale dates; review checklist |
| SDK exact-assignability tests break | Low | Update types and fixture in same PR; regenerate snapshot |
| Catalog size growth | Low | Fields are sparse; absent = unknown |
| Relays cannot declare transports accurately | Medium — false unknown | Tri-state; explicit unknown allowed; docs tell consumers unknown ≠ unsupported |
| `evaluation` task has no verified model | Low | Documented gap in coverage; benchmark ≠ evaluation rule prevents false positives |
| Upstream divergence | Medium | Keep additive/TOML-native, avoid changing existing semantics |

## 20. Open questions

1. `catalog.json` top-level additions (`schema_version`, `generated_at`, `aliases`):
   acceptable to existing consumers, or should a new `/registry.json` endpoint carry the
   contract and leave `catalog.json` byte-compatible?
2. Should generated provider entries expose per-capability provenance
   (`canonical` vs `provider` origin), or is `canonical` + evidence URLs sufficient?
3. Add `file` to the `Modality` enum (touches SDK/web/describe) or keep `pdf` + the
   capabilities `files` node as the only file representation?
4. Evidence freshness policy: is a stale `verified_at` (> 6/12 months) a warning, an error,
   or informational only?
5. First population batch size/owners: which providers must be verified by hand vs synced?
6. Should the SDK ship a `resolveModel(id)`/`effectiveCapabilities()` helper, or keep the
   resolution algorithm doc-only?
7. Upstream contribution intent — do we want these changes mergeable to upstream
   models.dev, or fork-only with a hard JSON versioning contract?

## 21. References

- Internal: `packages/core/src/schema.ts`, `generate.ts`, `sync/index.ts`,
  `packages/sdk/src/types.ts`, `packages/web/script/build.ts`,
  `packages/function/src/worker.ts`, `AGENTS.md`, `README.md`, `sync.md`.
- OpenRouter model list (`architecture`, `supported_parameters`, `canonical_slug`,
  fallback `models[]`): <https://openrouter.ai/docs/api-reference/list-available-models>,
  <https://openrouter.ai/docs/guides/routing/model-fallbacks>.
- AI SDK v5 provider interfaces (`LanguageModelV2`, `EmbeddingModelV2`, `ImageModelV2`,
  speech/transcription): <https://ai-sdk.dev/docs/ai-sdk-core/provider-management>.
- Anthropic Models API `capabilities` shape:
  <https://platform.claude.com/docs/en/api/models/list>.
- Bedrock `GetFoundationModel` (`inputModalities`, `outputModalities`,
  `responseStreamingSupported`):
  <https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetFoundationModel.html>.
- Hugging Face pipeline task taxonomy: <https://huggingface.co/tasks>.
- LiteLLM router fallbacks/config: <https://docs.litellm.ai/docs/routing>.

## 22. Implementation notes (as built)

Deviations from this plan, recorded after implementation:

- **Same-ID first-party entries inherit canonical capabilities.** Providers that
  author full inline models (`providers/openai/...`, `providers/anthropic/...`,
  `providers/google/...`) do not use `base_model`, so generation now applies
  canonical capability defaults when a provider model resolves to a same-ID
  canonical model. `base_model` entries keep the existing merge path.
- **Inherited contradictions downgrade to unknown, authored ones stay errors.**
  A provider legacy boolean or modality override that contradicts an *inherited*
  canonical capability deletes that node (unknown). Contradictions authored in
  the same file remain validation errors, and final output is re-validated with
  `Model.safeParse`.
- **`messages` operation added** for Anthropic's Messages API (`chat` remains for
  chat-completions-style hosts).
- **`Catalog.generated_at` is optional and stripped from the SDK snapshot
  payload** so `--if-changed` publishing stays deterministic; HTTP payloads
  include it.
- **Aliases** are fully supported and emitted, but only one verified canonical
  alias shipped initially (`openai/gpt-5.4-2026-03-05`); further aliases require
  verified identity relationships.

## 23. Next steps

1. Answer open questions 1–3 (contract shape, provenance, `file` modality) — these change
   WS1/WS3 schemas.
2. Land WS1 + WS2 behind the existing test suites (`bun validate` must stay green).
3. Pick and verify the population batch (WS4), starting with one task axis end-to-end
   (recommended: `embeddings`, because it proves tasks ≠ modalities).
4. Wire WS3, then WS5 coverage report, then WS6 docs + examples.
5. Review PR with the reasoning-options skill applied to any capability/effort overlaps.
