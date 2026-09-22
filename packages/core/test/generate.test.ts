import { describe, expect, test } from "bun:test";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { generate, generateCatalog } from "../src/index.js";

async function withFixture<T>(callback: (root: string) => Promise<T>) {
  const root = await mkdtemp(path.join(tmpdir(), "models-dev-test-"));
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

function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

describe("catalog generation", () => {
  test("rejects providers with no models", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/empty/provider.toml", providerToml("Empty"));

      expect(generate(path.join(root, "providers"))).rejects.toThrow(
        'Provider "empty" has no models',
      );
    });
  });

  test("base_model can factor metadata without changing provider JSON", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/direct/provider.toml", providerToml("Direct"));
      await write(root, "providers/factored/provider.toml", providerToml("Factored"));
      await write(root, "models/lab/model.toml", modelMetadataToml());
      await write(
        root,
        "providers/direct/models/model.toml",
        `${providerFieldsToml()}

[cost]
input = 1.25
output = 2.50
cache_read = 0.125
`,
      );
      await write(
        root,
        "providers/factored/models/model.toml",
        `base_model = "lab/model"
reasoning_options = []

[cost]
input = 1.25
output = 2.50
cache_read = 0.125
`,
      );

      const catalog = await generateCatalog(root);

      expect(catalog.models["lab/model"]?.benchmarks).toEqual([
        {
          name: "SWE-Bench Verified",
          score: 71.2,
          metric: "resolved",
          harness: "Example Harness",
          variant: "high",
          dataset: "verified",
          version: "1",
          source: "https://example.com/benchmarks",
        },
      ]);
      expect(catalog.models["lab/model"]?.weights).toEqual([
        {
          label: "Weights",
          url: "https://huggingface.co/lab/model",
          format: "safetensors",
        },
      ]);

      const {
        canonical: _canonical,
        ...factoredModel
      } = catalog.providers.factored!.models.model!;
      expect(factoredModel).toMatchObject(
        catalog.providers.direct?.models.model ?? {},
      );
      expect(catalog.providers.factored!.models.model!.canonical).toBe(
        "lab/model",
      );
      expect(catalog.providers.factored?.models.model).not.toHaveProperty(
        "base_model",
      );
      expect(catalog.providers.factored?.models.model).not.toHaveProperty(
        "benchmarks",
      );
    });
  });

  test("base_model_omit removes inherited metadata fields", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/provider/provider.toml", providerToml("Provider"));
      await write(root, "models/lab/model.toml", modelMetadataToml());
      await write(
        root,
        "providers/provider/models/model.toml",
        `base_model = "lab/model"
base_model_omit = ["limit.input", "structured_output"]
reasoning_options = []

[cost]
input = 1.25
output = 2.50

[limit]
context = 200_000
output = 32_000
`,
      );

      const providers = await generate(path.join(root, "providers"));
      const model = providers.provider?.models.model;

      expect(model?.structured_output).toBeUndefined();
      expect(model?.limit).toEqual({
        context: 200_000,
        output: 32_000,
      });
    });
  });

  test("base_model can inherit sibling fields from partial object overrides", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/provider/provider.toml", providerToml("Provider"));
      await write(root, "models/lab/model.toml", modelMetadataToml());
      await write(
        root,
        "providers/provider/models/model.toml",
        `base_model = "lab/model"
open_weights = true
reasoning_options = []

[cost]
input = 1.25
output = 2.50

[limit]
context = 200_000

[modalities]
input = ["text"]
`,
      );

      const providers = await generate(path.join(root, "providers"));
      const model = providers.provider?.models.model;

      expect(model?.open_weights).toBe(true);
      expect(model?.limit).toEqual({
        context: 200_000,
        input: 272_000,
        output: 128_000,
      });
      expect(model?.modalities).toEqual({
        input: ["text"],
        output: ["text"],
      });
    });
  });

  test("repository provider TOMLs do not use legacy extends tables", async () => {
    const root = path.join(import.meta.dirname, "..", "..", "..");
    const matches: string[] = [];

    for await (const file of new Bun.Glob("providers/**/*.toml").scan({
      cwd: root,
    })) {
      const text = await Bun.file(path.join(root, file)).text();
      if (/^\[extends\]/m.test(text)) matches.push(file);
    }

    expect(matches).toEqual([]);
  });

  test("repository provider JSON strips authored metadata pointers", async () => {
    const root = path.join(import.meta.dirname, "..", "..", "..");
    const providers = await generate(path.join(root, "providers"));
    const leaked: string[] = [];

    for (const [providerID, provider] of Object.entries(providers)) {
      for (const [modelID, model] of Object.entries(provider.models)) {
        const encoded = stable(model);
        if (encoded.includes("base_model") || encoded.includes("base_model_omit")) {
          leaked.push(`${providerID}/${modelID}`);
        }
      }
    }

    expect(leaked).toEqual([]);
  });

  test("repository provider JSON excludes model-only metadata", async () => {
    const root = path.join(import.meta.dirname, "..", "..", "..");
    const providers = await generate(path.join(root, "providers"));
    const modelOnlyFields = ["benchmarks", "license", "links", "weights"];
    const leaked: string[] = [];

    for (const [providerID, provider] of Object.entries(providers)) {
      for (const [modelID, model] of Object.entries(provider.models)) {
        const leakedFields = modelOnlyFields.filter((field) => field in model);
        if (leakedFields.length > 0) {
          leaked.push(`${providerID}/${modelID}: ${leakedFields.join(", ")}`);
        }
      }
    }

    expect(leaked).toEqual([]);
  });

  test("repository model metadata avoids provider-only namespaces", async () => {
    const root = path.join(import.meta.dirname, "..", "..", "..");
    const providerNamespaces = [
      "amazon-bedrock",
      "llama",
      "opencode",
      "tencent-tokenhub",
      "zai",
    ];
    const namespaceDirs = providerNamespaces.filter((namespace) =>
      existsSync(path.join(root, "models", namespace))
    );
    const baseModelRefs: string[] = [];

    for await (const file of new Bun.Glob("providers/**/*.toml").scan({
      cwd: root,
    })) {
      const text = await Bun.file(path.join(root, file)).text();
      const match = /^base_model = "([^/"]+)\//m.exec(text);
      if (match?.[1] !== undefined && providerNamespaces.includes(match[1])) {
        baseModelRefs.push(file);
      }
    }

    expect(namespaceDirs).toEqual([]);
    expect(baseModelRefs).toEqual([]);
  });

  test("repository open-weight model metadata includes weights links", async () => {
    const root = path.join(import.meta.dirname, "..", "..", "..");
    const catalog = await generateCatalog(root);
    const missingWeights: string[] = [];
    const closedWithWeights: string[] = [];

    for (const [modelID, model] of Object.entries(catalog.models)) {
      const hasWeights = (model.weights?.length ?? 0) > 0;
      if (model.open_weights === true && !hasWeights) {
        missingWeights.push(modelID);
      }
      if (model.open_weights !== true && hasWeights) {
        closedWithWeights.push(modelID);
      }
    }

    expect(missingWeights).toEqual([]);
    expect(closedWithWeights).toEqual([]);
  });

  test("repository benchmark metadata is sourced", async () => {
    const root = path.join(import.meta.dirname, "..", "..", "..");
    const catalog = await generateCatalog(root);
    const unsourced: string[] = [];

    for (const [modelID, model] of Object.entries(catalog.models)) {
      for (const benchmark of model.benchmarks ?? []) {
        if (benchmark.source === undefined) {
          unsourced.push(`${modelID}: ${benchmark.name}`);
        }
      }
    }

    expect(unsourced).toEqual([]);
  });

  test("repository benchmark names are normalized", async () => {
    const root = path.join(import.meta.dirname, "..", "..", "..");
    const catalog = await generateCatalog(root);
    const qualifiedNames: string[] = [];

    for (const [modelID, model] of Object.entries(catalog.models)) {
      for (const benchmark of model.benchmarks ?? []) {
        if (/\s\([^)]+\)$/.test(benchmark.name)) {
          qualifiedNames.push(`${modelID}: ${benchmark.name}`);
        }
      }
    }

    expect(qualifiedNames).toEqual([]);
  });
});

