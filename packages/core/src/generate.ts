import path from "path";
import { existsSync } from "node:fs";
import { mergeDeep } from "remeda";
import { z } from "zod";

import {
  CapabilityFeatureValues,
  CapabilityInputValues,
  CapabilityTaskValues,
  INPUT_MODALITIES,
  OperationValues,
  Provider,
  Model,
  AuthoredModel,
  AuthoredModelShape,
  ModelMetadata,
  TransportValues,
} from "./schema.js";

const BaseModel = AuthoredModelShape
  .deepPartial()
  .extend({
    id: z.string(),
    base_model: z.string().min(1, "Base model cannot be empty"),
    base_model_omit: z.array(z.string()).optional(),
  })
  .strict();

export const CATALOG_SCHEMA_VERSION = 1;

export interface Catalog {
  schema_version: number;
  /** ISO timestamp of catalog generation. Omitted from deterministic snapshots. */
  generated_at?: string;
  models: Record<string, ModelMetadata>;
  providers: Record<string, Provider>;
  aliases: Record<string, string>;
}

export async function generateCatalog(directory: string): Promise<Catalog> {
  const models = await generateModels(path.join(directory, "models"));
  const providers = await generateProviders(
    path.join(directory, "providers"),
    models,
  );

  return {
    schema_version: CATALOG_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    models,
    providers,
    aliases: buildAliases(models, providers),
  };
}

export async function generateModels(directory: string) {
  const result: Record<string, ModelMetadata> = {};
  if (!existsSync(directory)) return result;

  for await (const modelPath of new Bun.Glob("**/*.toml").scan({
    cwd: directory,
    absolute: true,
    followSymlinks: true,
  })) {
    const modelID = path.relative(directory, modelPath).split(path.sep).join("/").slice(0, -5);
    const toml = await import(modelPath, {
      with: {
        type: "toml",
      },
    }).then((mod) => mod.default);
    toml.id = modelID;

    const model = ModelMetadata.safeParse(toml);
    if (!model.success) {
      model.error.cause = { modelPath, toml };
      throw model.error;
    }
    result[modelID] = model.data;
  }

  return result;
}

export async function generate(directory: string) {
  const modelsDirectory = path.join(path.dirname(directory), "models");
  const models = await generateModels(modelsDirectory);

  return generateProviders(directory, models);
}

async function generateProviders(
  directory: string,
  models: Record<string, ModelMetadata>,
) {
  const result: Record<string, Provider> = {};
  for await (const providerPath of new Bun.Glob("*/provider.toml").scan({
    cwd: directory,
    absolute: true,
  })) {
    const providerID = path.basename(path.dirname(providerPath));
    const toml = await import(providerPath, {
      with: {
        type: "toml",
      },
    }).then((mod) => mod.default);
    toml.id = providerID;
    toml.models = {};
    const provider = Provider.safeParse(toml);
    if (!provider.success) {
      provider.error.cause = { providerPath, toml };
      throw provider.error;
    }

    const modelsPath = path.join(directory, providerID, "models");
    if (!existsSync(modelsPath)) {
      throw new Error(`Provider "${providerID}" has no models`, {
        cause: { providerPath },
      });
    }
    for await (const modelPath of new Bun.Glob("**/*.toml").scan({
      cwd: modelsPath,
      absolute: true,
      followSymlinks: true,
    })) {
      const modelID = path.relative(modelsPath, modelPath).split(path.sep).join("/").slice(0, -5);
      const toml = await import(modelPath, {
        with: {
          type: "toml",
        },
      }).then((mod) => mod.default);
      toml.id = modelID;
      if (toml.base_model !== undefined) {
        assertProviderCapabilityEvidence(toml, modelPath);
        const baseModel = BaseModel.safeParse(toml);
        if (!baseModel.success) {
          baseModel.error.cause = { modelPath, toml };
          throw baseModel.error;
        }

        const merged = mergeBaseModel(baseModel.data, models, modelPath);
        const model = AuthoredModel.safeParse(merged);
        if (!model.success) {
          model.error.cause = { modelPath, toml: merged };
          throw model.error;
        }
        provider.data.models[modelID] = finalizeProviderModel(
          model.data,
          providerID,
          modelID,
          toml,
          models,
          modelPath,
        );
        continue;
      }
      const model = AuthoredModel.safeParse(toml);
      if (!model.success) {
        model.error.cause = { modelPath, toml };
        throw model.error;
      }
      provider.data.models[modelID] = finalizeProviderModel(
        model.data,
        providerID,
        modelID,
        toml,
        models,
        modelPath,
      );
    }
    if (Object.keys(provider.data.models).length === 0) {
      throw new Error(`Provider "${providerID}" has no models`, {
        cause: { providerPath },
      });
    }
    result[providerID] = provider.data;
  }

  const nameToProviderID = new Map<string, string>();
  for (const provider of Object.values(result)) {
    const nameKey = provider.name.toLowerCase();
    const existingID = nameToProviderID.get(nameKey);
    if (existingID !== undefined) {
      throw new Error(
        `Duplicate provider name "${provider.name}" used by both "${existingID}" and "${provider.id}". Provider names must be unique.`,
        { cause: { providerIDs: [existingID, provider.id], name: provider.name } },
      );
    }
    nameToProviderID.set(nameKey, provider.id);
  }

  return result;
}

