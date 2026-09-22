import {
  CapabilityFeatureValues,
  CapabilityInputValues,
  CapabilityTaskValues,
  OperationValues,
  TransportValues,
} from "./capabilities.js";
import type {
  CapabilityFeatureValue,
  CapabilityInputValue,
  CapabilityTaskValue,
  OperationValue,
  TransportValue,
} from "./capabilities.js";

export const MODEL_TYPES = ["decision"] as const;

export type ModelTypeValue = (typeof MODEL_TYPES)[number];
export type ModelTypeFilter = "default" | "all" | ModelTypeValue[];

interface TypedModel {
  type?: ModelTypeValue;
}

interface TypedProvider {
  models: Record<string, TypedModel>;
}

/**
 * Capability filter axes. Values within one axis are OR-ed; axes are AND-ed.
 * Only resolved `supported` capabilities match: `unknown` (absent) and
 * `unsupported` never satisfy a filter.
 */
export interface CapabilityFilter {
  tasks?: CapabilityTaskValue[];
  features?: CapabilityFeatureValue[];
  inputs?: CapabilityInputValue[];
  operations?: OperationValue[];
  transports?: TransportValue[];
}

export const CAPABILITY_FILTER_PARAMS: Record<
  keyof CapabilityFilter,
  { param: string; allowed: readonly string[] }
> = {
  tasks: { param: "task", allowed: CapabilityTaskValues },
  features: { param: "feature", allowed: CapabilityFeatureValues },
  inputs: { param: "input", allowed: CapabilityInputValues },
  operations: { param: "operation", allowed: OperationValues },
  transports: { param: "transport", allowed: TransportValues },
};

export class InvalidCapabilityFilterError extends Error {
  readonly param: string;
  readonly value: string;
  readonly allowed: readonly string[];

  constructor(param: string, value: string, allowed: readonly string[]) {
    super(`Invalid ${param} value: ${value}`);
    this.name = "InvalidCapabilityFilterError";
    this.param = param;
    this.value = value;
    this.allowed = allowed;
  }
}

export function parseCapabilityFilter(
  params: URLSearchParams,
): CapabilityFilter {
  const filter: CapabilityFilter = {};

  for (const [axis, config] of Object.entries(CAPABILITY_FILTER_PARAMS) as Array<
    [keyof CapabilityFilter, (typeof CAPABILITY_FILTER_PARAMS)[keyof CapabilityFilter]]
  >) {
    const raw = params.get(config.param);
    if (raw === null || raw.trim() === "") continue;

    const values = [...new Set(raw.split(",").map((value) => value.trim()))].filter(
      (value) => value.length > 0,
    );
    if (values.length === 0) continue;

    for (const value of values) {
      if (!config.allowed.includes(value)) {
        throw new InvalidCapabilityFilterError(config.param, value, config.allowed);
      }
    }

    filter[axis] = values as never;
  }

  return filter;
}

export function hasCapabilityFilter(filter: CapabilityFilter) {
  return Object.values(filter).some(
    (values) => values !== undefined && values.length > 0,
  );
}

interface CapabilityNode {
  status?: string;
}

interface CapableModel {
  capabilities?: {
    tasks?: Record<string, CapabilityNode | undefined>;
    inputs?: Record<string, CapabilityNode | undefined>;
    features?: Record<string, CapabilityNode | undefined>;
    endpoints?: {
      transports?: Record<string, CapabilityNode | undefined>;
      operations?: Record<string, CapabilityNode | undefined>;
    };
  };
}

function anySupported(
  group: Record<string, CapabilityNode | undefined> | undefined,
  keys: readonly string[],
) {
  return keys.some((key) => group?.[key]?.status === "supported");
}

export function matchesCapabilityFilter(
  model: CapableModel,
  filter: CapabilityFilter,
) {
  const capabilities = model.capabilities;
  if (
    filter.tasks !== undefined &&
    !anySupported(capabilities?.tasks, filter.tasks)
  ) {
    return false;
  }
  if (
    filter.features !== undefined &&
    !anySupported(capabilities?.features, filter.features)
  ) {
    return false;
  }
  if (
    filter.inputs !== undefined &&
    !anySupported(capabilities?.inputs, filter.inputs)
  ) {
    return false;
  }
  if (
    filter.operations !== undefined &&
    !anySupported(capabilities?.endpoints?.operations, filter.operations)
  ) {
    return false;
  }
  if (
    filter.transports !== undefined &&
    !anySupported(capabilities?.endpoints?.transports, filter.transports)
  ) {
    return false;
  }
  return true;
}

export class InvalidModelTypeError extends Error {
  constructor(value: string) {
    super(`Invalid type value: ${value}`);
    this.name = "InvalidModelTypeError";
  }
}

