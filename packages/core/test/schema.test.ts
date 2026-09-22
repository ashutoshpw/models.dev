import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { AuthoredModel, ModelMetadata, Provider } from "../src/index.js";

type AuthoredModelData = z.infer<typeof AuthoredModel>;

const dateFields = ["knowledge", "release_date", "last_updated"] as const;

describe("model schema", () => {
  test("rejects unknown nested model configuration fields", () => {
    const result = AuthoredModel.safeParse({
      ...baseModel({}),
      cost: {
        input: 1,
        output: 2,
        cache_reed: 0.1,
      },
      provider: {
        npm: "example-sdk",
        typo: true,
      },
      experimental: {
        typo: true,
        modes: {
          fast: {
            typo: true,
            provider: {
              typo: true,
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(
      expect.arrayContaining([
        "cost",
        "provider",
        "experimental",
        "experimental.modes.fast",
        "experimental.modes.fast.provider",
      ]),
    );
  });

  test("requires reasoning_options when reasoning is true", () => {
    const model = baseModel({ reasoning: true });

    expect(AuthoredModel.safeParse(model).success).toBe(false);
  });

  test("accepts empty reasoning_options when reasoning is true", () => {
    const model = baseModel({
      reasoning: true,
      reasoning_options: [],
    });

    expect(AuthoredModel.safeParse(model).success).toBe(true);
  });

  test("rejects reasoning_options when reasoning is false", () => {
    const model = baseModel({
      reasoning: false,
      reasoning_options: [],
    });

    expect(AuthoredModel.safeParse(model).success).toBe(false);
  });

  test("accepts decision model types", () => {
    const model = baseModel({ type: "decision" });

    expect(AuthoredModel.safeParse(model).success).toBe(true);
  });

  test("accepts calendar-valid model dates", () => {
    for (const field of dateFields) {
      for (const value of [
        "2026-02",
        "2024-02-29",
        "2000-02-29",
        "2026-12-31",
      ]) {
        expect(
          AuthoredModel.safeParse({
            ...baseModel({}),
            [field]: value,
          }).success,
        ).toBe(true);
      }
    }
  });

  test("rejects impossible model dates", () => {
    for (const field of dateFields) {
      for (const value of [
        "2026-00",
        "2026-13",
        "2025-02-29",
        "1900-02-29",
        "2026-02-30",
        "2026-04-31",
      ]) {
        expect(
          AuthoredModel.safeParse({
            ...baseModel({}),
            [field]: value,
          }).success,
        ).toBe(false);
      }
    }
  });
});

describe("capability schema", () => {
  const declaration = {
    status: "supported",
    evidence: ["https://example.com/docs"],
    verified_at: "2026-01-01",
  };

  function metadata(capabilities: unknown, overrides: Record<string, unknown> = {}) {
    return {
      id: "lab/model",
      name: "Example Model",
      description: "Example model for capability schema validation tests",
      modalities: { input: ["text"], output: ["text"] },
      ...overrides,
      capabilities,
    };
  }

  test("accepts evidence-backed declarations and sparse capability maps", () => {
    const result = ModelMetadata.safeParse(
      metadata({
        tasks: { text_generation: declaration, embeddings: declaration },
        inputs: { text: declaration },
        features: { tool_calling: declaration },
      }),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Object.keys(result.data.capabilities?.tasks ?? {})).toEqual([
      "text_generation",
      "embeddings",
    ]);
  });

  test("supports negative declarations and multiple tasks", () => {
    const result = ModelMetadata.safeParse(
      metadata({
        tasks: {
          text_generation: {
            status: "unsupported",
            evidence: ["https://example.com/docs/limits"],
            verified_at: "2026-01-01",
          },
          embeddings: declaration,
          reranking: declaration,
        },
      }),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(
      result.data.capabilities?.tasks?.text_generation?.status,
    ).toBe("unsupported");
    expect(Object.keys(result.data.capabilities?.tasks ?? {}).sort()).toEqual([
      "embeddings",
      "reranking",
      "text_generation",
    ]);
  });

  test("negative declarations without evidence are rejected", () => {
    const result = ModelMetadata.safeParse(
      metadata({
        tasks: { text_generation: { status: "unsupported" } },
      }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "supported/unsupported require evidence and verified_at; unknown forbids them",
    );
  });

  test("requires evidence and verified_at for confirmed declarations", () => {
    const result = ModelMetadata.safeParse(
      metadata({
        tasks: {
          embeddings: { status: "supported", evidence: ["https://example.com"] },
        },
      }),
    );

    expect(result.success).toBe(false);
  });

  test("forbids evidence on unknown declarations", () => {
    const result = ModelMetadata.safeParse(
      metadata({
        tasks: {
          embeddings: { status: "unknown", evidence: ["https://example.com"] },
        },
      }),
    );

    expect(result.success).toBe(false);
  });

  test("requires strict YYYY-MM-DD verification dates", () => {
    const result = ModelMetadata.safeParse(
      metadata({
        tasks: { embeddings: { ...declaration, verified_at: "2026-01" } },
      }),
    );

    expect(result.success).toBe(false);
  });

  test("rejects unknown capability keys and axes", () => {
    const unknownKey = ModelMetadata.safeParse(
      metadata({ tasks: { text_generation_v2: declaration } }),
    );
    const unknownAxis = ModelMetadata.safeParse(
      metadata({ transports: {} }),
    );

    expect(unknownKey.success).toBe(false);
    expect(unknownAxis.success).toBe(false);
  });

  test("rejects provider endpoints on canonical metadata", () => {
    const result = ModelMetadata.safeParse(
      metadata({
        endpoints: {
          transports: { sse: declaration },
        },
      }),
    );

    expect(result.success).toBe(false);
  });

  test("formats are media types and require supported status", () => {
    const valid = ModelMetadata.safeParse(
      metadata({
        inputs: {
          files: { ...declaration, formats: ["application/pdf", "text/csv"] },
        },
      }),
    );
    const notSupported = ModelMetadata.safeParse(
      metadata({
        inputs: {
          files: { ...declaration, status: "unsupported", formats: ["application/pdf"] },
        },
      }),
    );
    const invalidFormat = ModelMetadata.safeParse(
      metadata({
        inputs: { files: { ...declaration, formats: ["pdf"] } },
      }),
    );
    const formatsOnNonFiles = ModelMetadata.safeParse(
      metadata({
        inputs: { text: { ...declaration, formats: ["text/plain"] } },
      }),
    );

    expect(valid.success).toBe(true);
    expect(notSupported.success).toBe(false);
    expect(invalidFormat.success).toBe(false);
    expect(formatsOnNonFiles.success).toBe(false);
    if (formatsOnNonFiles.success) return;
    expect(
      formatsOnNonFiles.error.issues.map((issue) => issue.path.join(".")),
    ).toContain("capabilities.inputs.text.formats");
  });

  test("capability declarations cannot contradict legacy booleans", () => {
    const result = ModelMetadata.safeParse(
      metadata(
        {
          features: {
            tool_calling: {
              status: "unsupported",
              evidence: ["https://example.com/docs"],
              verified_at: "2026-01-01",
            },
          },
        },
        { tool_call: true },
      ),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(
      "capabilities.features.tool_calling",
    );
  });

  test("unsupported inputs cannot contradict modalities", () => {
    const result = ModelMetadata.safeParse(
      metadata(
        {
          inputs: {
            image: {
              status: "unsupported",
              evidence: ["https://example.com/docs"],
              verified_at: "2026-01-01",
            },
          },
        },
        { modalities: { input: ["text", "image"], output: ["text"] } },
      ),
    );

    expect(result.success).toBe(false);
  });

  test("aliases cannot reference the model itself", () => {
    const result = ModelMetadata.safeParse(
      metadata(undefined, { aliases: ["lab/model"] }),
    );

    expect(result.success).toBe(false);
  });

  test("provider operations cannot be supported when their task is unsupported", () => {
    const result = AuthoredModel.safeParse({
      ...baseModel({}),
      capabilities: {
        tasks: {
          embeddings: {
            status: "unsupported",
            evidence: ["https://example.com/docs"],
            verified_at: "2026-01-01",
          },
        },
        endpoints: {
          operations: {
            embeddings: {
              status: "supported",
              evidence: ["https://example.com/docs"],
              verified_at: "2026-01-01",
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(
      "capabilities.endpoints.operations.embeddings",
    );
  });

  test("provider endpoints accept transports and operations", () => {
    const result = AuthoredModel.safeParse({
      ...baseModel({}),
      capabilities: {
        endpoints: {
          transports: {
            http: {
              status: "supported",
              evidence: ["https://example.com/docs"],
              verified_at: "2026-01-01",
            },
            websocket: {
              status: "unsupported",
              evidence: ["https://example.com/docs/ws"],
              verified_at: "2026-01-01",
            },
          },
          operations: {
            chat: {
              status: "supported",
              evidence: ["https://example.com/docs"],
              verified_at: "2026-01-01",
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });
});

describe("provider schema", () => {
  const mergeGatewayProvider = {
    id: "merge-gateway",
    name: "Merge Gateway",
    env: ["MERGE_GATEWAY_API_KEY"],
    npm: "merge-gateway-ai-sdk-provider",
    api: "https://api-gateway.merge.dev/v1/ai-sdk",
    doc: "https://docs.merge.dev/merge-gateway",
    models: {},
  };

  test("accepts Merge Gateway's native package with its OpenAI-compatible API", () => {
    expect(Provider.safeParse(mergeGatewayProvider).success).toBe(true);
  });

  test("requires the compatibility API for the Merge Gateway package", () => {
    const { api: _api, ...providerWithoutApi } = mergeGatewayProvider;

    expect(Provider.safeParse(providerWithoutApi).success).toBe(false);
  });
});

function baseModel(overrides: Partial<AuthoredModelData>) {
  return {
    id: "example/model",
    name: "Example Model",
    description: "Example model for schema validation and regression tests",
    attachment: false,
    reasoning: false,
    tool_call: true,
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    modalities: {
      input: ["text"],
      output: ["text"],
    },
    open_weights: false,
    limit: {
      context: 1_000,
      output: 100,
    },
    cost: {
      input: 1,
      output: 2,
    },
    ...overrides,
  };
}