function mergeBaseModel(
  model: z.infer<typeof BaseModel>,
  models: Record<string, ModelMetadata>,
  modelPath: string,
) {
  const base = models[model.base_model];
  if (base === undefined) {
    throw new Error(`Unable to resolve base_model: ${model.base_model}`, {
      cause: { modelPath, toml: model },
    });
  }

  const { base_model: _baseModel, base_model_omit: omit, ...overrides } = model;
  const merged: Record<string, unknown> = structuredClone(
    mergeDeep(inheritableModelMetadata(base), overrides),
  );

  applyOmit(merged, omit ?? []);
  // A provider that explicitly disables a legacy feature boolean without
  // authoring its own capability declaration exposes fewer capabilities than
  // the canonical model. Resolve that to unknown instead of claiming support.
  downgradeContradictedFeatures(merged, overrides);
  downgradeContradictedInputs(merged, overrides);
  // An explicit `unknown` must clear inherited evidence before the merged
  // model is validated: unknown declarations forbid evidence.
  return normalizeCapabilities(merged);
}

const FEATURE_BOOLEAN_FIELDS: Array<[string, string]> = [
  ["reasoning", "reasoning"],
  ["tool_calling", "tool_call"],
  ["structured_output", "structured_output"],
];

/**
 * Applies canonical capability defaults to a provider model. `base_model`
 * entries already inherit during the merge; this covers first-party entries
 * that resolve to a same-ID canonical model, and re-applies provider
 * overrides on top so explicit negatives and unknowns always win.
 */
function applyCanonicalCapabilities(
  model: Record<string, unknown>,
  canonicalID: string | undefined,
  models: Record<string, ModelMetadata>,
  authored: Record<string, unknown>,
  inheritDefaults: boolean,
): Record<string, unknown> {
  const canonical =
    canonicalID === undefined ? undefined : models[canonicalID];
  const canonicalCapabilities = canonical?.capabilities as
    | Record<string, unknown>
    | undefined;
  if (inheritDefaults && canonicalCapabilities !== undefined) {
    model.capabilities = mergeDeep(
      canonicalCapabilities,
      (model.capabilities as Record<string, unknown> | undefined) ?? {},
    );
  }

  downgradeContradictedFeatures(model, authored);
  downgradeContradictedInputs(model, authored);
  normalizeCapabilities(model);
  return model;
}

function capabilityGroups(model: Record<string, unknown>) {
  const capabilities = model.capabilities;
  if (
    capabilities === null ||
    typeof capabilities !== "object" ||
    Array.isArray(capabilities)
  ) {
    return undefined;
  }
  return capabilities as Record<string, unknown>;
}

function authoredCapabilities(authored: Record<string, unknown>) {
  const capabilities = authored.capabilities;
  if (
    capabilities === null ||
    typeof capabilities !== "object" ||
    Array.isArray(capabilities)
  ) {
    return undefined;
  }
  return capabilities as Record<string, unknown>;
}

