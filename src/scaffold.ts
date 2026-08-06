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
import { planNeedsPgPassword } from "./plan.js";
import { isDeployLedger, REGION_RE, RESOURCE_GROUP_RE, SUBSCRIPTION_ID_RE } from "./ledger-core.js";

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
   * Pin the subscription baked into the OIDC setup script's `DEFAULT_SUBSCRIPTION`.
   * Defaults to the adopted ledger's subscription. Set explicitly only on the
   * recovery path (unreadable ledger + operator-asserted `--subscription-id`) so the
   * generated setup script targets the operator's subscription, not `az`'s current
   * account. Validated against `SUBSCRIPTION_ID_RE` before it reaches the script.
   */
  subscriptionId?: string;
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
  // Defend the sink, not just the CLI read boundary: RG/region/subscription get baked
  // verbatim into generated bash + YAML, so re-assert the same contract here. A CLI
  // ledger already passed loadLedger, but a library caller (or a future `--ledger`/
  // remote adoption path) could hand us a raw object or a hostile override — this
  // makes the generator itself refuse to emit an injectable artifact.
  if (opts.ledger !== undefined && !isDeployLedger(opts.ledger)) {
    throw new Error("buildScaffold: refusing to generate from an invalid deploy ledger.");
  }
  if (!RESOURCE_GROUP_RE.test(rg)) {
    throw new Error(`buildScaffold: unsafe resource group "${rg}" — refusing to generate.`);
  }
  if (!REGION_RE.test(region)) {
    throw new Error(`buildScaffold: unsafe region "${region}" — refusing to generate.`);
  }
  // The subscription is baked into the generated OIDC setup script; an explicit
  // recovery override (or a hostile ledger reaching a library caller) must still be
  // a canonical GUID before it reaches that shell sink.
  const subscriptionId = opts.subscriptionId ?? opts.ledger?.subscriptionId;
  if (subscriptionId !== undefined && !SUBSCRIPTION_ID_RE.test(subscriptionId)) {
    throw new Error(`buildScaffold: unsafe subscription "${subscriptionId}" — refusing to generate.`);
  }
  const needsPgPassword = planNeedsPgPassword(plan);

  const files: ScaffoldFile[] = [
    { path: "infra/main.bicep", content: bicep },
    { path: ".github/workflows/deploy.yml", content: deployWorkflow(rg, region, needsPgPassword) },
    { path: "README.md", content: readme(intent, plan, rg, region, needsPgPassword, opts.ledger) },
    { path: ".azx/plan.json", content: JSON.stringify({ intent, plan }, null, 2) + "\n" },
    {
      path: "scripts/setup-azure-oidc.sh",
      content: oidcSetupScript(rg, region, subscriptionId),
    },
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
  // Skip the whole run until OIDC is provisioned (AZURE_CLIENT_ID variable set by
  // scripts/setup-azure-oidc.sh). Without this, the first push — which lands before
  // OIDC can exist — fails `azure/login` and greets the user with a red-X run.
  const oidcGuard = "    if: ${{ vars.AZURE_CLIENT_ID != '' }}";
  // The @secure() Postgres password is written to a params file via `jq` (keeps it
  // off argv and immune to shell word-splitting), then referenced with @-file.
  const paramsStep = needsPgPassword
    ? [
        "      - name: Write secure parameters file",
        "        run: |",
        `          [ -n "$PG_ADMIN_PASSWORD" ] || { echo "::error::Set the PG_ADMIN_PASSWORD repository secret before deploying."; exit 1; }`,
        `          jq -n --arg p "$PG_ADMIN_PASSWORD" '{postgresAdminPassword:{value:$p}}' > azx.params.json`,
        "          chmod 600 azx.params.json",
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
    "#   what-if  runs `az deployment group what-if` to preview the change set.",
    "#            `deploy` needs it, so a failed what-if blocks the deploy.",
    "#   deploy   waits on the `production` environment (add required reviewers in",
    "#            repo Settings -> Environments to gate the real deploy on approval),",
    "#            then runs the REAL `az deployment group create`.",
    "#",
    "# The resource group is pre-created by scripts/setup-azure-oidc.sh and the OIDC",
    "# principal is scoped Contributor to THAT resource group only (not the whole",
    "# subscription), so neither job creates or manages resource groups.",
    "#",
    "# Both jobs are guarded on the AZURE_CLIENT_ID variable, so runs cleanly SKIP until",
    "# scripts/setup-azure-oidc.sh has provisioned OIDC — the first push won't red-X.",
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
    `  RESOURCE_GROUP: "${rg}"`,
    `  LOCATION: "${region}"`,
    "",
    "jobs:",
    "  what-if:",
    oidcGuard,
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "",
    ...loginStep,
    "",
    ...paramsStep,
    "      - name: What-if (preview deployment changes)",
    ...deployRun("what-if", []),
    "",
    "  deploy:",
    "    needs: what-if",
    oidcGuard,
    "    runs-on: ubuntu-latest",
    "    environment: production   # add required reviewers here to gate the real deploy",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "",
    ...loginStep,
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
    ? ledger.partial
      ? [
          "## Adopting a PARTIAL local deploy",
          "",
          `> ⚠️ This repo was codified from a local deploy on **${ledger.deployedAt}**`,
          `> (deployment \`${ledger.deploymentName}\`) that **failed partway**. Some`,
          `> resources in \`${ledger.resourceGroup}\` (\`${ledger.region}\`) may be missing,`,
          "> so the pipeline's first `what-if` **will show creates** — that is expected, it",
          "> finishes what the local deploy started. Review the first run carefully before",
          "> approving the `production` deploy.",
          "",
        ]
      : [
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
    "> Until you finish this setup, `deploy.yml` **skips** every run (it's guarded on",
    "> `AZURE_CLIENT_ID`), so the initial push won't produce a failed workflow run.",
    "",
    "1. From this repo (after it exists on GitHub and you have `az login` + `gh auth",
    "   login`), provision the federated identity + repo variables:",
    "",
    "   ```bash",
    "   ./scripts/setup-azure-oidc.sh        # bash; on Windows use WSL, Git Bash, or Cloud Shell",
    "   ```",
    "",
    "   It refuses to silently reuse an Entra app that already matches the display",
    "   name (reusing one can inherit stale credentials/roles). To reuse an app on",
    "   purpose pass `--app-id <appId>`; to force a fresh app pass `--name <uniqueName>`.",
    "",
    "   It federates this repo's `main` branch and `production` environment to a new",
    "   Entra app, **pre-creates the resource group** and grants the app Contributor",
    "   **scoped to that resource group only** (not the whole subscription), and sets",
    "   the repo **variables** `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,",
    "   `AZURE_SUBSCRIPTION_ID` (not secrets — deleting the app fully revokes access).",
    "2. (Recommended) In Settings → Environments, add required reviewers to",
    "   `production` so the real deploy waits on a human approval.",
    "3. (Recommended) Protect `main` (require PR review / restrict pushes). The what-if",
    "   job needs deploy-equivalent rights, so branch protection is the compensating",
    "   control that keeps the `main` credential from acting inside this resource group",
    "   without review.",
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
function oidcSetupScript(rg: string, region: string, subscriptionId?: string): string {
  const defaultSub = subscriptionId ?? "";
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
    "# pre-creates the target resource group as YOU (the human running this), and",
    "# grants the principal Contributor scoped to THAT resource group only — not the",
    "# whole subscription. It then sets the repo VARIABLES the workflow reads:",
    "# AZURE_CLIENT_ID  AZURE_TENANT_ID  AZURE_SUBSCRIPTION_ID.",
    "#",
    "# Security note: `az deployment group what-if` needs deploy-equivalent rights, so",
    "# the what-if and deploy jobs share one RG-scoped principal. The `production`",
    "# environment approval gates the real create, but a change to the `main` workflow",
    "# could still act within this ONE resource group using the branch credential.",
    "# Protect `main` (require PR review / restrict who can push) as the compensating",
    "# control, and keep this repo's resource group dedicated to this app.",
    "#",
    "# Requirements: az CLI (logged in), gh CLI (logged in), permission to create app",
    "# registrations in your tenant and role assignments on the subscription.",
    "#",
    "# Usage: ./scripts/setup-azure-oidc.sh [--subscription <id>] [--name <appName>] [--app-id <appId>]",
    "set -euo pipefail",
    "",
    "# Baked in by azx `ship` from your resolved plan / deploy ledger.",
    `RESOURCE_GROUP="${rg}"`,
    `LOCATION="${region}"`,
    `DEFAULT_SUBSCRIPTION="${defaultSub}"`,
    "",
    'SUBSCRIPTION=""',
    'APP_NAME=""',
    'APP_ID_ARG=""',
    "while [[ $# -gt 0 ]]; do",
    "  case \"$1\" in",
    "    --subscription) SUBSCRIPTION=\"$2\"; shift 2 ;;",
    "    --name) APP_NAME=\"$2\"; shift 2 ;;",
    "    --app-id) APP_ID_ARG=\"$2\"; shift 2 ;;",
    "    *) echo \"unknown arg: $1\" >&2; exit 2 ;;",
    "  esac",
    "done",
    "",
    'REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"',
    '[[ -n "$APP_NAME" ]] || APP_NAME="oidc-${REPO//\\//-}"',
    '[[ -n "$SUBSCRIPTION" ]] || SUBSCRIPTION="$DEFAULT_SUBSCRIPTION"',
    '[[ -n "$SUBSCRIPTION" ]] || SUBSCRIPTION="$(az account show --query id -o tsv)"',
    "# Pin every subsequent az call to the intended subscription so the resource group",
    "# and role assignment cannot land in whatever account happens to be current.",
    'az account set --subscription "$SUBSCRIPTION"',
    'TENANT="$(az account show --query tenantId -o tsv)"',
    'ISSUER="https://token.actions.githubusercontent.com"',
    'AUD="api://AzureADTokenExchange"',
    "",
    'echo "repo=$REPO  subscription=$SUBSCRIPTION  tenant=$TENANT  rg=$RESOURCE_GROUP  app=$APP_NAME"',
    "",
    "# App registration + service principal.",
    "# Reusing an existing Entra app can silently inherit whatever roles/credentials it",
    "# already holds, undercutting the RG-scoped least-privilege this script sets up. So",
    "# we refuse to reuse an app found merely by display name: reuse must be explicit via",
    "# --app-id, otherwise we create a fresh app (or fail if the name already collides).",
    'if [[ -n "$APP_ID_ARG" ]]; then',
    '  APP_ID="$APP_ID_ARG"',
    '  az ad app show --id "$APP_ID" >/dev/null 2>&1 || { echo "app --app-id $APP_ID not found" >&2; exit 1; }',
    '  echo "reusing app $APP_ID (explicit --app-id)"',
    "else",
    "  EXISTING_IDS=\"$(az ad app list --display-name \"$APP_NAME\" --query '[].appId' -o tsv)\"",
    '  if [[ -n "$EXISTING_IDS" ]]; then',
    '    echo "refusing to reuse an existing app named \\"$APP_NAME\\":" >&2',
    '    echo "$EXISTING_IDS" | sed "s/^/  appId: /" >&2',
    '    echo "Re-run with --app-id <appId> to reuse one intentionally, or --name <uniqueName> to create a fresh app." >&2',
    "    exit 1",
    "  fi",
    '  APP_ID="$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)"',
    '  echo "created app $APP_ID"',
    "fi",
    'az ad sp show --id "$APP_ID" >/dev/null 2>&1 || az ad sp create --id "$APP_ID" >/dev/null',
    'SP_OID="$(az ad sp show --id "$APP_ID" --query id -o tsv)"',
    '[[ -n "$SP_OID" ]] || { echo "could not resolve service principal object id" >&2; exit 1; }',
    "",
    "# Federated credentials for the two subjects deploy.yml authenticates as.",
    "add_fic () {",
    '  local name="$1" subject="$2" out',
    '  if out="$(az ad app federated-credential create --id "$APP_ID" --parameters \\',
    '    "{\\"name\\":\\"$name\\",\\"issuer\\":\\"$ISSUER\\",\\"subject\\":\\"$subject\\",\\"audiences\\":[\\"$AUD\\"]}" 2>&1)"; then',
    '    echo "  + fic $name ($subject)"',
    "  elif grep -qiE 'FederatedIdentityCredentialWithSameNameExists|already exists' <<<\"$out\"; then",
    '    echo "  = fic $name already present"',
    "  else",
    '    echo "ERROR: could not create federated credential $name:" >&2',
    '    echo "$out" >&2',
    "    exit 1",
    "  fi",
    "}",
    'add_fic "gh-main"       "repo:${REPO}:ref:refs/heads/main"',
    'add_fic "gh-production" "repo:${REPO}:environment:production"',
    "",
    "# Pre-create the resource group as YOU (full rights), so the pipeline principal can",
    "# be scoped to just this RG below rather than the whole subscription. This is also",
    "# why deploy.yml no longer runs `az group create` — its principal can't.",
    'az group create -n "$RESOURCE_GROUP" -l "$LOCATION" --only-show-errors -o none',
    'echo "ensured resource group $RESOURCE_GROUP ($LOCATION)"',
    "",
    "# RBAC: Contributor scoped to THIS resource group only (least privilege). Assign by",
    "# object id + principal type (skips the Graph lookup that races a fresh SP) and retry",
    "# to ride out Entra replication; only an existing assignment is treated as success.",
    "assign_contributor () {",
    '  local scope="/subscriptions/${SUBSCRIPTION}/resourceGroups/${RESOURCE_GROUP}" out i',
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
