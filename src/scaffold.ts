/**
 * Stage [3a] scaffold — turn a resolved plan into a full, deployable repo tree.
 *
 * This is the bridge between the offline engine and a real deployment. It emits
 * the ENTIRE set of files a GitHub repo needs to deploy itself to Azure — the
 * generated Bicep AND the CI/CD pipeline that runs it — as plain in-memory files.
 *
 * Nothing here touches the network, git, or `gh`: `buildScaffold` is pure. The
 * files are inert until {@link ../ship.js} (`azx ship`) writes them into a real
 * repo and lets the committed workflow do the real `az deployment group create`.
 */

import type { AppIntent, AzurePlan, DeployLedger } from "./types.js";

/** A single file in the generated repo tree (POSIX-style relative path). */
export interface ScaffoldFile {
  /** Repo-relative path, always POSIX-separated (e.g. `.github/workflows/deploy.yml`). */
  path: string;
  /** Full file contents. */
  content: string;
}

export interface ScaffoldOptions {
  /** Target resource group name; defaults to `rg-<app-slug>`. */
  resourceGroup?: string;
  /** Override the deploy region; defaults to `plan.region`. */
  region?: string;
  /**
   * A local-deploy ledger (`.azx/deploy.json`) to adopt. When present, the
   * scaffold pins the same resource group + region so the codified pipeline's
   * first `what-if` is a provable no-op over what local deploy already created.
   */
  ledger?: DeployLedger;
  /** Injectable clock for deterministic output (tests pin this). */
  now?: () => Date;
}

/** Lowercase, hyphenated slug safe for resource-group / repo names. */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "app";
}

/** The resource-group name a plan deploys into (stable + slugified). */
export function resourceGroupFor(intent: AppIntent, opts: ScaffoldOptions = {}): string {
  return opts.resourceGroup ?? opts.ledger?.resourceGroup ?? `rg-${slugify(intent.app.name)}`;
}

/**
 * Build the full deployable repo tree for a resolved plan. Pure and offline.
 * Returns files sorted by path so callers (and goldens) get deterministic output.
 */