function downgradeContradictedInputs(
  target: Record<string, unknown>,
  overrides: Record<string, unknown>,
) {
  const modalities = overrides.modalities;
  if (
    modalities === null ||
    typeof modalities !== "object" ||
    Array.isArray(modalities)
  ) {
    return;
  }
  const inputModalities = (modalities as { input?: unknown }).input;
  if (!Array.isArray(inputModalities)) return;

  const groups = capabilityGroups(target);
  const inputs = groups?.inputs as
    | Record<string, { status?: unknown } | undefined>
    | undefined;
  if (inputs === undefined) return;

  const overridesInputs = authoredCapabilities(overrides)?.inputs as
    | Record<string, unknown>
    | undefined;

  for (const [kind, modality] of INPUT_MODALITIES) {
    if (overridesInputs?.[kind] !== undefined) continue;
    if (
      inputs[kind]?.status === "unsupported" &&
      inputModalities.includes(modality)
    ) {
      delete inputs[kind];
    }
  }
}

function downgradeContradictedFeatures(
  target: Record<string, unknown>,
  overrides: Record<string, unknown>,
) {
  const capabilities = target.capabilities;
  if (
    capabilities === null ||
    typeof capabilities !== "object" ||
    Array.isArray(capabilities)
  ) {
    return;
  }
  const features = (capabilities as Record<string, unknown>).features;
  if (
    features === null ||
    typeof features !== "object" ||
    Array.isArray(features)
  ) {
    return;
  }

  const overrideFeatures =
    overrides.capabilities !== null &&
    typeof overrides.capabilities === "object" &&
    !Array.isArray(overrides.capabilities)
      ? ((overrides.capabilities as Record<string, unknown>).features as
          | Record<string, unknown>
          | undefined)
      : undefined;

  for (const [feature, field] of FEATURE_BOOLEAN_FIELDS) {
    if (overrides[field] === undefined) continue;
    if (overrideFeatures?.[feature] !== undefined) continue;

    const value = target[field];
    const node = (features as Record<string, { status?: unknown } | undefined>)[
      feature
    ];
    if (typeof value !== "boolean" || node === undefined) continue;

    if (value !== (node.status === "supported")) {
      delete (features as Record<string, unknown>)[feature];
    }
  }
}

function inheritableModelMetadata(model: ModelMetadata) {
  const {
    id: _id,
    benchmarks: _benchmarks,
    license: _license,
    links: _links,
    weights: _weights,
    aliases: _aliases,
    ...metadata
  } = model;

  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
}

type CapabilityNode = {
  status?: unknown;
  evidence?: unknown;
  verified_at?: unknown;
};

/**
 * Provider capability overrides are validated before merging because canonical
 * evidence would otherwise satisfy the provider's declaration after the deep
 * merge, hiding a claim that has no evidence of its own.
 */
function assertProviderCapabilityEvidence(
  toml: Record<string, unknown>,
  modelPath: string,
) {
  const capabilities = toml.capabilities;
  if (
    capabilities === null ||
    typeof capabilities !== "object" ||
    Array.isArray(capabilities)
  ) {
    return;
  }

  const nodes: Array<[string, CapabilityNode]> = [];
  const collect = (path: string, group: unknown) => {
    if (group === null || typeof group !== "object" || Array.isArray(group)) {
      return;
    }
    for (const [key, node] of Object.entries(group as Record<string, unknown>)) {
      if (node !== null && typeof node === "object" && !Array.isArray(node)) {
        nodes.push([`${path}.${key}`, node as CapabilityNode]);
      }
    }
  };

  const caps = capabilities as Record<string, unknown>;
  collect("capabilities.tasks", caps.tasks);
  collect("capabilities.inputs", caps.inputs);
  collect("capabilities.features", caps.features);

  const endpoints = caps.endpoints;
  if (
    endpoints !== null &&
    typeof endpoints === "object" &&
    !Array.isArray(endpoints)
  ) {
    const groups = endpoints as Record<string, unknown>;
    collect("capabilities.endpoints.transports", groups.transports);
    collect("capabilities.endpoints.operations", groups.operations);
  }

  for (const [path, node] of nodes) {
    if (node.status === undefined || node.status === "unknown") continue;
    if (node.evidence === undefined || node.verified_at === undefined) {
      throw new Error(
        `Capability declaration at ${path} must include evidence and verified_at`,
        { cause: { modelPath, capability: path } },
      );
    }
  }

  const authoredFeatures = caps.features;
  if (
    authoredFeatures === null ||
    typeof authoredFeatures !== "object" ||
    Array.isArray(authoredFeatures)
  ) {
    return;
  }
  for (const [feature, field] of FEATURE_BOOLEAN_FIELDS) {
    const node = (authoredFeatures as Record<string, CapabilityNode>)[feature];
    const value = toml[field];
    if (
      node?.status === undefined ||
      node.status === "unknown" ||
      typeof value !== "boolean"
    ) {
      continue;
    }
    if (value !== (node.status === "supported")) {
      throw new Error(
        `${field} = ${value} contradicts capabilities.features.${feature}.${node.status}`,
        { cause: { modelPath, capability: feature } },
      );
    }
  }
}

