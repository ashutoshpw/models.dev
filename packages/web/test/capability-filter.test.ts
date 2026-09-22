import { describe, expect, test } from "bun:test";

import {
  capabilityFilterTokens,
  capabilitySelectionMatches,
} from "../src/shared.js";

describe("capability filter selection", () => {
  const tokens = capabilityFilterTokens({
    capabilities: {
      tasks: {
        text_generation: { status: "supported" },
        embeddings: { status: "unsupported" },
      },
      features: { tool_calling: { status: "supported" } },
      endpoints: {
        transports: { websocket: { status: "supported" } },
      },
    },
  });

  test("builds axis-prefixed tokens for supported capabilities only", () => {
    expect(tokens).toEqual([
      "task:text_generation",
      "feature:tool_calling",
      "transport:websocket",
    ]);
  });

  test("ORs within an axis and ANDs across axes", () => {
    expect(
      capabilitySelectionMatches(
        tokens,
        new Map([["task", new Set(["text_generation", "embeddings"])]]),
      ),
    ).toBe(true);
    expect(
      capabilitySelectionMatches(
        tokens,
        new Map([
          ["task", new Set(["text_generation"])],
          ["feature", new Set(["tool_calling"])],
        ]),
      ),
    ).toBe(true);
    expect(
      capabilitySelectionMatches(
        tokens,
        new Map([
          ["task", new Set(["text_generation"])],
          ["feature", new Set(["web_search"])],
        ]),
      ),
    ).toBe(false);
  });

  test("empty selection matches, unknown tokens do not", () => {
    expect(capabilitySelectionMatches(tokens, new Map())).toBe(true);
    expect(
      capabilitySelectionMatches(tokens, new Map([["input", new Set(["image"])]])),
    ).toBe(false);
  });
});
