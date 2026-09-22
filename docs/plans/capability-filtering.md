# Capability Filtering — Implementation Plan

**Author:** Platform eng (draft)
**Date:** 2026-09-22
**Status:** Implemented on `dev` (OR within an axis, AND across axes; other open
questions resolved with the recommended defaults)
**Depends on:** capability registry work (currently uncommitted on `dev`): tri-state
`capabilities` on canonical and provider models, resolved provider inheritance,
`aliases`/`canonical` in generated JSON, coverage report.

---

## 1. Problem

The catalog now carries evidence-backed capability metadata, but nothing can be
filtered by it:

- **API consumers** must fetch the full catalog (5.5 MB `_catalog-all.json` at
  current size) and filter client-side. `?type=` only filters model *type*
  (`decision`), not tasks, features, inputs, or endpoints.
- **Web users** can only use the global search modal. The per-table `data-search`
  row attributes exist (for example `render.tsx:1173` now includes capability
  slugs) but **no client code reads them** — there is no table filter input.
- **Routers** building fallback combos need requirement-style filtering on the
  API (`task=text_generation&feature=tool_calling&input=image`), not text search.

## 2. Goal

Add capability filtering to the API, SDK, and web app with one consistent,
documented matching semantics.

**Success criteria**

1. `/api.json`, `/models.json`, `/catalog.json` accept capability query params,
   return only matching entries, and keep `aliases` consistent (pruned to
   surviving targets); unknown slugs return HTTP 400 with an allowed-values list.
2. `/model-schema.json` returns the same filtered ID set when filters are set.
3. SDK exposes typed filter options and encodes them into request URLs.
4. Web model/provider tables get facet controls that filter rows client-side,
   sync to the URL (`?task=…&feature=…`), and degrade gracefully without JS
   (all rows rendered, filters client-only).
5. Missing/`unknown` capability nodes never satisfy a filter; only explicit
   `supported` matches.
6. Existing unfiltered URLs behave byte-identically; `?type=` behavior and static
   assets are unchanged.
7. Tests, contract docs, and README updated; `bun validate`, core/function/SDK
   suites, coverage check, and web build pass.

## 3. Scope

### In scope (v1)

- Query params: `task`, `feature`, `input`, `operation`, `transport`.
- Matching semantics: **AND across params, OR within a comma-separated param**
  (see §5; decision pending).
- Runtime filtering in the Cloudflare worker and the dev server, with response
  caching; SDK options; web facets on the models index, provider model tables,
  and model-detail provider tables; URL state; tests; docs.

### Out of scope

- Pre-built static filter variants (combinatorial explosion); capability
  filtering stays runtime.
- Router policy execution, health checks, or fallback execution.
- A dedicated `/filter.json` endpoint or saved filter sets.
- Full-text search changes (global search modal stays as-is).
- Per-model capability probing / live verification.
- UI redesign beyond a filter toolbar.

## 4. Current state (audit)

- `packages/function/src/worker.ts:155-225`: `catalogResponse(url, request, env, endpoint)`.
  `?type=` default filtering happens at request time on the pre-generated asset;
  `?type=all|decision` returns a pre-built asset directly. `Cache-Control:
  public, max-age=3600`; no `caches.default` usage. `/model-schema.json` builds
  an ID enum (`worker.ts:76-108`).
- `packages/web/src/server.ts:115-140`: dev mirror of the same routing with
  `filterCatalogByModelType`.
- `packages/core/src/filter.ts`: `parseModelTypes`, `filterProvidersByModelType`,
  `filterModelsByModelType`, `filterCatalogByModelType` (already preserves
  `schema_version`/`generated_at` and prunes `aliases` for filtered targets).
- `packages/web/script/build.ts:82-96`: writes `_api*`, `_models*`, `_catalog*`
  variants for default/all/decision.
- `packages/web/src/index.ts`: global search modal (uses search-index tokens),
  table sorting and copy buttons. `data-search` attributes are set in
  `render.tsx` but never consumed — there is currently no table search/filter.