describe("capabilities, aliases, and canonical references", () => {
  test("providers inherit canonical capabilities and can negate them with evidence", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/provider/provider.toml", providerToml("Provider"));
      await write(root, "models/lab/model.toml", capabilityModelToml());
      await write(
        root,
        "providers/provider/models/model.toml",
        `base_model = "lab/model"
reasoning_options = []

[cost]
input = 1
output = 2

[capabilities.features.implicit_prompt_caching]
status = "unsupported"
evidence = ["https://example.com/provider/no-cache"]
verified_at = "2026-01-04"
`,
      );

      const providers = await generate(path.join(root, "providers"));
      const capabilities = providers.provider?.models.model?.capabilities;

      expect(capabilities?.features?.tool_calling).toEqual({
        status: "supported",
        evidence: ["https://example.com/docs/tools"],
        verified_at: "2026-01-02",
      });
      expect(capabilities?.features?.implicit_prompt_caching).toEqual({
        status: "unsupported",
        evidence: ["https://example.com/provider/no-cache"],
        verified_at: "2026-01-04",
      });
      expect(providers.provider?.models.model?.canonical).toBe("lab/model");
    });
  });

  test("provider status overrides must supply their own evidence", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/provider/provider.toml", providerToml("Provider"));
      await write(root, "models/lab/model.toml", capabilityModelToml());
      await write(
        root,
        "providers/provider/models/model.toml",
        `base_model = "lab/model"
reasoning_options = []

[cost]
input = 1
output = 2

[capabilities.features.tool_calling]
status = "unsupported"
`,
      );

      expect(generateCatalog(root)).rejects.toThrow(
        "must include evidence and verified_at",
      );
    });
  });

  test("explicit unknown clears inherited evidence", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/provider/provider.toml", providerToml("Provider"));
      await write(root, "models/lab/model.toml", capabilityModelToml());
      await write(
        root,
        "providers/provider/models/model.toml",
        `base_model = "lab/model"
reasoning_options = []

[cost]
input = 1
output = 2

[capabilities.features.implicit_prompt_caching]
status = "unknown"
`,
      );

      const providers = await generate(path.join(root, "providers"));

      expect(
        providers.provider?.models.model?.capabilities?.features
          ?.implicit_prompt_caching,
      ).toEqual({ status: "unknown" });
    });
  });

  test("base_model_omit resets capabilities to unknown", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/provider/provider.toml", providerToml("Provider"));
      await write(root, "models/lab/model.toml", capabilityModelToml());
      await write(
        root,
        "providers/provider/models/model.toml",
        `base_model = "lab/model"
base_model_omit = ["capabilities.features.implicit_prompt_caching"]
reasoning_options = []

[cost]
input = 1
output = 2
`,
      );

      const providers = await generate(path.join(root, "providers"));

      expect(
        providers.provider?.models.model?.capabilities?.features
          ?.implicit_prompt_caching,
      ).toBeUndefined();
      expect(
        providers.provider?.models.model?.capabilities?.tasks
          ?.text_generation?.status,
      ).toBe("supported");
    });
  });

  test("provider legacy booleans downgrade inherited capability claims to unknown", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/provider/provider.toml", providerToml("Provider"));
      await write(root, "models/lab/model.toml", capabilityModelToml());
      await write(
        root,
        "providers/provider/models/model.toml",
        `base_model = "lab/model"
reasoning_options = []
tool_call = false

[cost]
input = 1
output = 2
`,
      );

      const providers = await generate(path.join(root, "providers"));
      const model = providers.provider?.models.model;

      expect(model?.tool_call).toBe(false);
      expect(
        model?.capabilities?.features?.tool_calling,
      ).toBeUndefined();
      expect(
        model?.capabilities?.features?.implicit_prompt_caching?.status,
      ).toBe("supported");
    });
  });

  test("provider modality overrides downgrade inherited negative input claims", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/provider/provider.toml", providerToml("Provider"));
      await write(root, "models/lab/model.toml", capabilityModelToml());
      await write(
        root,
        "providers/provider/models/model.toml",
        `base_model = "lab/model"
reasoning_options = []

[cost]
input = 1
output = 2

[modalities]
input = ["text", "image", "pdf"]
`,
      );

      const providers = await generate(path.join(root, "providers"));
      const model = providers.provider?.models.model;

      expect(model?.modalities.input).toContain("pdf");
      expect(model?.capabilities?.inputs?.files).toBeUndefined();
    });
  });

  test("canonical aliases are exposed on models and not inherited by providers", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/provider/provider.toml", providerToml("Provider"));
      await write(root, "models/lab/model.toml", capabilityModelToml());
      await write(
        root,
        "providers/provider/models/model.toml",
        `base_model = "lab/model"
reasoning_options = []

[cost]
input = 1
output = 2
`,
      );

      const catalog = await generateCatalog(root);

      expect(catalog.models["lab/model"]?.aliases).toEqual([
        "lab/model-latest",
      ]);
      expect(catalog.providers.provider?.models.model).not.toHaveProperty(
        "aliases",
      );
      expect(catalog.aliases).toEqual({
        "lab/model-latest": "lab/model",
      });
    });
  });

  test("provider aliases are namespaced and resolvable", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/provider/provider.toml", providerToml("Provider"));
      await write(root, "models/lab/model.toml", capabilityModelToml());
      await write(
        root,
        "providers/provider/models/model.toml",
        `base_model = "lab/model"
aliases = ["model-latest"]
reasoning_options = []

[cost]
input = 1
output = 2
`,
      );

      const catalog = await generateCatalog(root);

      expect(catalog.aliases).toEqual({
        "lab/model-latest": "lab/model",
        "provider/model-latest": "provider/model",
      });
    });
  });

  test("authored canonical references resolve and must match base_model", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/provider/provider.toml", providerToml("Provider"));
      await write(root, "models/lab/model.toml", capabilityModelToml());
      await write(
        root,
        "providers/provider/models/model.toml",
        `base_model = "lab/model"
canonical = "lab/other"
reasoning_options = []

[cost]
input = 1
output = 2
`,
      );

      expect(generate(path.join(root, "providers"))).rejects.toThrow(
        'canonical "lab/other" must match base_model "lab/model"',
      );
    });
  });

  test("first-party provider entries resolve to their same-id canonical model", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/lab/provider.toml", providerToml("Lab"));
      await write(root, "models/lab/capability-model.toml", capabilityModelToml());
      await write(
        root,
        "providers/lab/models/capability-model.toml",
        providerFieldsToml(),
      );

      const catalog = await generateCatalog(root);

      expect(
        catalog.providers.lab?.models["capability-model"]?.canonical,
      ).toBe("lab/capability-model");
    });
  });

  test("authored canonical references must exist", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/provider/provider.toml", providerToml("Provider"));
      await write(
        root,
        "providers/provider/models/model.toml",
        providerFieldsToml('canonical = "lab/missing"\n'),
      );

      expect(generate(path.join(root, "providers"))).rejects.toThrow(
        "Unable to resolve canonical model: lab/missing",
      );
    });
  });

  test("alias collisions are rejected", async () => {
    await withFixture(async (root) => {
      await write(root, "providers/provider/provider.toml", providerToml("Provider"));
      await write(root, "models/lab/model.toml", capabilityModelToml());
      await write(
        root,
        "models/lab/other.toml",
        capabilityModelToml({
          name: "Other Model",
          aliases: ["lab/model"],
        }),
      );
      await write(
        root,
        "providers/provider/models/model.toml",
        `base_model = "lab/model"
reasoning_options = []

[cost]
input = 1
output = 2
`,
      );

      expect(generateCatalog(root)).rejects.toThrow(
        'Alias "lab/model" collides with an existing model id',
      );
    });
  });
});

