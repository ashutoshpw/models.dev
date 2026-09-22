import { describe, expect, test } from "bun:test";

import worker, { type Env } from "../src/worker.js";

const textModel = {
  id: "text-model",
  modalities: { input: ["text"], output: ["text"] },
};
const decisionModel = {
  id: "decision-model",
  type: "decision",
  modalities: { input: ["text"], output: ["text"] },
};
const providers = {
  example: {
    id: "example",
    models: { text: textModel, decision: decisionModel },
  },
};
const models = { text: textModel, decision: decisionModel };
const catalogMeta = {
  schema_version: 1,
  generated_at: "2026-01-01T00:00:00.000Z",
  aliases: { "text-alias": "text" },
};

const embeddingModel = {
  id: "embedding",
  capabilities: {
    tasks: { embeddings: { status: "supported" } },
  },
};
const chatModel = {
  id: "chat",
  capabilities: {
    tasks: { text_generation: { status: "supported" } },
    features: { tool_calling: { status: "supported" } },
    endpoints: {
      transports: { websocket: { status: "supported" } },
      operations: { chat: { status: "supported" } },
    },
  },
};
const legacyModel = { id: "legacy" };
const capabilityModels = {
  embedding: embeddingModel,
  chat: chatModel,
  legacy: legacyModel,
};
const capabilityProviders = {
  example: { id: "example", models: capabilityModels },
};
const capabilityCatalog = {
  schema_version: 1,
  generated_at: "2026-01-01T00:00:00.000Z",
  aliases: { "chat-alias": "chat", "legacy-alias": "legacy" },
  models: capabilityModels,
  providers: capabilityProviders,
};

describe("catalog API model type filtering", () => {
  test("omits typed models from api.json by default", async () => {
    const response = await request("/api.json");
    const body = await response.json();

    expect(Object.keys(body.example.models)).toEqual(["text"]);
  });

  test("omits typed models from models.json by default", async () => {
    const response = await request("/models.json");
    const body = await response.json();

    expect(Object.keys(body)).toEqual(["text"]);
  });

  test("omits typed models from catalog.json by default", async () => {
    const response = await request("/catalog.json");
    const body = await response.json();

    expect(Object.keys(body.models)).toEqual(["text"]);
    expect(Object.keys(body.providers.example.models)).toEqual(["text"]);
  });

  test("preserves catalog contract keys and prunes aliases when filtering", async () => {
    const response = await request("/catalog.json");
    const body = await response.json();

    expect(body.schema_version).toBe(1);
    expect(body.generated_at).toBe("2026-01-01T00:00:00.000Z");
    expect(body.aliases).toEqual({ "text-alias": "text" });
  });

  test("returns explicitly requested decision models", async () => {
    const response = await request("/catalog.json?type=decision");
    const body = await response.json();

    expect(Object.keys(body.models)).toEqual(["decision"]);
    expect(Object.keys(body.providers.example.models)).toEqual(["decision"]);
  });

  test("returns the complete static catalog for all", async () => {
    const response = await request("/models.json?type=all");
    const body = await response.json();

    expect(Object.keys(body)).toEqual(["text", "decision"]);
  });

  test("omits typed models from model-schema.json by default", async () => {
    const response = await request("/model-schema.json");
    const body = await response.json();

    expect(body.$defs.Model.enum).toEqual(["example/text"]);
  });

  test("includes typed models in model-schema.json when requested", async () => {
    const response = await request("/model-schema.json?type=all");
    const body = await response.json();

    expect(body.$defs.Model.enum).toEqual([
      "example/decision",
      "example/text",
    ]);
  });

  test("rejects unknown model types", async () => {
    const response = await request("/api.json?type=unknown");

    expect(response.status).toBe(400);
  });
});

