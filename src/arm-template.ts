/**
 * ARM-template generator — turn a resolved {@link AzurePlan} into a deployable
 * ARM JSON template, the artifact the browser SPA hands to Azure Resource Manager
 * (`PUT /deployments/{name}`). The CLI deploys Bicep via `az` (which compiles it);
 * a static page can't run the Bicep toolchain, so we emit ARM JSON directly.
 *
 * This mirrors {@link ./bicep.ts} decision-for-decision (same pinned API versions,
 * SKUs, kinds, and property shapes) so the browser deploy provisions exactly what
 * the Bicep preview describes. Pure and browser-safe: no `node:` imports.
 */

import type { AzurePlan, AzureResource } from "./types.js";
import { API_VERSIONS, MODEL_VERSIONS } from "./bicep.js";

interface ArmResource {
  type: string;
  apiVersion: string;
  name: string;
  location?: string;
  kind?: string;
  sku?: Record<string, unknown>;
  properties?: Record<string, unknown>;
  dependsOn?: string[];
}

interface ArmTemplate {
  $schema: string;
  contentVersion: string;
  parameters: Record<string, unknown>;
  resources: ArmResource[];
  outputs?: Record<string, unknown>;
}

/** Build a deployable ARM template from a resolved plan. */
export function generateArmTemplate(plan: AzurePlan): ArmTemplate {
  const idToName = new Map<string, string>();
  for (const r of plan.resources) idToName.set(r.id, r.name);
  const idToResource = new Map<string, AzureResource>();
  for (const r of plan.resources) idToResource.set(r.id, r);

  const hasPg = plan.resources.some(
    (r) => r.type === "Microsoft.DBforPostgreSQL/flexibleServers",
  );

  const parameters: Record<string, unknown> = {
    location: { type: "string", defaultValue: plan.region },
  };
  if (hasPg) {
    parameters.postgresAdminLogin = { type: "string", defaultValue: "pgadmin" };
    parameters.postgresAdminPassword = { type: "securestring" };
  }

  const resources = plan.resources.map((r) => emitResource(r, idToName, idToResource));

  const template: ArmTemplate = {
    $schema:
      "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
    contentVersion: "1.0.0.0",
    parameters,
    resources,
  };

  const outputs = emitOutputs(plan.resources);
  if (Object.keys(outputs).length) template.outputs = outputs;

  return template;
}

function emitResource(
  r: AzureResource,
  idToName: Map<string, string>,
  idToResource: Map<string, AzureResource>,
): ArmResource {
  const api = API_VERSIONS[r.type] ?? "2024-01-01";
  const child = isChild(r.type);
  const name = child ? hierarchicalName(r, idToName) : r.name;

  const res: ArmResource = { type: r.type, apiVersion: api, name };
  if (!child) res.location = "[parameters('location')]";

  const kind = kindFor(r);
  if (kind) res.kind = kind;

  const sku = skuFor(r);
  if (sku) res.sku = sku;

  const props = propertiesFor(r, idToName);
  if (props) res.properties = props;

  const deps = (r.dependsOn ?? [])
    .map((id) => idToResource.get(id))
    .filter((d): d is AzureResource => Boolean(d))
    .map((d) => resourceIdExpr(d, idToName));
  if (deps.length) res.dependsOn = deps;

  return res;
}

function skuFor(r: AzureResource): Record<string, unknown> | undefined {
  switch (r.type) {
    case "Microsoft.DBforPostgreSQL/flexibleServers": {
      const sku = r.sku ?? "Standard_B1ms";
      const tier = sku.startsWith("Standard_B") ? "Burstable" : "GeneralPurpose";
      return { name: sku, tier };
    }
    case "Microsoft.CognitiveServices/accounts":
      return { name: r.sku ?? "S0" };
    case "Microsoft.Search/searchServices":
      return { name: r.sku ?? "basic" };
    case "Microsoft.Storage/storageAccounts":
      return { name: r.sku ?? "Standard_LRS" };
    case "Microsoft.CognitiveServices/accounts/deployments":
      return { name: "Standard", capacity: numProp(r, "capacityK", 10) };
    default:
      return undefined;
  }
}

function kindFor(r: AzureResource): string | undefined {
  if (r.type === "Microsoft.CognitiveServices/accounts") return "OpenAI";
  if (r.type === "Microsoft.Storage/storageAccounts") return "StorageV2";
  return undefined;
}

