import {
  filterCatalogByCapabilities,
  filterCatalogByModelType,
  filterModelsByCapabilities,
  filterModelsByModelType,
  filterProvidersByCapabilities,
  filterProvidersByModelType,
  hasCapabilityFilter,
  InvalidCapabilityFilterError,
  InvalidModelTypeError,
  MODEL_TYPES,
  parseCapabilityFilter,
  parseModelTypes,
} from "@models.dev/core/src/filter.js";
import type {
  CapabilityFilter,
  ModelTypeFilter,
  ModelTypeValue,
} from "@models.dev/core/src/filter.js";

export interface Env {
  ASSETS: any;
  PosthogToken?: string;
  LakeUrl?: string;
  LakeSecret?: string;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const ip = request.headers.get("cf-connecting-ip") ?? undefined;
    const country = request.headers.get("cf-ipcountry") ?? undefined;
    const agent = request.headers.get("user-agent") ?? undefined;
    const time = new Date().toISOString();
    if (
      (agent?.includes("opencode") || agent?.includes("bun")) &&
      env.PosthogToken &&
      env.LakeUrl &&
      env.LakeSecret
    ) {
      ctx.waitUntil(
        fetch("https://us.i.posthog.com/i/v0/e/", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            api_key: JSON.parse(env.PosthogToken).value,
            event: "hit",
            distinct_id: ip ?? "unknown",
            properties: {
              $process_person_profile: false,
              user_agent: agent ?? "unknown",
              country: country ?? "unknown",
              path: url.pathname,
            },
          }),
        }),
      );

      ctx.waitUntil(
        fetch(JSON.parse(env.LakeUrl).value, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${JSON.parse(env.LakeSecret).value}`,
          },
          body: JSON.stringify({
            events: [
              {
                _datalake_key: "inference.event",
                event_timestamp: time,
                event_date: time.slice(0, 10),
                event_type: "models.hit",
                ip: string(ip),
                ip_prefix: string(ipPrefix(ip)),
                user_agent: string(agent),
                cf_country: string(country),
                path: string(url.pathname),
              },
            ],
          }),
        }),
      );
    }

    if (url.pathname === "/model-schema.json") {
      const apiResponse = await catalogResponse(url, request, env, "api");
      if (!apiResponse.ok) return apiResponse;
      const providers = (await apiResponse.json()) as Record<
        string,
        { models: Record<string, unknown> }
      >;

      const modelIds: string[] = [];
      for (const [providerId, provider] of Object.entries(providers)) {
        for (const modelId of Object.keys(provider.models)) {
          modelIds.push(`${providerId}/${modelId}`);
        }
      }

      const schema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://models.dev/model-schema.json",
        $defs: {
          Model: {
            type: "string",
            enum: modelIds.sort(),
            description: "AI model identifier in provider/model format",
          },
        },
      };

      return new Response(JSON.stringify(schema, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    if (url.pathname === "/api.json") {
      return catalogResponse(url, request, env, "api");
    } else if (url.pathname === "/models.json") {
      return catalogResponse(url, request, env, "models");
    } else if (url.pathname === "/catalog.json") {
      return catalogResponse(url, request, env, "catalog");
    } else if (
      url.pathname === "/" ||
      url.pathname === "/index.html" ||
      url.pathname === "/index"
    ) {
      url.pathname = "/_index";
    } else if (isHtmlRoute(url.pathname)) {
      url.pathname = htmlRouteAssetPath(url.pathname);
    } else if (url.pathname.startsWith("/logos/")) {
      // Check if the specific provider logo exists in static assets
      const logoResponse = await env.ASSETS.fetch(
        new Request(url.toString(), request),
      );

      if (logoResponse.status === 404) {
        // Fallback to default logo
        const defaultUrl = new URL(url);
        defaultUrl.pathname = "/logos/default.svg";
        return await env.ASSETS.fetch(
          new Request(defaultUrl.toString(), request),
        );
      }

      return logoResponse;
    }

    const response = await env.ASSETS.fetch(new Request(url.toString(), request));
    if (response.status !== 404) return response;

    return new Response(null, {
      status: 302,
      headers: { Location: "/" },
    });
  },
};

type CatalogEndpoint = "api" | "models" | "catalog";

async function catalogResponse(
  url: URL,
  request: Request,
  env: Env,
  endpoint: CatalogEndpoint,
) {
  let typeFilter: ModelTypeFilter;
  try {
    typeFilter = parseModelTypes(url.searchParams.get("type"));
  } catch (error) {
    if (!(error instanceof InvalidModelTypeError)) throw error;
    return Response.json(
      {
        error: error.message,
        allowed: [...MODEL_TYPES, "all"],
      },
      {
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" },
      },
    );
  }

  let capabilityFilter: CapabilityFilter;
  try {
    capabilityFilter = parseCapabilityFilter(url.searchParams);
  } catch (error) {
    if (!(error instanceof InvalidCapabilityFilterError)) throw error;
    return Response.json(
      { error: error.message, allowed: error.allowed },
      {
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" },
      },
    );
  }
  const capabilityActive = hasCapabilityFilter(capabilityFilter);

  const cache = capabilityActive ? edgeCache() : undefined;
  const cacheKey =
    cache === undefined ? undefined : new Request(url.toString(), { method: "GET" });
  if (cache !== undefined && cacheKey !== undefined) {
    const cached = await cache.match(cacheKey);
    if (cached !== undefined) return cached;
  }

  const assetUrl = new URL(url);
  const suffix = typeFilter === "default"
    ? ""
    : typeFilter === "all"
      ? "-all"
      : typeFilter.length === 1
        ? `-${typeFilter[0]}`
        : undefined;
  assetUrl.pathname = capabilityActive
    ? `/_${endpoint}-all.json`
    : `/_${endpoint}${suffix ?? "-all"}.json`;
  assetUrl.search = "";
  const assetResponse = await env.ASSETS.fetch(
    new Request(assetUrl.toString(), request),
  );
  if (!assetResponse.ok) return assetResponse;
  if (!capabilityActive && suffix !== undefined) return assetResponse;

  const value = await assetResponse.json();
  const capabilityFiltered = capabilityActive
    ? applyCapabilityFilter(value, endpoint, capabilityFilter)
    : value;
  const filtered = typeFilter === "all"
    ? capabilityFiltered
    : applyTypeFilter(capabilityFiltered, endpoint, typeFilter);

  const headers = new Headers(assetResponse.headers);
  headers.delete("Content-Length");
  headers.delete("ETag");
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "public, max-age=3600");
  const response = new Response(JSON.stringify(filtered), { headers });
  if (cache !== undefined && cacheKey !== undefined) {
    await cache.put(cacheKey, response.clone());
  }
  return response;
}

function applyCapabilityFilter(
  value: unknown,
  endpoint: CatalogEndpoint,
  filter: CapabilityFilter,
) {
  return endpoint === "api"
    ? filterProvidersByCapabilities(
        value as Record<string, CatalogProvider>,
        filter,
      )
    : endpoint === "models"
      ? filterModelsByCapabilities(value as Record<string, CatalogModel>, filter)
      : filterCatalogByCapabilities(
          value as CatalogPayload,
          filter,
        );
}

function applyTypeFilter(
  value: unknown,
  endpoint: CatalogEndpoint,
  filter: ModelTypeFilter,
) {
  return endpoint === "api"
    ? filterProvidersByModelType(
        value as Record<string, CatalogProvider>,
        filter,
      )
    : endpoint === "models"
      ? filterModelsByModelType(value as Record<string, CatalogModel>, filter)
      : filterCatalogByModelType(value as CatalogPayload, filter);
}

interface EdgeCache {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, response: Response): Promise<void>;
}

function edgeCache(): EdgeCache | undefined {
  const globalCaches = (
    globalThis as unknown as { caches?: { default?: EdgeCache } }
  ).caches;
  return globalCaches?.default;
}

interface CatalogCapabilityNode {
  status?: string;
}

interface CatalogModel {
  type?: ModelTypeValue;
  capabilities?: {
    tasks?: Record<string, CatalogCapabilityNode | undefined>;
    inputs?: Record<string, CatalogCapabilityNode | undefined>;
    features?: Record<string, CatalogCapabilityNode | undefined>;
    endpoints?: {
      transports?: Record<string, CatalogCapabilityNode | undefined>;
      operations?: Record<string, CatalogCapabilityNode | undefined>;
    };
  };
}

interface CatalogProvider {
  models: Record<string, CatalogModel>;
}

interface CatalogPayload {
  providers: Record<string, CatalogProvider>;
  models: Record<string, CatalogModel>;
  schema_version?: number;
  generated_at?: string;
  aliases?: Record<string, string>;
}

function isHtmlRoute(pathname: string) {
  return (
    pathname === "/models" ||
    pathname === "/providers" ||
    pathname === "/labs" ||
    pathname.startsWith("/models/") ||
    pathname.startsWith("/providers/") ||
    pathname.startsWith("/labs/")
  );
}

function htmlRouteAssetPath(pathname: string) {
  const normalized =
    pathname !== "/" && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  return `${normalized}/index.html`;
}

// Returns a stable lookup key for an IP address.
// IPv4: full address as /32 (e.g. "203.0.113.45/32").
// IPv6: the /64 network prefix (e.g. "2001:db8:abcd:1234::/64"). ISPs commonly
// rotate the lower 64 host bits via SLAAC privacy extensions (RFC 8981), so
// grouping by /64 collapses those rotations into one key.
function ipPrefix(ip: string | undefined) {
  if (!ip) return undefined;
  if (ip.includes(".") && !ip.includes(":")) return `${ip}/32`;
  if (!ip.includes(":")) return undefined;

  // Expand "::" to its full form, then keep the first 4 hextets.
  const [head, tail] = ip.split("::") as [string, string | undefined];
  const headParts = head ? head.split(":") : [];
  const tailParts = tail !== undefined ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0) return undefined;
  const full = [...headParts, ...new Array(missing).fill("0"), ...tailParts];
  if (full.length !== 8) return undefined;

  const prefix = full
    .slice(0, 4)
    .map((part) => part.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":");
  return `${prefix}::/64`;
}

function string(value: string | undefined) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return undefined;
}
