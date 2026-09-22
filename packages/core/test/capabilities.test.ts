import { describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { generate, generateCatalog } from "../src/index.js";

async function withFixture<T>(callback: (root: string) => Promise<T>) {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-capabilities-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function write(root: string, file: string, content: string) {
  const filePath = path.join(root, file);
  await mkdir(path.dirname(filePath), { recursive: true });
  await Bun.write(filePath, content);
}

function providerToml(name: string) {
  return `name = "${name}"
npm = "@ai-sdk/openai"
env = ["API_KEY"]
doc = "https://example.com/models"
`;
}

function embeddingModelToml() {
  return `name = "Embedding Model"
description = "Example embedding model whose legacy output modality is text"
release_date = "2026-01-02"
last_updated = "2026-01-03"
attachment = false
reasoning = false
tool_call = false
open_weights = false

[limit]
context = 8_192
output = 3_072

[modalities]
input = ["text"]
output = ["text"]

[capabilities.tasks.embeddings]
status = "supported"
evidence = ["https://example.com/docs/embeddings"]
verified_at = "2026-01-02"
`;
}

describe("capability semantics", () => {
  test("tasks are never derived from text output modalities", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/provider/provider.toml", providerToml("Provider"));
      await write(root, "models/lab/embedding-model.toml", embeddingModelToml());
      await write(
        root,
        "providers/provider/models/embedding-model.toml",
        `base_model = "lab/embedding-model"

[cost]
input = 0.02
output = 0
`,
      );

      const catalog = await generateCatalog(root);
      const model = catalog.providers.provider?.models["embedding-model"];

      expect(model?.modalities.output).toEqual(["text"]);
      expect(model?.capabilities?.tasks?.embeddings?.status).toBe("supported");
      expect(model?.capabilities?.tasks?.text_generation).toBeUndefined();
      expect(model?.capabilities?.tasks?.reranking).toBeUndefined();
    });
  });

  test("models without capability metadata resolve to unknown", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/provider/provider.toml", providerToml("Provider"));
      await write(
        root,
        "providers/provider/models/plain.toml",
        `name = "Plain Model"
description = "Example model without capability metadata"
release_date = "2026-01-02"
last_updated = "2026-01-03"
attachment = false
reasoning = false
tool_call = false
open_weights = false

[limit]
context = 1_000
output = 100

[modalities]
input = ["text"]
output = ["text"]
`,
      );

      const providers = await generate(path.join(root, "providers"));

      expect(providers.provider?.models.plain?.capabilities).toBeUndefined();
    });
  });

  test("repository embedding and rerank models are not text generators", async () => {
    const root = path.join(import.meta.dirname, "..", "..", "..");
    const catalog = await generateCatalog(root);

    const embedding = catalog.models["google/gemini-embedding-001"];
    expect(embedding?.modalities?.output).toEqual(["text"]);
    expect(embedding?.capabilities?.tasks?.embeddings?.status).toBe(
      "supported",
    );
    expect(embedding?.capabilities?.tasks?.text_generation).toBeUndefined();

    const reranker = catalog.models["nvidia/llama-nemotron-rerank-vl-1b-v2"];
    expect(reranker?.capabilities?.tasks?.reranking?.status).toBe("supported");
    expect(reranker?.capabilities?.tasks?.text_generation?.status).toBe(
      "unsupported",
    );
  });

  test("repository provider endpoints are exposed without leaking to canonical models", async () => {
    const root = path.join(import.meta.dirname, "..", "..", "..");
    const catalog = await generateCatalog(root);

    const providerModel = catalog.providers.openai?.models["gpt-5.4"];
    expect(
      providerModel?.capabilities?.endpoints?.operations?.responses?.status,
    ).toBe("supported");
    expect(providerModel?.capabilities?.tasks?.text_generation?.status).toBe(
      "supported",
    );
    expect(providerModel?.canonical).toBe("openai/gpt-5.4");
    expect(catalog.models["openai/gpt-5.4"]?.capabilities).not.toHaveProperty(
      "endpoints",
    );
  });

  test("provider endpoints are merged alongside inherited capabilities", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/provider/provider.toml", providerToml("Provider"));
      await write(root, "models/lab/embedding-model.toml", embeddingModelToml());
      await write(
        root,
        "providers/provider/models/embedding-model.toml",
        `base_model = "lab/embedding-model"

[cost]
input = 0.02
output = 0

[capabilities.endpoints.transports]
[capabilities.endpoints.transports.http]
status = "supported"
evidence = ["https://example.com/docs/api"]
verified_at = "2026-01-04"
[capabilities.endpoints.operations]
[capabilities.endpoints.operations.embeddings]
status = "supported"
evidence = ["https://example.com/docs/api"]
verified_at = "2026-01-04"
`,
      );

      const providers = await generate(path.join(root, "providers"));
      const capabilities =
        providers.provider?.models["embedding-model"]?.capabilities;

      expect(capabilities?.tasks?.embeddings?.status).toBe("supported");
      expect(capabilities?.endpoints?.transports?.http?.status).toBe(
        "supported",
      );
      expect(capabilities?.endpoints?.operations?.embeddings?.status).toBe(
        "supported",
      );
    });
  });
});