export function buildScaffold(
  intent: AppIntent,
  plan: AzurePlan,
  bicep: string,
  opts: ScaffoldOptions = {},
): ScaffoldFile[] {
  const region = opts.region ?? opts.ledger?.region ?? plan.region;
  const rg = resourceGroupFor(intent, opts);
  const needsPgPassword = plan.resources.some(
    (r) => r.type === "Microsoft.DBforPostgreSQL/flexibleServers",
  );

  const files: ScaffoldFile[] = [
    { path: "infra/main.bicep", content: bicep },
    { path: ".github/workflows/deploy.yml", content: deployWorkflow(rg, region, needsPgPassword) },
    { path: "README.md", content: readme(intent, plan, rg, region, needsPgPassword, opts.ledger) },
    { path: ".azx/plan.json", content: JSON.stringify({ intent, plan }, null, 2) + "\n" },
    { path: ".gitignore", content: gitignore() },
  ];

  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ---------------------------------------------------------------------------
// File templates
// ---------------------------------------------------------------------------

/**
 * The CI/CD pipeline. Two jobs:
 *   what-if  — OIDC login → ensure RG → `az deployment group what-if` (the gate)
 *   deploy   — needs: what-if, behind a `production` environment (approval gate)
 *              → the REAL `az deployment group create`
 *
 * Auth is GitHub OIDC federation: the three repo *variables* (not secrets)
 * AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_SUBSCRIPTION_ID are provisioned once
 * by scripts/setup-azure-oidc.(sh|ps1). No client secret is ever stored.
 */
function deployWorkflow(rg: string, region: string, needsPgPassword: boolean): string {
  const loginStep = [
    "      - name: Azure login (OIDC)",
    "        uses: azure/login@v2",
    "        with:",
    "          client-id: ${{ vars.AZURE_CLIENT_ID }}",
    "          tenant-id: ${{ vars.AZURE_TENANT_ID }}",
    "          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}",
  ];
  const ensureRg = [
    "      - name: Ensure resource group",
    '        run: az group create -n "$RESOURCE_GROUP" -l "$LOCATION" --only-show-errors -o none',
  ];
  // `az deployment` step body, parameterized by the az subcommand + name flag.
  const deployRun = (subcmd: string, nameFlag: string[]): string[] => {
    const runLines = [
      "        run: |",
      `          az deployment group ${subcmd} \\`,
      '            -g "$RESOURCE_GROUP" \\',
      ...nameFlag.map((l) => "            " + l),
      "            --template-file infra/main.bicep" + (needsPgPassword ? " \\" : ""),
    ];
    if (needsPgPassword) {
      runLines.push("            --parameters postgresAdminPassword=$PG_ADMIN_PASSWORD");
      runLines.push("        env:");
      runLines.push("          PG_ADMIN_PASSWORD: ${{ secrets.PG_ADMIN_PASSWORD }}");
    }
    return runLines;
  };

  const pgNote = needsPgPassword
    ? [
        "#",
        "# This template provisions PostgreSQL: add a repository *secret* named",
        "# PG_ADMIN_PASSWORD before deploying — it is passed as the admin password.",
      ]
    : [];

  return [
    "# deploy.yml — generated by azx `ship`.",
    "#",
    "# Real Azure deployment pipeline. Authenticates to Azure via GitHub OIDC",
    "# federation using the repository *variables* AZURE_CLIENT_ID / AZURE_TENANT_ID /",
    "# AZURE_SUBSCRIPTION_ID (provisioned once by scripts/setup-azure-oidc.(sh|ps1)).",
    "# No client secret is stored.",
    "#",
    "#   what-if  runs `az deployment group what-if` as a safety gate.",
    "#   deploy   waits on the `production` environment (add required reviewers in",
    "#            repo Settings -> Environments to gate the real deploy on approval),",
    "#            then runs the REAL `az deployment group create`.",
    ...pgNote,
    "",
    "name: deploy",
    "",
    "on:",
    "  push:",
    "    branches: [main]",
    "    paths:",
    "      - infra/**",
    "      - .github/workflows/deploy.yml",
    "  workflow_dispatch: {}",
    "",
    "permissions:",
    "  id-token: write   # OIDC token for azure/login",
    "  contents: read",
    "",
    "concurrency:",
    "  group: deploy-${{ github.ref }}",
    "  cancel-in-progress: false",
    "",
    "env:",
    `  RESOURCE_GROUP: ${rg}`,
    `  LOCATION: ${region}`,
    "",
    "jobs:",
    "  what-if:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "",
    ...loginStep,
    "",
    ...ensureRg,
    "",
    "      - name: What-if (preview changes, no writes)",
    ...deployRun("what-if", []),
    "",
    "  deploy:",
    "    needs: what-if",
    "    runs-on: ubuntu-latest",
    "    environment: production   # add required reviewers here to gate the real deploy",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "",
    ...loginStep,
    "",
    ...ensureRg,
    "",
    "      - name: Deploy (real Azure resources)",
    ...deployRun("create", ['--name "azx-${{ github.run_id }}" \\']),
    "",
  ].join("\n");
}

function readme(
  intent: AppIntent,
  plan: AzurePlan,
  rg: string,
  region: string,
  needsPgPassword: boolean,
  ledger?: DeployLedger,
): string {
  const resourceLines = plan.resources.map((r) => {
    const sku = r.sku ? ` [${r.sku}]` : "";
    const cost = r.estimatedMonthlyUsd ? ` — ~$${r.estimatedMonthlyUsd}/mo` : "";
    return `- **${r.service}**${sku} \`${r.name}\`${cost}`;
  });

  const cost = plan.budget
    ? `Estimated total: **~$${plan.budget.estimatedMonthlyUsd}/mo ${plan.budget.currency}**`
    : "";

  const secretStep = needsPgPassword
    ? [
        "3. Add a repository **secret** `PG_ADMIN_PASSWORD` (Settings → Secrets and",
        "   variables → Actions) — the PostgreSQL admin password for the real deploy.",
      ]
    : [];

  const adoptionNote = ledger
    ? [
        "## Adopting an existing local deploy",
        "",
        `This repo was codified from an imperative local deploy on **${ledger.deployedAt}**`,
        `(deployment \`${ledger.deploymentName}\`). It targets the **same** resource group`,
        `\`${ledger.resourceGroup}\` in \`${ledger.region}\`, so the pipeline's first`,
        "`what-if` should report **no changes** — proof the pipeline has cleanly taken",
        "ownership of the resources you already created, with nothing duplicated.",
        "",
      ]
    : [];

  return [
    `# ${intent.app.name}`,
    "",
    "> Infrastructure repo generated by **azx** (`azx ship`). The Bicep and the CI/CD",
    "> pipeline are committed here; the pipeline does the real Azure deploy via OIDC.",
    "",
    ...adoptionNote,
    "## What gets deployed",
    "",
    `Region: \`${region}\` · Resource group: \`${rg}\``,
    "",
    ...resourceLines,
    "",
    cost,
    "",
    "## How the pipeline deploys",
    "",
    "`.github/workflows/deploy.yml` runs on every push to `main` (and manual",
    "dispatch). It authenticates to Azure with **GitHub OIDC** — no client secret",
    "is stored — then:",
    "",
    "1. **what-if** — previews the change set (`az deployment group what-if`).",
    "2. **deploy** — waits on the `production` environment (add required reviewers",
    "   to gate on approval), then runs the real `az deployment group create`.",
    "",
    "## One-time setup",
    "",
    "1. Provision the federated identity + repo variables:",
    "",
    "   ```bash",
    "   scripts/setup-azure-oidc.sh        # or setup-azure-oidc.ps1 on Windows",
    "   ```",
    "",
    "   This sets the repo **variables** `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,",
    "   `AZURE_SUBSCRIPTION_ID` (not secrets — deleting the app fully revokes access).",
    "2. (Recommended) In Settings → Environments, add required reviewers to",
    "   `production` so the real deploy waits on a human approval.",
    ...secretStep,
    "",
    "Then push to `main` — or run the workflow manually — to deploy.",
    "",
    "---",
    "",
    "_The resolved App Intent and Azure plan are captured in `.azx/plan.json`._",
    "",
  ].join("\n");
}

function gitignore(): string {
  return ["node_modules/", "*.log", ".DS_Store", ""].join("\n");
}
