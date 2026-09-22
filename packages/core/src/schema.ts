import { z } from "zod";

import {
  CapabilityFeatureValues,
  CapabilityInputValues,
  CapabilityTaskValues,
  INPUT_MODALITIES,
  OPERATION_TASKS,
  OperationValues,
  TransportValues,
} from "./capabilities";
import type {
  CapabilityFeatureValue,
  OperationValue,
} from "./capabilities";
import { ModelFamily } from "./family";
import { MODEL_TYPES } from "./filter";

export * from "./capabilities.js";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(JsonValue),
  ]),
);

const ReasoningEffortValue = z.preprocess(
  (value) => (value === "null" ? null : value),
  z.union([
    z.null(),
    z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"]),
  ]),
);

export const ReasoningOption = z
  .discriminatedUnion("type", [
    z
      .object({
        type: z.literal("toggle"),
      })
      .strict(),
    z
      .object({
        type: z.literal("effort"),
        values: z.array(ReasoningEffortValue),
      })
      .strict(),
    z
      .object({
        type: z.literal("budget_tokens"),
        min: z
          .number()
          .min(-1, "Minimum reasoning budget cannot be less than -1")
          .optional(),
        max: z
          .number()
          .min(0, "Maximum reasoning budget cannot be negative")
          .optional(),
      })
      .strict(),
  ])
  .refine(
    (data) =>
      data.type !== "budget_tokens" ||
      data.min === undefined ||
      data.max === undefined ||
      data.min <= data.max,
    {
      message:
        "Minimum reasoning budget cannot exceed maximum reasoning budget",
      path: ["min"],
    },
  );

const Cost = z.object({
  input: z.number().min(0, "Input price cannot be negative"),
  output: z.number().min(0, "Output price cannot be negative"),
  reasoning: z.number().min(0, "Reasoning price cannot be negative").optional(),
  cache_read: z
    .number()
    .min(0, "Cache read price cannot be negative")
    .optional(),
  cache_write: z
    .number()
    .min(0, "Cache write price cannot be negative")
    .optional(),
  input_audio: z
    .number()
    .min(0, "Audio input price cannot be negative")
    .optional(),
  output_audio: z
    .number()
    .min(0, "Audio output price cannot be negative")
    .optional(),
}).strict();

const CostTier = Cost.extend({
  tier: z
    .object({
      type: z.literal("context").default("context"),
      size: z.number().int().min(0, "Context tier size cannot be negative"),
    })
    .strict(),
}).strict();

const AuthoredCost = Cost.extend({
  context_over_200k: z.never().optional(),
  tiers: z.array(CostTier).optional(),
}).strict();

const OutputCost = Cost.extend({
  context_over_200k: Cost.optional(),
  tiers: z.array(CostTier).optional(),
}).strict();

function isCalendarDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (month === undefined || month < 1 || month > 12) return false;
  if (day === undefined) return true;

  const leapYear =
    year !== undefined &&
    year % 4 === 0 &&
    (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day >= 1 && day <= daysInMonth[month - 1]!;
}

const DateString = z
  .string()
  .regex(/^\d{4}-\d{2}(-\d{2})?$/, {
    message: "Must be in YYYY-MM or YYYY-MM-DD format",
  })
  .refine(isCalendarDate, {
    message: "Must be a valid calendar date",
  });

const Modality = z.enum(["text", "audio", "image", "video", "pdf"]);

export const ModelType = z.enum(MODEL_TYPES);

const Modalities = z
  .object({
    input: z.array(Modality),
    output: z.array(Modality),
  })
  .strict();

const LimitBase = z
  .object({
    context: z.number().min(0, "Context window must be positive"),
    input: z.number().min(0, "Input tokens must be positive").optional(),
  })
  .strict();

const ModelLimit = LimitBase.extend({
  output: z.number().min(0, "Output tokens must be positive").optional(),
}).strict();

const ProviderModelLimit = LimitBase.extend({
  output: z.number().min(0, "Output tokens must be positive"),
}).strict();

const UrlString = z.string().url("Must be a valid URL");

/**
 * Capability metadata.
 *
 * Capabilities are tri-state: a node with `status = "supported"` or
 * `"unsupported"` is an evidence-backed declaration; a missing node means
 * unknown. `supported`/`unsupported` declarations require at least one
 * evidence URL and a `verified_at` date. `unknown` forbids both, so an
 * explicit unknown can clear an inherited declaration.
 */
export const CapabilityStatus = z.enum(["supported", "unsupported", "unknown"]);

export const CapabilityTask = z.enum(CapabilityTaskValues);
export const CapabilityInput = z.enum(CapabilityInputValues);
export const CapabilityFeature = z.enum(CapabilityFeatureValues);
export const Transport = z.enum(TransportValues);
export const Operation = z.enum(OperationValues);