export function normalizeCapabilities<T extends Record<string, unknown>>(
  model: T,
): T {
  const capabilities = model.capabilities;
  if (
    capabilities === null ||
    typeof capabilities !== "object" ||
    Array.isArray(capabilities)
  ) {
    return model;
  }

  const clear = (group: unknown, keys: readonly string[]) => {
    if (group === null || typeof group !== "object" || Array.isArray(group)) {
      return;
    }
    for (const key of keys) {
      const node = (group as Record<string, CapabilityNode>)[key];
      if (node?.status === "unknown") {
        delete node.evidence;
        delete node.verified_at;
      }
    }
  };

  const caps = capabilities as Record<string, unknown>;
  clear(caps.tasks, CapabilityTaskValues);
  clear(caps.inputs, CapabilityInputValues);
  clear(caps.features, CapabilityFeatureValues);

  const endpoints = caps.endpoints;
  if (
    endpoints !== null &&
    typeof endpoints === "object" &&
    !Array.isArray(endpoints)
  ) {
    const groups = endpoints as Record<string, unknown>;
    clear(groups.transports, TransportValues);
    clear(groups.operations, OperationValues);
  }

  return model;
}

function resolveCanonical(
  providerID: string,
  modelID: string,
  model: { base_model?: string; canonical?: string },
  models: Record<string, ModelMetadata>,
  modelPath: string,
): string | undefined {
  if (model.base_model !== undefined) {
    if (model.canonical !== undefined && model.canonical !== model.base_model) {
      throw new Error(
        `canonical "${model.canonical}" must match base_model "${model.base_model}"`,
        { cause: { modelPath, providerID, modelID } },
      );
    }
    return model.base_model;
  }

  if (model.canonical !== undefined) {
    if (models[model.canonical] === undefined) {
      throw new Error(`Unable to resolve canonical model: ${model.canonical}`, {
        cause: { modelPath, providerID, modelID },
      });
    }
    return model.canonical;
  }

  const sameID = `${providerID}/${modelID}`;
  return models[sameID] === undefined ? undefined : sameID;
}

function finalizeProviderModel(
  model: z.infer<typeof AuthoredModel>,
  providerID: string,
  modelID: string,
  authored: Record<string, unknown>,
  models: Record<string, ModelMetadata>,
  modelPath: string,
): Model {
  const canonical = resolveCanonical(
    providerID,
    modelID,
    {
      base_model:
        typeof authored.base_model === "string" ? authored.base_model : undefined,
      canonical: model.canonical,
    },
    models,
    modelPath,
  );

  const withCapabilities = applyCanonicalCapabilities(
    model as unknown as Record<string, unknown>,
    canonical,
    models,
    authored,
    authored.base_model === undefined,
  ) as z.infer<typeof AuthoredModel>;

  if (canonical === undefined) {
    delete withCapabilities.canonical;
  } else {
    withCapabilities.canonical = canonical;
  }

  const finalized = normalizeModelCost(withCapabilities);
  const parsed = Model.safeParse(finalized);
  if (!parsed.success) {
    parsed.error.cause = { modelPath, providerID, modelID };
    throw parsed.error;
  }
  return parsed.data;
}