function propertiesFor(
  r: AzureResource,
  idToName: Map<string, string>,
): Record<string, unknown> | undefined {
  switch (r.type) {
    case "Microsoft.App/managedEnvironments":
      return {};
    case "Microsoft.App/containerApps": {
      const port = numDeep(r, ["ingress", "targetPort"], 3000);
      const scale = (r.properties?.scale ?? {}) as { minReplicas?: number; maxReplicas?: number };
      const props: Record<string, unknown> = {
        configuration: { ingress: { external: true, targetPort: port } },
        template: {
          containers: [
            {
              name: "app",
              image: "mcr.microsoft.com/k8se/quickstart:latest",
              resources: { cpu: 0.5, memory: "1.0Gi" },
            },
          ],
          scale: { minReplicas: scale.minReplicas ?? 0, maxReplicas: scale.maxReplicas ?? 3 },
        },
      };
      const envName = idToName.get("app-env");
      if (envName) {
        props.managedEnvironmentId = `[resourceId('Microsoft.App/managedEnvironments', '${envName}')]`;
      }
      return props;
    }
    case "Microsoft.App/jobs": {
      const props: Record<string, unknown> = {
        configuration: {
          triggerType: "Schedule",
          replicaTimeout: 1800,
          scheduleTriggerConfig: { cronExpression: "0 * * * *" },
        },
        template: {
          containers: [
            {
              name: "job",
              image: "mcr.microsoft.com/k8se/quickstart-jobs:latest",
              resources: { cpu: 0.5, memory: "1.0Gi" },
            },
          ],
        },
      };
      const envName = idToName.get("app-env");
      if (envName) {
        props.environmentId = `[resourceId('Microsoft.App/managedEnvironments', '${envName}')]`;
      }
      return props;
    }
    case "Microsoft.DBforPostgreSQL/flexibleServers":
      return {
        version: strProp(r, "version", "16"),
        administratorLogin: "[parameters('postgresAdminLogin')]",
        administratorLoginPassword: "[parameters('postgresAdminPassword')]",
        storage: { storageSizeGB: numProp(r, "storageGb", 32) },
        authConfig: { passwordAuth: "Enabled" },
      };
    case "Microsoft.DBforPostgreSQL/flexibleServers/databases":
      return { charset: "UTF8", collation: "en_US.utf8" };
    case "Microsoft.DBforPostgreSQL/flexibleServers/configurations":
      return { value: strProp(r, "value", "VECTOR"), source: strProp(r, "source", "user-override") };
    case "Microsoft.CognitiveServices/accounts":
      return { publicNetworkAccess: "Enabled", customSubDomainName: r.name };
    case "Microsoft.CognitiveServices/accounts/deployments": {
      const model = strProp(r, "model", "gpt-4o");
      const version = MODEL_VERSIONS[model];
      const modelObj: Record<string, unknown> = { format: "OpenAI", name: model };
      if (version) modelObj.version = version;
      return { model: modelObj };
    }
    case "Microsoft.Search/searchServices":
      return { replicaCount: 1, partitionCount: 1, hostingMode: "default" };
    case "Microsoft.Storage/storageAccounts":
      return {
        accessTier: "Hot",
        supportsHttpsTrafficOnly: true,
        minimumTlsVersion: "TLS1_2",
        allowBlobPublicAccess: false,
      };
    case "Microsoft.Storage/storageAccounts/blobServices/containers":
      return { publicAccess: "None" };
    default:
      return undefined;
  }
}

function emitOutputs(resources: AzureResource[]): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  const web = resources.find((r) => r.id === "web");
  if (web) {
    outputs.webAppName = { type: "string", value: web.name };
  }
  const pg = resources.find((r) => r.id === "postgres");
  if (pg) {
    outputs.postgresServerName = { type: "string", value: pg.name };
  }
  const st = resources.find((r) => r.id === "storage");
  if (st) {
    outputs.storageAccountName = { type: "string", value: st.name };
  }
  return outputs;
}

// ---------------------------------------------------------------------------
// Helpers (kept in lockstep with bicep.ts)
// ---------------------------------------------------------------------------

function isChild(type: string): boolean {
  return type.split("/").length >= 3;
}

function hierarchicalName(r: AzureResource, idToName: Map<string, string>): string {
  const parentId = r.dependsOn?.[0];
  const parentName = parentId ? idToName.get(parentId) : undefined;
  if (!parentName) return r.name;
  if (r.type.endsWith("blobServices/containers")) return `${parentName}/default/${r.name}`;
  return `${parentName}/${r.name}`;
}

/** ARM `resourceId(...)` expression addressing a (possibly nested) resource. */
function resourceIdExpr(r: AzureResource, idToName: Map<string, string>): string {
  const full = isChild(r.type) ? hierarchicalName(r, idToName) : r.name;
  const segments = full.split("/").map((s) => `'${s}'`);
  return `[resourceId('${r.type}', ${segments.join(", ")})]`;
}

function numProp(r: AzureResource, key: string, fallback: number): number {
  const v = r.properties?.[key];
  return typeof v === "number" ? v : fallback;
}

function strProp(r: AzureResource, key: string, fallback: string): string {
  const v = r.properties?.[key];
  return typeof v === "string" ? v : fallback;
}

function numDeep(r: AzureResource, path: string[], fallback: number): number {
  let cur: unknown = r.properties;
  for (const key of path) {
    if (cur && typeof cur === "object" && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return fallback;
    }
  }
  return typeof cur === "number" ? cur : fallback;
}