- `packages/sdk/src/client.ts`: `RequestOptions.modelTypes` and query-string
  encoding; `providers()`, `models()`, `catalog()`.
- Capability metadata lookup helpers exist in `packages/web/src/shared.ts`
  (`capabilityStatusText`, `capabilitySearchTokens`).

## 5. API design

### Parameters

| Param | Values | Applies to |
| --- | --- | --- |
| `task` | `text_generation`, `image_generation`, `video_generation`, `transcription`, `speech_synthesis`, `realtime_conversation`, `embeddings`, `reranking`, `evaluation` | canonical + provider models |
| `feature` | `reasoning`, `tool_calling`, `structured_output`, `web_search`, `implicit_prompt_caching`, `explicit_prompt_caching` | canonical + provider models |
| `input` | `text`, `image`, `audio`, `video`, `files` | canonical + provider models |
| `operation` | `chat`, `messages`, `responses`, `completions`, `embeddings`, `images`, `videos`, `transcriptions`, `speech`, `rerank`, `realtime`, `evaluate` | provider models only |
| `transport` | `http`, `sse`, `websocket` | provider models only |

- Comma-separated values; duplicate values are de-duplicated.
- Unknown or empty values → `400` with `{ error, allowed: { task: [...], … } }`,
  matching the existing `?type=` error shape (`worker.ts:165-175`).
- `task`/`feature`/`input` may be combined with `?type=`; all conditions AND.

### Matching semantics (recommended)

- **AND across parameters** — every requested axis must be satisfied.
- **OR within one parameter** — `?task=embeddings,reranking` matches models that
  do either. This matches facet UX and discovery; router-style "all of these"
  is expressed as separate params (`?task=text_generation&feature=tool_calling`).
- A request only matches a node whose resolved `status === "supported"`.
  `unknown` (absent) and `unsupported` never match.
- Provider models are matched on their **resolved** capabilities (already merged
  with same-ID canonical defaults), so a relay entry matches when it inherits a
  canonical claim and does not override it. Explicit provider negatives or
  downgrades are respected.
- `operation`/`transport` filters only have meaning on provider entries; when
  applied to `/models.json` (canonical only), they return an empty map rather
  than erroring. Document this.

### Examples

```bash
# Embedding models (none are text generators)
curl "https://models.dev/models.json?task=embeddings"

# Agent-capable vision models
curl "https://models.dev/api.json?task=text_generation&feature=tool_calling&input=image"

# Realtime voice endpoints that expose a WebSocket
curl "https://models.dev/api.json?transport=websocket&operation=realtime"

# Discovery: models doing either embeddings or reranking
curl "https://models.dev/models.json?task=embeddings,reranking"

# Combined with model type
curl "https://models.dev/catalog.json?type=all&task=evaluation"
```

## 6. Implementation

### 6.1 Core (`packages/core/src/filter.ts`)

```ts
export interface CapabilityFilter {
  tasks?: CapabilityTaskValue[];
  features?: CapabilityFeatureValue[];
  inputs?: CapabilityInputValue[];
  operations?: OperationValue[];
  transports?: TransportValue[];
}

export function parseCapabilityFilter(params: URLSearchParams): CapabilityFilter;
// throws InvalidCapabilityFilterError with { param, value, allowed }

export function filterProvidersByCapabilities<T>(providers: T, filter): T;
export function filterModelsByCapabilities<T>(models: T, filter): T;
export function filterCatalogByCapabilities<T>(catalog: T, filter): T;
```

- Reuse the alias-pruning helper from `filterCatalogByModelType` (extract a
  shared `pruneAliases(catalog, providers, models)` so both filters use it).
- Compose with model-type filtering: `filterCatalog(catalog, { type, capabilities })`
  or run sequentially; document that either order yields the same result.
- Empty filter object returns the input unchanged (identity, no clone) so the
  unfiltered fast path is untouched.
- Invalid slugs throw a typed error; the worker/server map it to 400.

### 6.2 Worker (`packages/function/src/worker.ts`)

