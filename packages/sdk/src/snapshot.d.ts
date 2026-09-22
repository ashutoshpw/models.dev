import type { Catalog, ModelMetadataMap, ProviderMap } from "./index.js"

/** All providers with their models, pricing, and limits. Same shape as `client.providers()`. */
export declare const providers: ProviderMap

/** Provider-agnostic model metadata keyed by canonical model ID. Same shape as `client.models()`. */
export declare const models: ModelMetadataMap

/** Alias ID to resolved model ID map (canonical and provider scoped). */
export declare const aliases: Record<string, string>

/** Catalog contract version embedded in this snapshot. */
export declare const schemaVersion: number

/** ISO timestamp of when this snapshot was generated from the models.dev repository. */
export declare const generatedAt: string

/** The full catalog: `{ schema_version, providers, models, aliases }`. Same shape as `client.catalog()`. */
declare const snapshot: Catalog
export default snapshot
