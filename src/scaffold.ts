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
  /** Application source repository for build/publish, in owner/repo form. */
  sourceRepository?: string;
  /** Immutable application commit analyzed by the hosted flow. */
  sourceRef?: string;
  /** Application directory relative to the source repository root. */
  sourcePath?: string;
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
  const hyphenated = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  let start = 0;
  let end = hyphenated.length;
  while (start < end && hyphenated[start] === "-") start++;
  while (end > start && hyphenated[end - 1] === "-") end--;
  const s = hyphenated.slice(start, end);
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
  const staticSite = plan.resources.find((resource) => resource.type === "Microsoft.Web/staticSites");
  const sourceRepository =
    opts.sourceRepository ?? (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(intent.app.root) ? intent.app.root : undefined);
  if (opts.sourceRef !== undefined && !/^[0-9a-f]{40}$/.test(opts.sourceRef)) {
    throw new Error("buildScaffold: sourceRef must be a full lowercase commit SHA.");
  }
  const sourcePath = opts.sourcePath ?? ".";
  if (
    sourcePath !== "." &&
    (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(sourcePath) ||
      sourcePath.split("/").some((part) => part === "." || part === ".."))
  ) {
    throw new Error("buildScaffold: sourcePath must be a safe repository-relative directory.");
  }
  if (staticSite && (!intent.app.packageManager || !intent.app.lockfile)) {
    throw new Error(
      "buildScaffold: static application delivery requires a supported lockfile " +
        "(package-lock.json, pnpm-lock.yaml, yarn.lock, or bun.lockb).",
    );
  }

  const files: ScaffoldFile[] = [
    { path: "infra/main.bicep", content: bicep },
    {
      path: ".github/workflows/deploy.yml",
      content: deployWorkflow(
        rg,
        region,
        needsPgPassword,
        staticSite?.name,
        sourceRepository,
        opts.sourceRef,
        sourcePath,
        intent.app.packageManager,
        intent.app.lockfile,
      ),
    },
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
 *   deploy   — manual dispatch only, needs: what-if, behind `production`
 *              → the REAL `az deployment group create`
 *
 * Auth is GitHub OIDC federation: the three repo *variables* (not secrets)
 * AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_SUBSCRIPTION_ID are provisioned once
 * by scripts/setup-azure-oidc.sh (shipped in this repo). No client secret is stored.
 */
function deployWorkflow(
  rg: string,
  region: string,
  needsPgPassword: boolean,
  staticSiteName?: string,
  sourceRepository?: string,
  sourceRef?: string,
  sourcePath = ".",
  packageManager?: AppIntent["app"]["packageManager"],
  lockfile?: string,
): string {
  const applicationDirectory = sourcePath === "." ? "application" : `application/${sourcePath}`;
  const loginStep = [
    "      - name: Azure login (OIDC)",
    "        uses: azure/login@8216e11d8cd9b42fe925c852af8e76311ff067ac # v2",
    "        with:",
    "          client-id: ${{ vars.AZURE_CLIENT_ID }}",
    "          tenant-id: ${{ vars.AZURE_TENANT_ID }}",
    "          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}",
  ];
  // Skip the whole run until OIDC is provisioned (AZURE_CLIENT_ID variable set by
  // scripts/setup-azure-oidc.sh). Without this, the first push — which lands before
  // OIDC can exist — fails `azure/login` and greets the user with a red-X run.
  const whatIfGuard =
    "    if: ${{ vars.AZURE_CLIENT_ID != '' && github.ref_name == github.event.repository.default_branch }}";
  const deployGuard =
    "    if: ${{ vars.AZURE_CLIENT_ID != '' && github.event_name == 'workflow_dispatch' && github.ref_name == github.event.repository.default_branch }}";
  // The @secure() Postgres password is written to a params file via `jq` (keeps it
  // off argv and immune to shell word-splitting), then referenced with @-file.
  const paramsStep = needsPgPassword
    ? [
        "      - name: Write secure parameters file",
        "        run: |",
        `          [ -n "$PG_ADMIN_PASSWORD" ] || { echo "::error::Set the PG_ADMIN_PASSWORD repository secret before deploying."; exit 1; }`,
        `          PARAMS_FILE="$(mktemp "$RUNNER_TEMP/azx-params.XXXXXX.json")"`,
        `          jq -n --arg p "$PG_ADMIN_PASSWORD" '{postgresAdminPassword:{value:$p}}' > "$PARAMS_FILE"`,
        "          chmod 600 \"$PARAMS_FILE\"",
        '          echo "PARAMS_FILE=$PARAMS_FILE" >> "$GITHUB_ENV"',
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
      runLines.push('            --parameters "@$PARAMS_FILE"');
    }
    return runLines;
  };
  const cleanupStep = needsPgPassword
    ? [
        "      - name: Remove secure parameters file",
        "        if: ${{ always() }}",
        '        run: rm -f "$PARAMS_FILE"',
      ]
    : [];

  const pgNote = needsPgPassword
    ? [
        "#",
        "# This template provisions PostgreSQL: add a repository *secret* named",
        "# PG_ADMIN_PASSWORD before deploying — it is passed as the admin password.",
      ]
    : [];
  const sourceNote = staticSiteName
    ? [
        "#",
        "# Static application delivery checks out the source repository, runs its locked",
        "# dependency install and build, verifies the `out/` export, then publishes that",
        "# exact directory. A failed export stops the workflow; it never changes hosting class.",
      ]
    : [];
  const staticPublish = staticSiteName
    ? [
        "",
        "  publish-static-app:",
        "    needs: deploy",
        deployGuard,
        "    runs-on: ubuntu-latest",
        "    environment: production",
        "    steps:",
        ...(!sourceRepository
          ? [
              "      - name: Require application source",
              "        if: ${{ vars.APP_SOURCE_REPOSITORY == '' }}",
              `        run: echo "::error::Set APP_SOURCE_REPOSITORY to the application owner/repo before deploying." && exit 1`,
            ]
          : []),
        "      - name: Check out application source",
        "        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4",
        "        with:",
        `          repository: ${sourceRepository ?? "${{ vars.APP_SOURCE_REPOSITORY }}"}`,
        ...(sourceRef ? [`          ref: ${sourceRef}`] : []),
        "          token: ${{ secrets.APP_SOURCE_TOKEN || github.token }}",
        "          path: application",
        ...(packageManager === "bun"
          ? [
              "      - name: Set up Bun",
              "        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2",
            ]
          : [
              "      - name: Set up Node.js",
              "        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4",
              "        with:",
              "          node-version: 22",
              ...(packageManager === "pnpm"
                ? []
                : [
                    `          cache: ${packageManager}`,
                    `          cache-dependency-path: ${applicationDirectory}/${lockfile}`,
                  ]),
              ...(packageManager === "pnpm" || packageManager === "yarn"
                ? ["      - name: Enable Corepack", "        run: corepack enable"]
                : []),
            ]),
        "      - name: Build and verify static export",
        `        working-directory: ${applicationDirectory}`,
        "        run: |",
        `          ${immutableInstall(packageManager)}`,
        `          ${buildCommand(packageManager)}`,
        `          [ -d out ] || { echo "::error::Next.js did not produce out/. Configure output: 'export' in next.config and regenerate only if server hosting is required."; exit 1; }`,
        "      - name: Azure login (OIDC)",
        "        uses: azure/login@8216e11d8cd9b42fe925c852af8e76311ff067ac # v2",
        "        with:",
        "          client-id: ${{ vars.AZURE_CLIENT_ID }}",
        "          tenant-id: ${{ vars.AZURE_TENANT_ID }}",
        "          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}",
        "      - name: Read Static Web Apps deployment token",
        "        id: swa-token",
        "        run: |",
        `          TOKEN="$(az rest --method post --url "https://management.azure.com/subscriptions/\${{ vars.AZURE_SUBSCRIPTION_ID }}/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.Web/staticSites/$STATIC_WEB_APP_NAME/listSecrets?api-version=2023-12-01" --query properties.apiKey -o tsv)"`,
        '          [ -n "$TOKEN" ] || { echo "::error::Azure returned no Static Web Apps deployment token."; exit 1; }',
        '          echo "::add-mask::$TOKEN"',
        '          echo "value=$TOKEN" >> "$GITHUB_OUTPUT"',
        "      - name: Publish verified static artifact",
        "        uses: Azure/static-web-apps-deploy@1a947af9992250f3bc2e68ad0754c0b0c11566c9 # v1",
        "        with:",
        "          azure_static_web_apps_api_token: ${{ steps.swa-token.outputs.value }}",
        "          action: upload",
        `          app_location: ${applicationDirectory}/out`,
        "          output_location: ''",
        "          skip_app_build: true",
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
    "#   deploy   runs only on explicit workflow_dispatch, after what-if, then waits",
    "#            on the `production` environment before the real create.",
    "#",
    "# The resource group is pre-created by scripts/setup-azure-oidc.sh and the OIDC",
    "# principal is scoped Contributor to THAT resource group only (not the whole",
    "# subscription), so neither job creates or manages resource groups.",
    "#",
    "# Jobs are guarded on AZURE_CLIENT_ID and the repository's actual default branch.",
    "# Pushes run preview only; real deployment always requires a manual workflow run.",
    ...pgNote,
    ...sourceNote,
    "",
    "name: deploy",
    "",
    "on:",
    "  push:",
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
    ...(staticSiteName ? [`  STATIC_WEB_APP_NAME: "${staticSiteName}"`] : []),
    ...(sourceRepository ? [`  APP_SOURCE_REPOSITORY: "${sourceRepository}"`] : []),
    "",
    "jobs:",
    "  what-if:",
    whatIfGuard,
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4",
    "",
    ...loginStep,
    "",
    ...paramsStep,
    "      - name: What-if (preview deployment changes)",
    ...deployRun("what-if", []),
    ...cleanupStep,
    ...staticPublish,
    "",
    "  deploy:",
    "    needs: what-if",
    deployGuard,
    "    runs-on: ubuntu-latest",
    "    environment: production",
    "    steps:",
    "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4",
    "",
    ...loginStep,
    "",
    ...paramsStep,
    "      - name: Deploy (real Azure resources)",
    ...deployRun("create", ['--name "azx-${{ github.run_id }}" \\']),
    ...cleanupStep,
    "",
  ].join("\n");
}