export type CapabilityStatus = z.infer<typeof CapabilityStatus>;

const VerificationDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, {
    message: "Must be in YYYY-MM-DD format",
  })
  .refine(isCalendarDate, {
    message: "Must be a valid calendar date",
  });

const MediaType = z.string().regex(
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i,
  { message: "Must be a valid media type (e.g. application/pdf)" },
);

const Evidence = z
  .array(UrlString)
  .min(1, "At least one evidence URL is required");

const DeclarationBase = z
  .object({
    status: CapabilityStatus,
    evidence: Evidence.optional(),
    verified_at: VerificationDate.optional(),
  })
  .strict();

type DeclarationData = z.infer<typeof DeclarationBase>;

const DECLARATION_MESSAGE =
  "supported/unsupported require evidence and verified_at; unknown forbids them";

function declarationIsConsistent(data: DeclarationData) {
  return data.status === "unknown"
    ? data.evidence === undefined && data.verified_at === undefined
    : data.evidence !== undefined && data.verified_at !== undefined;
}

export const Declaration = DeclarationBase.refine(declarationIsConsistent, {
  message: DECLARATION_MESSAGE,
});

const InputDeclarationBase = DeclarationBase.extend({
  formats: z.array(MediaType).min(1, "formats cannot be empty").optional(),
}).strict();

export const InputDeclaration = InputDeclarationBase.refine(
  declarationIsConsistent,
  { message: DECLARATION_MESSAGE },
).refine((data) => data.formats === undefined || data.status === "supported", {
  message: "formats can only be set when status is supported",
  path: ["formats"],
});

/**
 * Builds a strict object with every key from `keys` optional, so omitted
 * capabilities are unknown and the inferred type matches the runtime
 * behavior. `z.record` is intentionally avoided: it infers required keys in
 * this Zod version.
 */
function capabilityMap<K extends string, T extends z.ZodTypeAny>(
  keys: readonly K[],
  value: T,
) {
  return z
    .object(
      Object.fromEntries(
        keys.map((key) => [key, value.optional()]),
      ) as Record<K, z.ZodOptional<T>>,
    )
    .strict();
}

export const Capabilities = z
  .object({
    tasks: capabilityMap(CapabilityTaskValues, Declaration).optional(),
    inputs: capabilityMap(CapabilityInputValues, InputDeclaration).optional(),
    features: capabilityMap(CapabilityFeatureValues, Declaration).optional(),
  })
  .strict();

export const EndpointCapabilities = z
  .object({
    transports: capabilityMap(TransportValues, Declaration).optional(),
    operations: capabilityMap(OperationValues, Declaration).optional(),
  })
  .strict();

export const ProviderCapabilities = Capabilities.extend({
  endpoints: EndpointCapabilities.optional(),
}).strict();

export type Capabilities = z.infer<typeof Capabilities>;
export type EndpointCapabilities = z.infer<typeof EndpointCapabilities>;
export type ProviderCapabilities = z.infer<typeof ProviderCapabilities>;
export type Declaration = z.infer<typeof Declaration>;
export type InputDeclaration = z.infer<typeof InputDeclaration>;

interface CapabilityConsistencyInput {
  id?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  modalities?: { input: string[] };
  aliases?: readonly string[];
  capabilities?: {
    tasks?: Record<string, { status?: CapabilityStatus } | undefined>;
    inputs?: Record<
      string,
      { status?: CapabilityStatus; formats?: unknown } | undefined
    >;
    features?: Record<string, { status?: CapabilityStatus } | undefined>;
    endpoints?: {
      operations?: Record<string, { status?: CapabilityStatus } | undefined>;
    };
  };
}



const FEATURE_BOOLEANS: Array<[CapabilityFeatureValue, string]> = [
  ["reasoning", "reasoning"],
  ["tool_calling", "tool_call"],
  ["structured_output", "structured_output"],
];

function addCapabilityIssues(
  data: CapabilityConsistencyInput,
  ctx: z.RefinementCtx,
) {
  const features = data.capabilities?.features;
  for (const [feature, field] of FEATURE_BOOLEANS) {
    const value = data[field as keyof CapabilityConsistencyInput];
    const status = features?.[feature]?.status;
    if (typeof value !== "boolean" || status === undefined || status === "unknown") {
      continue;
    }
    if (value !== (status === "supported")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities", "features", feature],
        message: `${field} = ${value} contradicts capabilities.${feature}.${status}`,
      });
    }
  }

  const inputs = data.capabilities?.inputs;
  if (inputs !== undefined) {
    for (const [kind, node] of Object.entries(inputs)) {
      if (kind !== "files" && node?.formats !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["capabilities", "inputs", kind, "formats"],
          message: "formats can only be set on inputs.files",
        });
      }
    }

    if (data.modalities !== undefined) {
      for (const [kind, modality] of INPUT_MODALITIES) {
        if (
          inputs[kind]?.status === "unsupported" &&
          data.modalities.input.includes(modality)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["capabilities", "inputs", kind],
            message: `inputs.${kind} is unsupported but modalities.input includes "${modality}"`,
          });
        }
      }
    }
  }

  const operations = data.capabilities?.endpoints?.operations;
  if (operations !== undefined) {
    for (const [operation, declaration] of Object.entries(operations)) {
      if (declaration?.status !== "supported") continue;
      const task =
        OPERATION_TASKS[operation as OperationValue];
      if (
        task !== undefined &&
        data.capabilities?.tasks?.[task]?.status === "unsupported"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["capabilities", "endpoints", "operations", operation],
          message: `operation "${operation}" is supported but task "${task}" is unsupported`,
        });
      }
    }
  }

  if (data.id !== undefined && data.aliases?.includes(data.id)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["aliases"],
      message: "A model cannot alias itself",
    });
  }
}