describe("capability filtering", () => {
  const assets = {
    "/_models-all.json": capabilityModels,
    "/_api-all.json": capabilityProviders,
    "/_catalog-all.json": capabilityCatalog,
  };

  test("filters models.json by task", async () => {
    const response = await request("/models.json?task=embeddings", assets);
    const body = await response.json();

    expect(Object.keys(body)).toEqual(["embedding"]);
  });

  test("ORs values within an axis and ANDs across axes", async () => {
    const either = await request(
      "/models.json?task=embeddings,text_generation",
      assets,
    );
    expect(Object.keys(await either.json())).toEqual(["embedding", "chat"]);

    const both = await request(
      "/api.json?task=text_generation&feature=tool_calling",
      assets,
    );
    const body = await both.json();
    expect(Object.keys(body.example.models)).toEqual(["chat"]);
  });

  test("filters catalog aliases alongside entries", async () => {
    const response = await request("/catalog.json?transport=websocket", assets);
    const body = await response.json();

    expect(Object.keys(body.models)).toEqual(["chat"]);
    expect(body.aliases).toEqual({ "chat-alias": "chat" });
  });

  test("combines capability filters with model type filters", async () => {
    const response = await request(
      "/models.json?task=text_generation&type=all",
      assets,
    );
    expect(Object.keys(await response.json())).toEqual(["chat"]);
  });

  test("filters model-schema.json IDs", async () => {
    const response = await request("/model-schema.json?task=embeddings", assets);
    const body = await response.json();

    expect(body.$defs.Model.enum).toEqual(["example/embedding"]);
  });

  test("rejects unknown capability values with an allowed list", async () => {
    const response = await request("/models.json?task=bogus", assets);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("Invalid task value: bogus");
    expect(body.allowed).toContain("embeddings");
  });

  test("caches capability-filtered responses when an edge cache exists", async () => {
    const store = new Map<string, Response>();
    let puts = 0;
    const fakeCaches = {
      default: {
        async match(key: Request) {
          return store.get(key.url)?.clone();
        },
        async put(key: Request, response: Response) {
          puts++;
          store.set(key.url, response.clone());
        },
      },
    };
    const globalWithCaches = globalThis as { caches?: unknown };
    const previous = globalWithCaches.caches;
    globalWithCaches.caches = fakeCaches;

    try {
      const first = await request("/models.json?task=embeddings", assets);
      expect(Object.keys(await first.json())).toEqual(["embedding"]);
      expect(puts).toBe(1);

      const second = await request("/models.json?task=embeddings", assets);
      expect(Object.keys(await second.json())).toEqual(["embedding"]);
      expect(puts).toBe(1);
    } finally {
      globalWithCaches.caches = previous;
    }
  });
});

async function request(
  path: string,
  overrides: Record<string, unknown> = {},
) {
  const env = {
    ASSETS: {
      fetch(input: Request) {
        const pathname = new URL(input.url).pathname;
        if (pathname in overrides) return Response.json(overrides[pathname]);
        if (pathname === "/_api.json") {
          return Response.json({
            example: { ...providers.example, models: { text: textModel } },
          });
        }
        if (pathname === "/_api-all.json") return Response.json(providers);
        if (pathname === "/_api-decision.json") {
          return Response.json({
            example: { ...providers.example, models: { decision: decisionModel } },
          });
        }
        if (pathname === "/_models.json") {
          return Response.json({ text: textModel });
        }
        if (pathname === "/_models-all.json") return Response.json(models);
        if (pathname === "/_models-decision.json") {
          return Response.json({ decision: decisionModel });
        }
        if (pathname === "/_catalog.json") {
          return Response.json({
            ...catalogMeta,
            providers: {
              example: { ...providers.example, models: { text: textModel } },
            },
            models: { text: textModel },
          });
        }
        if (pathname === "/_catalog-all.json") {
          return Response.json({ ...catalogMeta, providers, models });
        }
        if (pathname === "/_catalog-decision.json") {
          return Response.json({
            ...catalogMeta,
            providers: {
              example: { ...providers.example, models: { decision: decisionModel } },
            },
            models: { decision: decisionModel },
          });
        }
        return new Response(null, { status: 404 });
      },
    },
  } as unknown as Env;

  return worker.fetch(
    new Request(`https://models.dev${path}`, {
      headers: { "user-agent": "test" },
    }),
    env,
    { waitUntil() {} } as unknown as ExecutionContext,
  );
}