function immutableInstall(packageManager: AppIntent["app"]["packageManager"]): string {
  switch (packageManager) {
    case "npm":
      return "npm ci";
    case "pnpm":
      return "pnpm install --frozen-lockfile";
    case "yarn":
      return "yarn install --frozen-lockfile";
    case "bun":
      return "bun install --frozen-lockfile";
    default:
      throw new Error("deployWorkflow: unsupported package manager.");
  }
}

function buildCommand(packageManager: AppIntent["app"]["packageManager"]): string {
  return packageManager === "npm" ? "npm run build" : `${packageManager} run build`;
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
    const cost = r.estimatedMonthlyUsd ? ` — advisory ~$${r.estimatedMonthlyUsd}/mo` : " — usage-based/estimate unavailable";
    return `- **${r.service}**${sku} \`${r.name}\`${cost}`;
  });

  const cost = plan.budget
    ? `Advisory modeled total: **~$${plan.budget.estimatedMonthlyUsd}/mo ${plan.budget.currency}**. This is not a hard spend limit; usage charges can exceed it.`
    : "";
  const hasStaticSite = plan.resources.some((r) => r.type === "Microsoft.Web/staticSites");
  const hasContainerPlaceholder = plan.resources.some(
    (r) => r.type === "Microsoft.App/containerApps" || r.type === "Microsoft.App/jobs",
  );

  const secretStep = needsPgPassword
    ? [
        "- **PostgreSQL only:** add repository secret `PG_ADMIN_PASSWORD` (Settings → Secrets and",
        "   variables → Actions) — the PostgreSQL admin password for the real deploy.",
      ]
    : [];
  const staticSourceStep = hasStaticSite
    ? [
        "- **Static application source:** ensure `APP_SOURCE_REPOSITORY` identifies the",
        "  application `owner/repo` (the hosted flow sets this automatically). For a private",
        "  source repo, add `APP_SOURCE_TOKEN` with read access. Configure Next.js with",
        "  `output: 'export'`; CI fails with an actionable error if no `out/` directory is produced.",
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
    ...(hasStaticSite
      ? [
          "> For the static-hosting path, the workflow checks out the application repository,",
          "> verifies its real `out/` build artifact, and publishes that artifact to Static Web Apps.",
        ]
      : []),
    ...(hasContainerPlaceholder
      ? [
          "> **Incomplete application delivery:** container resources still use Microsoft placeholder",
          "> images. This repo provisions their infrastructure but does not claim to deploy the application.",
        ]
      : []),
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
    "## Handoff: review, connect Azure, deploy",
    "",
    "Creating this repo did **not** deploy anything to Azure. Use this sequence:",
    "",
    "1. Review the generated infrastructure pull request. Do not merge it yet.",
    "2. Clone this repo, check out the PR's `azx-infra` branch, then authenticate",
    "   with `az login` and `gh auth login`.",
    "3. While the PR is open, run the one-time setup:",
    "",
    "   ```bash",
    "   ./scripts/setup-azure-oidc.sh        # bash; on Windows use WSL, Git Bash, or Cloud Shell",
    "   ```",
    "",
    "   The script creates the federated identity, pre-creates the resource group,",
    "   grants Contributor at that resource-group scope only, and automatically sets",
    "   `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID` as repo",
    "   variables. It stores no Azure client secret.",
    "4. (Recommended) In Settings → Environments, add required reviewers to",
    "   `production` so the real deploy waits on a human approval.",
    "5. (Recommended) Protect the default branch (require PR review / restrict pushes). The what-if",
    "   job needs deploy-equivalent rights, so branch protection is the compensating",
    "   control that keeps the `main` credential from acting inside this resource group",
    "   without review.",
    ...secretStep,
    ...staticSourceStep,
    "",
    "6. Merge the PR. The merge runs ARM **what-if** only; inspect that workflow run.",
    "7. When the preview is acceptable, manually run the `deploy` workflow on the",
    "   default branch. It repeats what-if, then performs the real deployment.",
    "",
    "> Until setup is complete, `deploy.yml` skips safely because `AZURE_CLIENT_ID`",
    "> is absent. Later infrastructure changes on `main` trigger the same what-if and",
    "> preview automatically. Real deployment always requires a manual workflow run.",
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
 * the generated `deploy.yml` authenticates as — the repo's default branch (what-if job)
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
    "# default branch and `production` environment (the two subjects deploy.yml uses),",
    "# pre-creates the target resource group as YOU (the human running this), and",
    "# grants the principal Contributor scoped to THAT resource group only — not the",
    "# whole subscription. It then sets the repo VARIABLES the workflow reads:",
    "# AZURE_CLIENT_ID  AZURE_TENANT_ID  AZURE_SUBSCRIPTION_ID.",
    "#",
    "# Security note: `az deployment group what-if` needs deploy-equivalent rights, so",
    "# the what-if and deploy jobs share one RG-scoped principal. The `production`",
    "# manual workflow dispatch gates the real create, but a change to the default-branch workflow",
    "# could still act within this ONE resource group using the branch credential.",
    "# Protect the default branch (require PR review / restrict who can push) as the compensating",
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
    'DEFAULT_BRANCH="$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)"',
    '[[ -n "$DEFAULT_BRANCH" ]] || { echo "GitHub returned no default branch" >&2; exit 1; }',
    'OIDC_USE_DEFAULT="$(gh api "repos/${REPO}/actions/oidc/customization/sub" --jq .use_default)"',
    '[[ "$OIDC_USE_DEFAULT" == "true" ]] || { echo "custom GitHub OIDC subject templates are not supported" >&2; exit 1; }',
    'SUB_CLAIM_PREFIX="$(gh api "repos/${REPO}/actions/oidc/customization/sub" --jq .sub_claim_prefix)"',
    '[[ -n "$SUB_CLAIM_PREFIX" ]] || { echo "GitHub returned no OIDC subject prefix" >&2; exit 1; }',
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
    'echo "repo=$REPO  branch=$DEFAULT_BRANCH  subscription=$SUBSCRIPTION  tenant=$TENANT  rg=$RESOURCE_GROUP  app=$APP_NAME"',
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
    'add_fic "gh-default"    "${SUB_CLAIM_PREFIX}:ref:refs/heads/${DEFAULT_BRANCH}"',
    'add_fic "gh-production" "${SUB_CLAIM_PREFIX}:environment:production"',
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
    'echo "Done. Return to the open PR and merge it to run what-if. Deploy later with a manual workflow run."',
    'echo "Revoke with: az ad app delete --id $APP_ID"',
    "",
  ].join("\n");
}

function gitignore(): string {
  return ["node_modules/", "*.log", ".DS_Store", "azx.params.json", ""].join("\n");
}
