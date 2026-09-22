export const MODEL_TYPES = ["decision"] as const;

export type ModelTypeValue = (typeof MODEL_TYPES)[number];
export type ModelTypeFilter = "default" | "all" | ModelTypeValue[];

interface TypedModel {
  type?: ModelTypeValue;
}

interface TypedProvider {
  models: Record<string, TypedModel>;
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

  let aliases = catalog.aliases;
  if (aliases !== undefined && filter !== "all") {
    const filteredProviderModels = new Set<string>();
    for (const [providerID, provider] of Object.entries(providers)) {
      for (const modelID of Object.keys(provider.models)) {
        filteredProviderModels.add(`${providerID}/${modelID}`);
      }
    }
    aliases = Object.fromEntries(
      Object.entries(aliases).filter(
        ([, target]) =>
          target in models || filteredProviderModels.has(target),
      ),
    );
  }

  return {
    ...catalog,
    providers,
    models,
    ...(aliases === undefined ? {} : { aliases }),
  };
}
