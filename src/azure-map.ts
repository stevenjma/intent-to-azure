/**
 * Capability → Azure mapping (MVP defaults).
 *
 * The single source of truth for how a capability becomes concrete Azure
 * resources. Kept deliberately small and honest: we only map the MVP corpus and
 * never invent SKUs or regions beyond what's here. Each builder returns fully
 * formed {@link AzureResource}s (region + rough cost baked in) that the planner
 * stitches together with `dependsOn` wiring.
 *
 *   web-compute               → Azure Container Apps (fallback: App Service / SWA)
 *   transactional-relational  → Azure Database for PostgreSQL Flexible Server
 *   chat-model                → Azure OpenAI (account + model deployments)
 *   embeddings                → Azure AI Search (unless served by pgvector)
 *   search-index              → Azure AI Search
 *   object-storage            → Azure Blob Storage (Storage account + container)
 *   background-jobs           → Azure Container Apps Job
 */

import type { AzureResource, Need } from "./types.js";

/** Inputs shared by every capability builder. */
export interface MapContext {
  region: string;
  /** Bias toward the cheapest SKUs (sponsorship / free-trial / economy guardrail). */
  economy: boolean;
  /** Logical id of the Container Apps managed environment, if one exists. */
  envId?: string;
}

/** Sanitize a model id into an Azure deployment name. */
function deploymentName(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** The Container Apps managed environment that hosts web-compute and jobs. */
export function buildManagedEnvironment(ctx: MapContext): AzureResource {
  return {
    id: "app-env",
    name: "cae-${appName}",
    type: "Microsoft.App/managedEnvironments",
    service: "Azure Container Apps Environment",
    region: ctx.region,
    estimatedMonthlyUsd: 0,
    notes: ["Consumption plan — you pay only for running container replicas."],
  };
}

export function buildWebCompute(need: Need, ctx: MapContext): AzureResource[] {
  const app: AzureResource = {
    id: "web",
    name: "ca-${appName}",
    type: "Microsoft.App/containerApps",
    service: "Azure Container Apps",
    region: ctx.region,
    capability: "web-compute",
    dependsOn: ctx.envId ? [ctx.envId] : [],
    estimatedMonthlyUsd: ctx.economy ? 15 : 40,
    notes: [
      "Fallback options considered: Azure App Service (always-on web apps) or Azure Static Web Apps (static/JAMstack).",
    ],
    properties: {
      ingress: { external: true, targetPort: inferPort(need) },
      scale: ctx.economy ? { minReplicas: 0, maxReplicas: 3 } : { minReplicas: 1, maxReplicas: 10 },
    },
  };
  return [app];
}

export function buildRelational(need: Need, ctx: MapContext): AzureResource[] {
  const pgvector = need.options?.pgvector === true;
  const sku = ctx.economy ? "Standard_B1ms" : "Standard_D2s_v3";
  const tier = ctx.economy ? "Burstable" : "GeneralPurpose";
  const server: AzureResource = {
    id: "postgres",
    name: "psql-${appName}",
    type: "Microsoft.DBforPostgreSQL/flexibleServers",
    service: "Azure Database for PostgreSQL Flexible Server",
    sku,
    region: ctx.region,
    capability: "transactional-relational",
    estimatedMonthlyUsd: ctx.economy ? 15 : 130,
    notes: [
      `${tier} tier.`,
      ...(pgvector ? ["pgvector extension enabled — vector search is served in-database."] : []),
    ],
    properties: {
      version: "16",
      storageGb: 32,
      ...(pgvector ? { extensions: ["vector"] } : {}),
      ...(need.options?.consistency ? { consistency: need.options.consistency } : {}),
    },
  };
  const db: AzureResource = {
    id: "postgres-db",
    name: "appdb",
    type: "Microsoft.DBforPostgreSQL/flexibleServers/databases",
    service: "PostgreSQL Database",
    region: ctx.region,
    capability: "transactional-relational",
    dependsOn: ["postgres"],
    estimatedMonthlyUsd: 0,
  };
  const resources: AzureResource[] = [server, db];
  if (pgvector) {
    resources.push({
      id: "postgres-ext",
      name: "azure.extensions",
      type: "Microsoft.DBforPostgreSQL/flexibleServers/configurations",
      service: "PostgreSQL Server Configuration",
      region: ctx.region,
      capability: "transactional-relational",
      dependsOn: ["postgres"],
      estimatedMonthlyUsd: 0,
      notes: ["Allowlists the pgvector extension at the server level (azure.extensions = VECTOR)."],
      properties: { value: "VECTOR", source: "user-override" },
    });
  }
  return resources;
}

export function buildChatModel(need: Need, ctx: MapContext, approvedModels?: string[]): AzureResource[] {
  const account: AzureResource = {
    id: "openai",
    name: "oai-${appName}",
    type: "Microsoft.CognitiveServices/accounts",
    service: "Azure OpenAI",
    sku: "S0",
    region: ctx.region,
    capability: "chat-model",
    estimatedMonthlyUsd: 0,
    notes: ["Token usage is billed per-1K tokens; the fixed cost is $0. Confirm model availability in the chosen region."],
    properties: { kind: "OpenAI" },
  };

  const resources: AzureResource[] = [account];
  const models = pickModels(need, approvedModels);
  for (const model of models) {
    resources.push({
      id: `openai-deploy-${deploymentName(model)}`,
      name: deploymentName(model),
      type: "Microsoft.CognitiveServices/accounts/deployments",
      service: "Azure OpenAI Deployment",
      region: ctx.region,
      capability: "chat-model",
      dependsOn: ["openai"],
      estimatedMonthlyUsd: 0,
      properties: { model, capacityK: ctx.economy ? 10 : 30 },
    });
  }
  return resources;
}

/** Azure AI Search — satisfies `search-index` and `embeddings` (when not pgvector). */
export function buildSearch(capability: "embeddings" | "search-index", ctx: MapContext): AzureResource[] {
  return [
    {
      id: "search",
      name: "srch-${appName}",
      type: "Microsoft.Search/searchServices",
      service: "Azure AI Search",
      sku: ctx.economy ? "basic" : "standard",
      region: ctx.region,
      capability,
      estimatedMonthlyUsd: ctx.economy ? 75 : 250,
      notes: ["Hosts vector + keyword indexes."],
    },
  ];
}

export function buildObjectStorage(_need: Need, ctx: MapContext): AzureResource[] {
  const account: AzureResource = {
    id: "storage",
    name: "st${appName}",
    type: "Microsoft.Storage/storageAccounts",
    service: "Azure Blob Storage",
    sku: "Standard_LRS",
    region: ctx.region,
    capability: "object-storage",
    estimatedMonthlyUsd: 5,
    properties: { kind: "StorageV2", accessTier: "Hot" },
  };
  const container: AzureResource = {
    id: "blob",
    name: "assets",
    type: "Microsoft.Storage/storageAccounts/blobServices/containers",
    service: "Blob Container",
    region: ctx.region,
    capability: "object-storage",
    dependsOn: ["storage"],
    estimatedMonthlyUsd: 0,
  };
  return [account, container];
}

export function buildBackgroundJobs(_need: Need, ctx: MapContext): AzureResource[] {
  return [
    {
      id: "jobs",
      name: "caj-${appName}",
      type: "Microsoft.App/jobs",
      service: "Azure Container Apps Job",
      region: ctx.region,
      capability: "background-jobs",
      dependsOn: ctx.envId ? [ctx.envId] : [],
      estimatedMonthlyUsd: ctx.economy ? 5 : 15,
      properties: { triggerType: "Schedule" },
    },
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Filter a need's models by the guardrail allow-list (policy wins). */
function pickModels(need: Need, approvedModels?: string[]): string[] {
  const models = Array.isArray(need.options?.models) ? (need.options!.models as string[]) : [];
  if (!approvedModels || approvedModels.length === 0) return models;
  const allow = new Set(approvedModels.map((m) => m.toLowerCase()));
  return models.filter((m) => allow.has(m.toLowerCase()));
}

function inferPort(need: Need): number {
  const fw = need.options?.framework;
  if (fw === "fastapi") return 8000;
  if (fw === "django") return 8000;
  return 3000;
}