export function buildAliases(
  models: Record<string, ModelMetadata>,
  providers: Record<string, Provider>,
) {
  const aliases: Record<string, string> = {};
  const providerModelKeys = new Set<string>();
  for (const [providerID, provider] of Object.entries(providers)) {
    for (const modelID of Object.keys(provider.models)) {
      providerModelKeys.add(`${providerID}/${modelID}`);
    }
  }

  const add = (alias: string, target: string, source: string) => {
    if (alias === target) {
      throw new Error(`Alias "${alias}" cannot point at itself`, {
        cause: { source },
      });
    }
    if (models[alias] !== undefined || providerModelKeys.has(alias)) {
      throw new Error(`Alias "${alias}" collides with an existing model id`, {
        cause: { source },
      });
    }
    const existing = aliases[alias];
    if (existing !== undefined) {
      throw new Error(
        `Duplicate alias "${alias}" used by "${existing}" and "${target}"`,
        { cause: { source } },
      );
    }
    aliases[alias] = target;
  };

  for (const [modelID, model] of Object.entries(models)) {
    for (const alias of model.aliases ?? []) {
      add(alias, modelID, modelID);
    }
  }
  for (const [providerID, provider] of Object.entries(providers)) {
    for (const [modelID, model] of Object.entries(provider.models)) {
      for (const alias of model.aliases ?? []) {
        add(
          `${providerID}/${alias}`,
          `${providerID}/${modelID}`,
          `${providerID}/${modelID}`,
        );
      }
    }
  }

  return Object.fromEntries(
    Object.entries(aliases).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

function applyOmit(target: Record<string, unknown>, paths: string[]) {
  omitLoop: for (const omit of paths) {
    const parts = omit.split(".");
    const parents: Array<{
      value: Record<string, unknown>;
      key: string;
    }> = [];
    let current = target;

    for (const part of parts.slice(0, -1)) {
      const next = current[part];
      if (
        next === undefined ||
        next === null ||
        typeof next !== "object" ||
        Array.isArray(next)
      ) {
        continue omitLoop;
      }
      parents.push({ value: current, key: part });
      current = next as Record<string, unknown>;
    }

    const lastPart = parts.at(-1);
    if (lastPart === undefined || !(lastPart in current)) {
      continue;
    }

    delete current[lastPart];

    for (let index = parents.length - 1; index >= 0; index--) {
      const parent = parents[index];
      if (parent === undefined) continue;
      const value = parent.value[parent.key];
      if (
        value === null ||
        value === undefined ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length > 0
      ) {
        break;
      }
      delete parent.value[parent.key];
    }
  }
}

function normalizeModelCost(model: z.infer<typeof AuthoredModel>): Model {
  return normalizeCost(model) as Model;
}

function normalizeCost(model: Record<string, unknown>) {
  const cost = model.cost;
  if (cost === undefined || cost === null || typeof cost !== "object" || Array.isArray(cost)) {
    return model;
  }

  const tiers = (cost as { tiers?: unknown }).tiers;
  if (!Array.isArray(tiers)) {
    return model;
  }

  if (tiers.length !== 1) {
    return model;
  }

  const contextOver200k = tiers.find((tier) => {
    if (tier === null || typeof tier !== "object" || Array.isArray(tier)) return false;
    const tierConfig = (tier as { tier?: unknown }).tier;
    if (tierConfig === null || typeof tierConfig !== "object" || Array.isArray(tierConfig)) return false;
    const type = (tierConfig as { type?: unknown }).type;
    const size = (tierConfig as { size?: unknown }).size;
    // context_over_200k is a legacy compatibility field. It intentionally
    // includes higher thresholds; cost.tiers carries the exact threshold.
    return (
      (type === undefined || type === "context") &&
      typeof size === "number" &&
      size >= 200_000
    );
  });

  if (contextOver200k === undefined) {
    return model;
  }

  const { tier: _tier, ...legacyCost } = contextOver200k as Record<string, unknown>;
  return {
    ...model,
    cost: {
      ...(cost as Record<string, unknown>),
      context_over_200k: legacyCost,
    },
  };
}