- Parse capability params before asset selection.
- When any capability filter is present:
  - Force the `-all` asset for the endpoint (`_api-all.json`, `_models-all.json`,
    `_catalog-all.json`) because capabilities must be matched before the default
    type filter is applied (or apply both filters in one pass).
  - Filter at runtime with core helpers; then apply the `type` filter.
  - Reuse the existing response headers (`Content-Type`, `Cache-Control`,
    `Content-Length`/`ETag` stripping).
- **Cache filtered payloads** with the Workers Cache API
  (`caches.default.match/put`, keyed by the full request URL, `Cache-Control:
  public, max-age=3600`) so repeated filter combinations skip the JSON parse.
  On cache miss, compute and `put`. Unfiltered paths are untouched.
- `/model-schema.json`: apply the same filter to the ID enum when capability
  params are present (consistent with the current `?type=` behavior).
- 400 responses include `allowed` for each invalid param; keep the existing
  `Access-Control-Allow-Origin: *` error header behavior.

### 6.3 Dev server (`packages/web/src/server.ts`)

- Mirror the parameter parsing and filtering using the core helpers so local dev
  and prod behave identically, including the capability+type combination.

### 6.4 Static build (`packages/web/script/build.ts`)

- No new variants. Capability filtering is runtime-only; document this in the
  contract (already implied by `?type=all` usage).

### 6.5 SDK (`packages/sdk`)

- Extend `RequestOptions`:

```ts
export interface CapabilityFilter {
  tasks?: CapabilityTask[]
  features?: CapabilityFeature[]
  inputs?: CapabilityInput[]
  operations?: Operation[]
  transports?: Transport[]
}
export interface RequestOptions {
  readonly signal?: AbortSignal
  readonly headers?: HeadersInput
  readonly modelTypes?: "all" | readonly ModelType[]
  readonly capabilities?: CapabilityFilter
}
```

- `request()` encodes `task=…&feature=…&input=…&operation=…&transport=…`
  (comma-joined, sorted for stable URLs), alongside `type`.
- Export `CapabilityFilter`; add tests for URL encoding; update SDK README with
  filter examples.

### 6.6 Web UI

**Facet data (server-rendered)**

- Add `data-capabilities` to each filterable row in `render.tsx`:
  - canonical models table (`render.tsx:1068`): `tasks` + `features` + `inputs`
    supported slugs, plus `"unsupported:<slug>"` entries only if we later add a
    status filter (not in v1).
  - provider model tables (`render.tsx:1173`): same, plus `endpoints.transports`
    and `endpoints.operations` on provider pages.
  - model-detail provider table: tasks/features from the resolved provider model.
- Compute the facet option list server-side from the rows being rendered (only
  show facets that occur), and render a filter bar inside `TableSection`.

**Client behavior (`packages/web/src/index.ts`)**

- New `initCapabilityFilters()`:
  - For each `table[data-enhanced-table]` with a filter bar, read checkbox
    groups, filter `<tr>` rows on `data-capabilities`, update the visible count
    and the empty-row message.
  - AND across facet groups, OR within a group (consistent with the API).
  - Sync state to the URL with `history.replaceState` (`?task=…&feature=…`);
    initialize from the URL on load and restore on back/forward (`popstate`).
  - "Clear all" control; `aria-live` count; keyboard-accessible checkboxes.
- Keep global search unchanged; optionally wire the unused `data-search`
  attributes into a per-table text filter later (Open Question 7).

**Markup/CSS**

- `TableSection` gains an optional `filters` prop rendering a `<fieldset>` per
  facet with checkbox groups and counts; styles added to the web stylesheet used
  by `render.tsx`/`index.html`.
- No-JS behavior: all rows render; filter bar is `hidden` unless JS initializes
  it (progressive enhancement) OR remains visible but inert — decision in
  implementation; prefer hidden to avoid dead controls.

## 7. Tests