export function parseModelTypes(value: string | null): ModelTypeFilter {
  if (value === null || value === "") return "default";
  if (value === "all") return "all";

  const types = value.split(",");
  if (
    types.length === 0 ||
    types.includes("all") ||
    types.some((type) => !MODEL_TYPES.includes(type as ModelTypeValue))
  ) {
    throw new InvalidModelTypeError(value);
  }

  return [...new Set(types)] as ModelTypeValue[];
}

function includesModel(model: TypedModel, filter: ModelTypeFilter) {
  if (filter === "all") return true;
  if (filter === "default") return model.type === undefined;
  return model.type !== undefined && filter.includes(model.type);
}

export function filterProvidersByModelType<
  T extends Record<string, TypedProvider>,
>(providers: T, filter: ModelTypeFilter): T {
  if (filter === "all") return providers;

  return Object.fromEntries(
    Object.entries(providers).flatMap(([providerID, provider]) => {
      const models = Object.fromEntries(
        Object.entries(provider.models).filter(([, model]) =>
          includesModel(model, filter),
        ),
      );
      return Object.keys(models).length === 0
        ? []
        : [[providerID, { ...provider, models }]];
    }),
  ) as T;
}

export function filterModelsByModelType<T extends Record<string, TypedModel>>(
  models: T,
  filter: ModelTypeFilter,
): T {
  if (filter === "all") return models;
  return Object.fromEntries(
    Object.entries(models).filter(([, model]) => includesModel(model, filter)),
  ) as T;
}

function pruneAliases<
  TProviders extends Record<string, TypedProvider>,
  TModels extends Record<string, unknown>,
>(
  aliases: Record<string, string> | undefined,
  providers: TProviders,
  models: TModels,
): Record<string, string> | undefined {
  if (aliases === undefined) return undefined;

  const filteredProviderModels = new Set<string>();
  for (const [providerID, provider] of Object.entries(providers)) {
    for (const modelID of Object.keys(provider.models)) {
      filteredProviderModels.add(`${providerID}/${modelID}`);
    }
  }

  return Object.fromEntries(
    Object.entries(aliases).filter(
      ([, target]) => target in models || filteredProviderModels.has(target),
    ),
  );
}

export function filterCatalogByModelType<
  TProviders extends Record<string, TypedProvider>,
  TModels extends Record<string, TypedModel>,
  TCatalog extends {
    providers: TProviders;
    models: TModels;
    aliases?: Record<string, string>;
  },
>(catalog: TCatalog, filter: ModelTypeFilter): TCatalog {
  const providers = filterProvidersByModelType(catalog.providers, filter);
  const models = filterModelsByModelType(catalog.models, filter);
  const aliases =
    filter === "all"
      ? catalog.aliases
      : pruneAliases(catalog.aliases, providers, models);

  return {
    ...catalog,
    providers,
    models,
    ...(aliases === undefined ? {} : { aliases }),
  };
}

export function filterProvidersByCapabilities<
  T extends Record<string, TypedProvider & { models: Record<string, CapableModel> }>,
>(providers: T, filter: CapabilityFilter): T {
  if (!hasCapabilityFilter(filter)) return providers;

  return Object.fromEntries(
    Object.entries(providers).flatMap(([providerID, provider]) => {
      const models = Object.fromEntries(
        Object.entries(provider.models).filter(([, model]) =>
          matchesCapabilityFilter(model, filter),
        ),
      );
      return Object.keys(models).length === 0
        ? []
        : [[providerID, { ...provider, models }]];
    }),
  ) as T;
}

export function filterModelsByCapabilities<
  T extends Record<string, CapableModel>,
>(models: T, filter: CapabilityFilter): T {
  if (!hasCapabilityFilter(filter)) return models;

  return Object.fromEntries(
    Object.entries(models).filter(([, model]) =>
      matchesCapabilityFilter(model, filter),
    ),
  ) as T;
}

export function filterCatalogByCapabilities<
  TProviders extends Record<string, TypedProvider & { models: Record<string, CapableModel> }>,
  TModels extends Record<string, CapableModel>,
  TCatalog extends {
    providers: TProviders;
    models: TModels;
    aliases?: Record<string, string>;
  },
>(catalog: TCatalog, filter: CapabilityFilter): TCatalog {
  if (!hasCapabilityFilter(filter)) return catalog;

  const providers = filterProvidersByCapabilities(catalog.providers, filter);
  const models = filterModelsByCapabilities(catalog.models, filter);
  const aliases = pruneAliases(catalog.aliases, providers, models);

  return {
    ...catalog,
    providers,
    models,
    ...(aliases === undefined ? {} : { aliases }),
  };
}
