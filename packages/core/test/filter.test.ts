import { describe, expect, test } from "bun:test";

import {
  filterCatalogByCapabilities,
  filterCatalogByModelType,
  filterModelsByCapabilities,
  filterProvidersByCapabilities,
  generateCatalog,
  hasCapabilityFilter,
  InvalidCapabilityFilterError,
  InvalidModelTypeError,
  matchesCapabilityFilter,
  parseCapabilityFilter,
  parseModelTypes,
} from "../src/index.js";
import type { ModelMetadata, Provider } from "../src/index.js";
import path from "node:path";

describe("model type filtering", () => {
  test("defaults to untyped models and supports specific types and all", () => {
    expect(parseModelTypes(null)).toBe("default");
    expect(parseModelTypes("")).toBe("default");
    expect(parseModelTypes("decision")).toEqual(["decision"]);
    expect(parseModelTypes("all")).toBe("all");
  });

  test("rejects unknown types and combining all with a type", () => {
    expect(() => parseModelTypes("unknown")).toThrow(InvalidModelTypeError);
    expect(() => parseModelTypes("all,decision")).toThrow(
      InvalidModelTypeError,
    );
  });

  test("omits typed models by default", () => {
    const catalog = fixture();
    const filtered = filterCatalogByModelType(catalog, "default");

    expect(Object.keys(filtered.models)).toEqual(["standard"]);
    expect(Object.keys(filtered.providers.example!.models)).toEqual([
      "standard",
    ]);
    expect(filtered.providers.decisionOnly).toBeUndefined();
  });

  test("filters canonical and provider models by requested type", () => {
    const catalog = fixture();
    const filtered = filterCatalogByModelType(catalog, ["decision"]);

    expect(Object.keys(filtered.models)).toEqual(["decision"]);
    expect(Object.keys(filtered.providers.example!.models)).toEqual([
      "decision",
    ]);
    expect(Object.keys(filtered.providers.decisionOnly!.models)).toEqual([
      "decision",
    ]);
    expect(filterCatalogByModelType(catalog, "all")).toEqual(catalog);
  });

  test("preserves catalog contract keys and prunes filtered aliases", () => {
    const catalog = {
      ...fixture(),
      schema_version: 1,
      generated_at: "2026-01-01T00:00:00.000Z",
      aliases: {
        "standard-alias": "standard",
        "decision-alias": "decision",
        "example/standard": "example/standard",
      },
    };

    const filtered = filterCatalogByModelType(catalog, "default");

    expect(filtered.schema_version).toBe(1);
    expect(filtered.generated_at).toBe("2026-01-01T00:00:00.000Z");
    const expectedAliases: Record<string, string> = {
      "standard-alias": "standard",
      "example/standard": "example/standard",
    };
    expect(filtered.aliases as Record<string, string>).toEqual(expectedAliases);
  });

  test("every repository Jev model inherits decision and is omitted by default", async () => {
    const root = path.join(import.meta.dir, "..", "..", "..");
    const catalog = await generateCatalog(root);
    const jevModels = Object.values(catalog.providers).flatMap((provider) =>
      Object.values(provider.models).filter((model) =>
        model.id.toLowerCase().includes("jev"),
      ),
    );

    expect(jevModels.length).toBeGreaterThan(0);
    expect(jevModels.every((model) => model.type === "decision")).toBe(true);

    const defaults = filterCatalogByModelType(catalog, "default");
    expect(
      Object.values(defaults.providers).some((provider) =>
        Object.values(provider.models).some((model) => model.type !== undefined),
      ),
    ).toBe(false);
    expect(defaults.models["typesafe/jev-latest"]).toBeUndefined();
    expect(defaults.providers.vivgrid?.models.jev).toBeUndefined();

    const decisions = filterCatalogByModelType(catalog, ["decision"]);
    expect(decisions.models["typesafe/jev-latest"]?.type).toBe("decision");
    expect(
      Object.values(decisions.providers).flatMap((provider) =>
        Object.values(provider.models),
      ).length,
    ).toBe(jevModels.length);
  });
});