const CanonicalAlias = z
  .string()
  .min(1, "Alias cannot be empty")
  .refine(
    (value) =>
      value.includes("/") &&
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !/\s/.test(value) &&
      !value.split("/").some((part) => part.length === 0),
    { message: "Alias must be a fully-qualified <lab>/<model> identifier" },
  );

const ProviderAlias = z
  .string()
  .min(1, "Alias cannot be empty")
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !/\s/.test(value),
    { message: "Alias must not contain whitespace or leading/trailing slashes" },
  );

export const ModelLink = z
  .object({
    label: z.string().min(1, "Link label cannot be empty").optional(),
    url: UrlString,
    type: z
      .enum([
        "announcement",
        "blog",
        "docs",
        "license",
        "model_card",
        "paper",
        "weights",
        "other",
      ])
      .optional(),
  })
  .strict();

export const ModelWeights = z
  .object({
    label: z.string().min(1, "Weights label cannot be empty").optional(),
    url: UrlString,
    format: z.string().min(1, "Weights format cannot be empty").optional(),
    quantization: z
      .string()
      .min(1, "Weights quantization cannot be empty")
      .optional(),
  })
  .strict();

export const BenchmarkResult = z
  .object({
    name: z.string().min(1, "Benchmark name cannot be empty"),
    score: z.union([z.number(), z.string().min(1)]),
    metric: z.string().min(1, "Benchmark metric cannot be empty").optional(),
    harness: z.string().min(1, "Benchmark harness cannot be empty").optional(),
    variant: z.string().min(1, "Benchmark variant cannot be empty").optional(),
    dataset: z.string().min(1, "Benchmark dataset cannot be empty").optional(),
    version: z.string().min(1, "Benchmark version cannot be empty").optional(),
    source: UrlString.optional(),
    date: DateString.optional(),
  })
  .strict();

const ModelMetadataBase = z.object({
  id: z.string(),
  type: ModelType.optional(),
  name: z.string().min(1, "Model name cannot be empty"),
  description: z.string().min(1, "Model description cannot be empty"),
  family: ModelFamily.optional(),
  attachment: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  tool_call: z.boolean().optional(),
  structured_output: z.boolean().optional(),
  temperature: z.boolean().optional(),
  knowledge: DateString.optional(),
  release_date: DateString.optional(),
  last_updated: DateString.optional(),
  modalities: Modalities.optional(),
  open_weights: z.boolean().optional(),
  limit: ModelLimit.optional(),
  license: z.string().min(1, "License cannot be empty").optional(),
  links: z.array(ModelLink).optional(),
  weights: z.array(ModelWeights).optional(),
  benchmarks: z.array(BenchmarkResult).optional(),
  capabilities: Capabilities.optional(),
  aliases: z.array(CanonicalAlias).optional(),
});

export const ModelMetadata = ModelMetadataBase.strict().superRefine(
  (data, ctx) =>
    addCapabilityIssues(data as CapabilityConsistencyInput, ctx),
);

export type ModelMetadata = z.infer<typeof ModelMetadata>;