| Area | Tests |
| --- | --- |
| `packages/core/test/filter.test.ts` | parse valid/invalid params; OR within / AND across; supported-only matching; unknown/unsupported excluded; provider resolved inheritance; alias pruning; identity for empty filter; combination with `type` |
| `packages/function/test/worker.test.ts` | capability params on `api/models/catalog`; 400 + allowed list; `?type=all` combination; `/model-schema.json` filtering; cache hit path (mock `caches.default` in `Env`) |
| `packages/sdk/test/client.test.ts` | query encoding for all params; combinations with `modelTypes`; stable ordering |
| web | typecheck + `bun run build`; build-time assertion that rendered HTML contains facet markup and `data-capabilities`; manual testing guide in the PR |
| CI | existing `bun validate`, core tests, function tests, SDK tests, coverage check; no new workflows |

## 8. Performance & caching

- Biggest risk: parsing `_catalog-all.json` (5.5 MB) per filtered request.
  Mitigations:
  1. Workers Cache API for filtered result URLs (primary).
  2. Optional build-time capability index (e.g. `_capabilities.json`, mapping
     `provider/model` → supported slugs) to pre-filter IDs cheaply, then build
     the response from the big asset only for survivors. Decide after measuring
     with Cache API in place (Open Question 5).
- Unfiltered requests and `?type=all|decision` static paths must not regress;
  verify by comparing response bodies before/after.
- Web: client-side row filtering is linear in rendered rows (max ~1–2k in
  provider tables); no virtualization changes required unless measured slow.

## 9. Compatibility

- Additive query params; existing URLs unchanged.
- `aliases`/`canonical` handling reuses the existing pruning helper; filtered
  canonical IDs still resolve.
- SDK changes are additive (`capabilities` optional).
- Static assets and their names unchanged.
- No schema changes: filtering reads existing `capabilities`.

## 10. Risks & mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| OR/AND semantics confusion | Misrouted requests | Document in `contract.md` with examples; tests for both axes |
| Per-request JSON parse cost in worker | Latency/cost | Cache API; optional compact index; benchmark before/after |
| Filtered responses cached wrongly (CORS/headers) | Stale/missing headers | Always rebuild headers on cache hit or cache the full `Response` including headers |
| `operation`/`transport` on `/models.json` confusing | UX | Return empty map + documented note |
| UI facets on large tables | Slow interaction | Linear filter; measure; debounce not needed |
| Unknown vs unsupported user confusion | Wrong expectations | UI shows only `supported` matches; docs state unknown never satisfies a filter |
| Provider inherits canonical claim but host lacks it | False positive | Already handled: provider downgrades/explicit unknowns are respected at generation time |

## 11. Open questions

1. Confirm matching semantics: **OR within a param, AND across params** (recommended),
   or strict AND within a param too (router-requirement style)?
2. Add a `status=` param to match `unsupported`/`unknown` for audits, or keep
   supported-only in v1?
3. UI surfaces for v1: models index + provider page tables + model-detail provider
   table (recommended), or models index only?
4. Should `/model-schema.json` honor capability filters (recommended: yes for
   consistency), or stay filter-agnostic?
5. Cache strategy: start with Workers Cache API only, or also add the compact
   capabilities index asset?
6. Should `/api.json` return a provider entry when the *canonical* model matches
   but the provider explicitly downgraded the capability to unknown? Current rule:
   no (resolved provider value wins). Confirm.
7. Wire the existing unused `data-search` row attributes into a per-table text
   filter as part of this work, or leave for a separate change?

## 12. Next steps

1. Resolve Open Questions 1–3 (semantics, status param, UI surfaces).
2. Implement core filter helpers + tests (`filter.ts`,
   `packages/core/test/filter.test.ts`).
3. Wire worker + dev server + 400s + Cache API; extend function tests.
4. Add SDK options + URL encoding tests and README examples.
5. Build web facets (server markup, `data-capabilities`, client filter, URL
   state) and verify with `bun run build` + manual testing.
6. Update `docs/capabilities/contract.md` and `README.md`; run `bun validate`,
   `bun test`, SDK tests, and `coverage:capabilities --check`.