describe("capability filtering", () => {
  const embedding = {
    capabilities: { tasks: { embeddings: { status: "supported" } } },
  };
  const reranker = {
    capabilities: {
      tasks: { reranking: { status: "supported" } },
      inputs: { text: { status: "supported" } },
    },
  };
  const chatVision = {
    capabilities: {
      tasks: { text_generation: { status: "supported" } },
      features: { tool_calling: { status: "supported" } },
      inputs: { image: { status: "supported" } },
      endpoints: {
        transports: { sse: { status: "supported" } },
        operations: { chat: { status: "supported" } },
      },
    },
  };
  const downgraded = {
    capabilities: {
      tasks: { text_generation: { status: "unknown" } },
      features: { tool_calling: { status: "unsupported" } },
    },
  };
  const models = { embedding, reranker, chatVision, downgraded };

  test("parses comma-separated values and rejects unknown slugs", () => {
    const filter = parseCapabilityFilter(
      new URLSearchParams("task=embeddings,reranking&feature=tool_calling"),
    );

    expect(filter.tasks).toEqual(["embeddings", "reranking"]);
    expect(filter.features).toEqual(["tool_calling"]);
    expect(hasCapabilityFilter(filter)).toBe(true);
    expect(hasCapabilityFilter(parseCapabilityFilter(new URLSearchParams()))).toBe(
      false,
    );

    expect(() =>
      parseCapabilityFilter(new URLSearchParams("task=bogus")),
    ).toThrow(InvalidCapabilityFilterError);
  });

  test("ORs values within one axis and ANDs across axes", () => {
    const either = filterModelsByCapabilities(models, {
      tasks: ["embeddings", "reranking"],
    });
    expect(Object.keys(either)).toEqual(["embedding", "reranker"]);

    const both = filterModelsByCapabilities(models, {
      tasks: ["text_generation"],
      features: ["tool_calling"],
    });
    expect(Object.keys(both)).toEqual(["chatVision"]);
  });

  test("only supported capabilities match", () => {
    expect(
      matchesCapabilityFilter(downgraded, { tasks: ["text_generation"] }),
    ).toBe(false);
    expect(
      matchesCapabilityFilter(downgraded, { features: ["tool_calling"] }),
    ).toBe(false);
    expect(
      matchesCapabilityFilter(chatVision, { transports: ["sse"] }),
    ).toBe(true);
    expect(
      matchesCapabilityFilter(chatVision, { transports: ["websocket"] }),
    ).toBe(false);
    expect(
      matchesCapabilityFilter(chatVision, { operations: ["chat"] }),
    ).toBe(true);
  });

  test("filters providers and drops providers with no surviving models", () => {
    const providers = {
      mixed: { models: { embedding, chatVision } },
      embeddingsOnly: { models: { embedding } },
    };
    const filtered = filterProvidersByCapabilities(providers, {
      tasks: ["text_generation"],
    });

    expect(Object.keys(filtered)).toEqual(["mixed"]);
    expect(Object.keys(filtered.mixed!.models)).toEqual(["chatVision"]);
  });

  test("preserves catalog keys and prunes aliases for filtered targets", () => {
    const catalog = {
      schema_version: 1,
      generated_at: "2026-01-01T00:00:00.000Z",
      models,
      providers: {
        example: { models: { embedding, chatVision } },
      },
      aliases: {
        "alias/embedding": "embedding",
        "example/chat": "example/chatVision",
      },
    };

    const filtered = filterCatalogByCapabilities(catalog, {
      tasks: ["text_generation"],
    });

    expect(filtered.schema_version).toBe(1);
    expect(Object.keys(filtered.models)).toEqual(["chatVision"]);
    expect(filtered.aliases as Record<string, string>).toEqual({
      "example/chat": "example/chatVision",
    });
  });

  test("returns the input unchanged for an empty filter", () => {
    expect(filterModelsByCapabilities(models, {})).toBe(models);
    expect(filterProvidersByCapabilities({ example: { models } }, {})).toEqual({
      example: { models },
    });
  });
});

function fixture() {
  const standard = model("standard-model");
  const decision = model("decision-model", "decision");
  return {
    models: { standard, decision },
    providers: {
      example: {
        id: "example",
        models: { standard, decision },
      } as unknown as Provider,
      decisionOnly: {
        id: "decision-only",
        models: { decision },
      } as unknown as Provider,
    },
  };
}

function model(id: string, type?: "decision") {
  return { id, type } as unknown as ModelMetadata;
}
