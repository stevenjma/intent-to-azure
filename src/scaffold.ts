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
import { planNeedsPgPassword } from "./az-deploy.js";

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
  const needsPgPassword = planNeedsPgPassword(plan);

  const files: ScaffoldFile[] = [
    { path: "infra/main.bicep", content: bicep },
    { path: ".github/workflows/deploy.yml", content: deployWorkflow(rg, region, needsPgPassword) },
    { path: "README.md", content: readme(intent, plan, rg, region, needsPgPassword, opts.ledger) },
    { path: ".azx/plan.json", content: JSON.stringify({ intent, plan }, null, 2) + "\n" },
    { path: "scripts/setup-azure-oidc.sh", content: oidcSetupScript() },
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
 * by scripts/setup-azure-oidc.sh (shipped in this repo). No client secret is stored.
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
  // The @secure() Postgres password is written to a params file via `jq` (keeps it
  // off argv and immune to shell word-splitting), then referenced with @-file.
  const paramsStep = needsPgPassword
    ? [
        "      - name: Write secure parameters file",
        "        run: |",
        `          jq -n --arg p "$PG_ADMIN_PASSWORD" '{postgresAdminPassword:{value:$p}}' > azx.params.json`,
        "        env:",
        "          PG_ADMIN_PASSWORD: ${{ secrets.PG_ADMIN_PASSWORD }}",
        "",
      ]
    : [];
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
      runLines.push("            --parameters @azx.params.json");
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
    "# AZURE_SUBSCRIPTION_ID (provisioned once by scripts/setup-azure-oidc.sh, shipped",
    "# in this repo). No client secret is stored.",
    "#",
    "#   what-if  runs `az deployment group what-if` (after ensuring the RG) as a gate.",
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
    ...paramsStep,
    "      - name: What-if (preview deployment changes)",
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
    ...paramsStep,
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
        "`what-if` should typically report **no infrastructure changes** — the pipeline is",
        "taking ownership of the resources you already created rather than duplicating them.",
        "",
        "> The no-op holds only if the plan still resolves to the same template and the",
        "> `PG_ADMIN_PASSWORD` secret (if any) matches the password used in the local",
        "> deploy. A `@secure()` parameter can still surface as a change in what-if — review",
        "> the first run before approving the `production` deploy.",
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
    "1. From this repo (after it exists on GitHub and you have `az login` + `gh auth",
    "   login`), provision the federated identity + repo variables:",
    "",
    "   ```bash",
    "   ./scripts/setup-azure-oidc.sh        # bash; on Windows use WSL, Git Bash, or Cloud Shell",
    "   ```",
    "",
    "   It federates this repo's `main` branch and `production` environment to a new",
    "   Entra app and sets the repo **variables** `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,",
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

/**
 * A self-contained, repo-parameterized OIDC bootstrap shipped INTO the generated
 * repo. Unlike azx's own dev-repo e2e script, this federates the exact two subjects
 * the generated `deploy.yml` authenticates as — `ref:refs/heads/main` (what-if job)
 * and `environment:production` (deploy job) — for whichever repo it is run inside.
 */
function oidcSetupScript(): string {
  return [
    "#!/usr/bin/env bash",
    "# scripts/setup-azure-oidc.sh — generated by azx `ship`.",
    "#",
    "# One-time BYO-Azure setup so this repo's deploy.yml can authenticate to your",
    "# Azure subscription via GitHub OIDC (no client secret stored). Run it from a",
    "# clone of THIS repo, after `az login` and `gh auth login`.",
    "#",
    "# It creates an Entra app + service principal, federates it to this repo's",
    "# `main` branch and `production` environment (the two subjects deploy.yml uses),",
    "# grants Contributor on the subscription, and sets the repo VARIABLES the",
    "# workflow reads: AZURE_CLIENT_ID  AZURE_TENANT_ID  AZURE_SUBSCRIPTION_ID.",
    "#",
    "# Requirements: az CLI (logged in), gh CLI (logged in), permission to create app",
    "# registrations in your tenant and role assignments on the subscription.",
    "#",
    "# Usage: ./scripts/setup-azure-oidc.sh [--subscription <id>] [--name <appName>]",
    "set -euo pipefail",
    "",
    'SUBSCRIPTION=""',
    'APP_NAME=""',
    "while [[ $# -gt 0 ]]; do",
    "  case \"$1\" in",
    "    --subscription) SUBSCRIPTION=\"$2\"; shift 2 ;;",
    "    --name) APP_NAME=\"$2\"; shift 2 ;;",
    "    *) echo \"unknown arg: $1\" >&2; exit 2 ;;",
    "  esac",
    "done",
    "",
    'REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"',
    '[[ -n "$APP_NAME" ]] || APP_NAME="oidc-${REPO//\\//-}"',
    '[[ -n "$SUBSCRIPTION" ]] || SUBSCRIPTION="$(az account show --query id -o tsv)"',
    'TENANT="$(az account show --query tenantId -o tsv)"',
    'ISSUER="https://token.actions.githubusercontent.com"',
    'AUD="api://AzureADTokenExchange"',
    "",
    'echo "repo=$REPO  subscription=$SUBSCRIPTION  tenant=$TENANT  app=$APP_NAME"',
    "",
    "# App registration + service principal (reuse if present).",
    "APP_ID=\"$(az ad app list --display-name \"$APP_NAME\" --query '[0].appId' -o tsv)\"",
    'if [[ -z "$APP_ID" ]]; then',
    '  APP_ID="$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)"',
    '  echo "created app $APP_ID"',
    "else",
    '  echo "reusing app $APP_ID"',
    "fi",
    'az ad sp show --id "$APP_ID" >/dev/null 2>&1 || az ad sp create --id "$APP_ID" >/dev/null',
    'SP_OID="$(az ad sp show --id "$APP_ID" --query id -o tsv)"',
    '[[ -n "$SP_OID" ]] || { echo "could not resolve service principal object id" >&2; exit 1; }',
    "",
    "# Federated credentials for the two subjects deploy.yml authenticates as.",
    "add_fic () {",
    '  local name="$1" subject="$2"',
    '  az ad app federated-credential create --id "$APP_ID" --parameters \\',
    '    "{\\"name\\":\\"$name\\",\\"issuer\\":\\"$ISSUER\\",\\"subject\\":\\"$subject\\",\\"audiences\\":[\\"$AUD\\"]}" \\',
    '    >/dev/null 2>&1 && echo "  + fic $name ($subject)" || echo "  = fic $name already present"',
    "}",
    'add_fic "gh-main"       "repo:${REPO}:ref:refs/heads/main"',
    'add_fic "gh-production" "repo:${REPO}:environment:production"',
    "",
    "# RBAC: Contributor on the subscription (narrow the scope if you prefer). Assign by",
    "# object id + principal type (skips the Graph lookup that races a fresh SP) and retry",
    "# to ride out Entra replication; only an existing assignment is treated as success.",
    "assign_contributor () {",
    '  local scope="/subscriptions/${SUBSCRIPTION}" out i',
    "  for i in 1 2 3 4 5 6; do",
    '    if out="$(az role assignment create --assignee-object-id "$SP_OID" \\',
    '      --assignee-principal-type ServicePrincipal --role Contributor --scope "$scope" 2>&1)"; then',
    '      echo "granted Contributor on $scope"; return 0',
    "    fi",
    "    if grep -qiE 'RoleAssignmentExists|already exists' <<<\"$out\"; then",
    '      echo "Contributor already assigned on $scope"; return 0',
    "    fi",
    '    echo "  role assignment attempt $i failed (SP may still be replicating); retrying in 10s..." >&2',
    "    sleep 10",
    "  done",
    '  echo "ERROR: could not assign Contributor on $scope after retries:" >&2',
    '  echo "$out" >&2',
    "  return 1",
    "}",
    "assign_contributor",
    "",
    "# Repo variables the workflow reads.",
    'gh variable set AZURE_CLIENT_ID       -b "$APP_ID"',
    'gh variable set AZURE_TENANT_ID       -b "$TENANT"',
    'gh variable set AZURE_SUBSCRIPTION_ID -b "$SUBSCRIPTION"',
    "",
    'echo',
    'echo "Done. Push to main (or run the workflow) to deploy. Revoke with: az ad app delete --id $APP_ID"',
    "",
  ].join("\n");
}

function gitignore(): string {
  return ["node_modules/", "*.log", ".DS_Store", "azx.params.json", ""].join("\n");
}