function providerToml(name: string) {
  return `name = "${name}"
npm = "@ai-sdk/openai"
env = ["API_KEY"]
doc = "https://example.com/models"
`;
}

function modelMetadataToml() {
  return `name = "Lab Model"
description = "Example model for catalog generation and inheritance tests"
family = "gpt"
release_date = "2026-01-02"
last_updated = "2026-01-03"
attachment = true
reasoning = true
temperature = false
tool_call = true
structured_output = true
knowledge = "2025-12"
open_weights = true
license = "Example License"

[limit]
context = 400_000
input = 272_000
output = 128_000

[modalities]
input = ["text", "image"]
output = ["text"]

[[links]]
label = "Model card"
url = "https://example.com/model"
type = "model_card"

[[weights]]
label = "Weights"
url = "https://huggingface.co/lab/model"
format = "safetensors"

[[benchmarks]]
name = "SWE-Bench Verified"
score = 71.2
metric = "resolved"
harness = "Example Harness"
variant = "high"
dataset = "verified"
version = "1"
source = "https://example.com/benchmarks"
`;
}

function providerFieldsToml(prefix = "") {
  return `${prefix}name = "Lab Model"
description = "Example model for catalog generation and inheritance tests"
family = "gpt"
release_date = "2026-01-02"
last_updated = "2026-01-03"
attachment = true
reasoning = true
reasoning_options = []
temperature = false
tool_call = true
structured_output = true
knowledge = "2025-12"
open_weights = true

[limit]
context = 400_000
input = 272_000
output = 128_000

[modalities]
input = ["text", "image"]
output = ["text"]
`;
}

function capabilityModelToml(
  options: { name?: string; aliases?: string[] } = {},
) {
  const aliases = options.aliases ?? ["lab/model-latest"];
  return `name = "${options.name ?? "Capability Model"}"
description = "Example model carrying capability metadata"
release_date = "2026-01-02"
last_updated = "2026-01-03"
attachment = true
reasoning = true
tool_call = true
structured_output = true
open_weights = false
aliases = [${aliases.map((alias) => JSON.stringify(alias)).join(", ")}]

[limit]
context = 100_000
output = 8_000

[modalities]
input = ["text", "image"]
output = ["text"]

[capabilities.tasks.text_generation]
status = "supported"
evidence = ["https://example.com/docs/text"]
verified_at = "2026-01-02"

[capabilities.features.tool_calling]
status = "supported"
evidence = ["https://example.com/docs/tools"]
verified_at = "2026-01-02"

[capabilities.features.implicit_prompt_caching]
status = "supported"
evidence = ["https://example.com/docs/cache"]
verified_at = "2026-01-02"

[capabilities.inputs.files]
status = "unsupported"
evidence = ["https://example.com/docs/no-files"]
verified_at = "2026-01-02"
`;
}