const ModelBase = z.object({
  id: z.string(),
  type: ModelType.optional(),
  name: z.string().min(1, "Model name cannot be empty"),
  description: z.string().min(1, "Model description cannot be empty"),
  family: ModelFamily.optional(),
  attachment: z.boolean(),
  reasoning: z.boolean(),
  reasoning_options: z.array(ReasoningOption).optional(),
  tool_call: z.boolean(),
  interleaved: z
    .union([
      z.literal(true),
      z
        .object({
          field: z.enum(["reasoning_content", "reasoning_details"]),
        })
        .strict(),
    ])
    .optional(),
  structured_output: z.boolean().optional(),
  temperature: z.boolean().optional(),
  knowledge: DateString.optional(),
  release_date: DateString,
  last_updated: DateString,
  modalities: Modalities,
  open_weights: z.boolean(),
  limit: ProviderModelLimit,
  status: z.enum(["alpha", "beta", "deprecated"]).optional(),
  capabilities: ProviderCapabilities.optional(),
  aliases: z.array(ProviderAlias).optional(),
  canonical: z.string().min(1, "Canonical model cannot be empty").optional(),
  experimental: z
    .object({
      modes: z
        .record(
          z
            .object({
              cost: Cost.optional(),
              provider: z
                .object({
                  body: z.record(JsonValue).optional(),
                  headers: z.record(z.string()).optional(),
                })
                .strict()
                .optional(),
            })
            .strict(),
        )
        .optional(),
    })
    .strict()
    .optional(),
  provider: z
    .object({
      npm: z.string().optional(),
      api: z.string().optional(),
      shape: z.enum(["responses", "completions"]).optional(),
      body: z.record(JsonValue).optional(),
      headers: z.record(z.string()).optional(),
    })
    .strict()
    .optional(),
});

function refineModel<
  Output extends z.infer<typeof ModelShape> | z.infer<typeof AuthoredModelShape>,
  Def extends z.ZodTypeDef,
  Input,
>(schema: z.ZodType<Output, Def, Input>) {
  return schema
    .refine(
      (data) => {
        return data.reasoning !== true || data.reasoning_options !== undefined;
      },
      {
        message: "Must set reasoning_options when reasoning is true",
        path: ["reasoning_options"],
      },
    )
    .refine(
      (data) => {
        return data.reasoning !== false || data.reasoning_options === undefined;
      },
      {
        message: "Cannot set reasoning_options when reasoning is false",
        path: ["reasoning_options"],
      },
    )
    .refine(
      (data) => {
        return !(
          data.reasoning === false && data.cost?.reasoning !== undefined
        );
      },
      {
        message: "Cannot set cost.reasoning when reasoning is false",
        path: ["cost", "reasoning"],
      },
    )
    .refine(
      (data) => {
        const tiers = data.cost?.tiers;
        if (tiers === undefined) return true;

        const sizes = tiers.map(
          (tier: { tier: { size: number } }) => tier.tier.size,
        );
        return new Set(sizes).size === sizes.length;
      },
      {
        message: "Cost context tiers must not have duplicate sizes",
        path: ["cost", "tiers"],
      },
    )
    .superRefine((data, ctx) =>
      addCapabilityIssues(data as CapabilityConsistencyInput, ctx),
    );
}

export const ModelShape = z
  .object({
    ...ModelBase.shape,
    cost: OutputCost.optional(),
  })
  .strict();

export const AuthoredModelShape = z
  .object({
    ...ModelBase.shape,
    cost: AuthoredCost.optional(),
  })
  .strict();

export const Model = refineModel(ModelShape);

export const AuthoredModel = refineModel(AuthoredModelShape);

export type Model = z.infer<typeof Model>;

export const Provider = z
  .object({
    id: z.string(),
    env: z.array(z.string()).min(1, "Provider env cannot be empty"),
    npm: z.string().min(1, "Provider npm module cannot be empty"),
    api: z.string().optional(),
    name: z.string().min(1, "Provider name cannot be empty"),
    doc: z
      .string()
      .min(
        1,
        "Please provide a link to the provider documentation where models are listed",
      ),
    models: z.record(Model),
  })
  .strict()
  .refine(
    (data) => {
      const isOpenAI = data.npm === "@ai-sdk/openai";
      const isOpenAIcompatible = data.npm === "@ai-sdk/openai-compatible";
      const isOpenrouter = data.npm === "@openrouter/ai-sdk-provider";
      const isMergeGateway = data.npm === "merge-gateway-ai-sdk-provider";
      const isAnthropic = data.npm === "@ai-sdk/anthropic";
      const isKiro = data.npm === "kiro-acp-ai-provider";
      const hasApi = data.api !== undefined;

      return (
        // openai-compatible: must have api
        (isOpenAIcompatible && hasApi) ||
        // openrouter: must have api
        (isOpenrouter && hasApi) ||
        // Merge Gateway: native provider with an OpenAI-compatible fallback
        (isMergeGateway && hasApi) ||
        // anthropic: api optional (always allowed)
        isAnthropic ||
        // openai: api optional (always allowed)
        isOpenAI ||
        // kiro: api optional (always allowed)
        isKiro ||
        // all others: must NOT have api
        (!isOpenAI &&
          !isOpenAIcompatible &&
          !isOpenrouter &&
          !isMergeGateway &&
          !isAnthropic &&
          !isKiro &&
          !hasApi)
      );
    },
    {
      message:
        "'api' is required for openai-compatible, openrouter, and Merge Gateway; optional for anthropic, openai, and kiro; forbidden otherwise",
      path: ["api"],
    },
  );

export type Provider = z.infer<typeof Provider>;
