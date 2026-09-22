// Capability value sets shared by the schema and the filter helpers. Kept
// dependency-free so `filter.ts` can import them without a cycle
// (`schema.ts` imports `MODEL_TYPES` from `filter.ts`).

export const CapabilityTaskValues = [
  "text_generation",
  "image_generation",
  "video_generation",
  "transcription",
  "speech_synthesis",
  "realtime_conversation",
  "embeddings",
  "reranking",
  "evaluation",
] as const;

export const CapabilityInputValues = [
  "text",
  "image",
  "audio",
  "video",
  "files",
] as const;

export const CapabilityFeatureValues = [
  "reasoning",
  "tool_calling",
  "structured_output",
  "web_search",
  "implicit_prompt_caching",
  "explicit_prompt_caching",
] as const;

export const TransportValues = ["http", "sse", "websocket"] as const;

export const OperationValues = [
  "chat",
  "messages",
  "responses",
  "completions",
  "embeddings",
  "images",
  "videos",
  "transcriptions",
  "speech",
  "rerank",
  "realtime",
  "evaluate",
] as const;

export type CapabilityTaskValue = (typeof CapabilityTaskValues)[number];
export type CapabilityInputValue = (typeof CapabilityInputValues)[number];
export type CapabilityFeatureValue = (typeof CapabilityFeatureValues)[number];
export type TransportValue = (typeof TransportValues)[number];
export type OperationValue = (typeof OperationValues)[number];

/** Normative operation to task mapping, enforced by validation. */
export const OPERATION_TASKS: Record<OperationValue, CapabilityTaskValue> = {
  chat: "text_generation",
  messages: "text_generation",
  responses: "text_generation",
  completions: "text_generation",
  embeddings: "embeddings",
  images: "image_generation",
  videos: "video_generation",
  transcriptions: "transcription",
  speech: "speech_synthesis",
  rerank: "reranking",
  realtime: "realtime_conversation",
  evaluate: "evaluation",
};

/** Input capability kind to legacy modality mapping. */
export const INPUT_MODALITIES: Array<[CapabilityInputValue, string]> = [
  ["text", "text"],
  ["image", "image"],
  ["audio", "audio"],
  ["video", "video"],
  ["files", "pdf"],
];
