import type { CapabilityFilter, ModelType } from "./types.js"

export interface QueryOptions {
  /** Specialized model types to include. Omit for standard models; use `"all"` for the complete catalog. */
  readonly modelTypes?: "all" | readonly ModelType[]
  /** Capability requirements to filter the response by. */
  readonly capabilities?: CapabilityFilter
}

const CAPABILITY_FILTER_PARAMS: Record<keyof CapabilityFilter, string> = {
  tasks: "task",
  features: "feature",
  inputs: "input",
  operations: "operation",
  transports: "transport",
}

/** Applies model type and capability filters to a request URL. */
export function applyQuery(url: URL, options?: QueryOptions) {
  const modelTypes = options?.modelTypes
  if (modelTypes === "all") {
    url.searchParams.set("type", "all")
  } else if (modelTypes && modelTypes.length > 0) {
    url.searchParams.set("type", modelTypes.join(","))
  }

  const capabilities = options?.capabilities
  if (capabilities) {
    for (const axis of Object.keys(CAPABILITY_FILTER_PARAMS) as Array<keyof CapabilityFilter>) {
      const values = capabilities[axis]
      if (!values || values.length === 0) continue
      url.searchParams.set(CAPABILITY_FILTER_PARAMS[axis], [...values].sort().join(","))
    }
  }

  return url
}
