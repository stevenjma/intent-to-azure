<#
  scripts/setup-azure-oidc.ps1

  One-time BYO-Azure setup that lets the e2e workflow's OPTIONAL what-if gate
  authenticate to *your* Azure subscription via GitHub OIDC (no client secret stored).

  Creates an Entra app registration + service principal, federates it to this GitHub
  repo (pull_request + a branch ref), grants Contributor on the target subscription,
  and sets the three repo VARIABLES the workflow reads:
    AZURE_CLIENT_ID  AZURE_TENANT_ID  AZURE_SUBSCRIPTION_ID

  These are variables, not secrets. Revoke fully with: az ad app delete --id <appId>

  Requirements: az CLI (az login), gh CLI (gh auth login), rights to create app
  registrations and role assignments.

  Usage:
    scripts/setup-azure-oidc.ps1 [-Subscription <id>] [-Branch <name>] [-Name <appName>]
#>
[CmdletBinding()]
param(
  [string]$Subscription = "",
  [string]$Branch = "poc-1-dry-run-engine",
  [string]$Name = "azx-e2e-oidc"
)
$ErrorActionPreference = "Stop"

$repo = gh repo view --json nameWithOwner -q .nameWithOwner
if (-not $Subscription) { $Subscription = az account show --query id -o tsv }
$tenant = az account show --query tenantId -o tsv
$issuer = "https://token.actions.githubusercontent.com"
$aud = "api://AzureADTokenExchange"

Write-Host "repo=$repo  subscription=$Subscription  tenant=$tenant  branch=$Branch  app=$Name"

# App registration + SP (reuse if present)
$appId = az ad app list --display-name $Name --query '[0].appId' -o tsv
if (-not $appId) {
  $appId = az ad app create --display-name $Name --query appId -o tsv
  Write-Host "created app $appId"
} else {
  Write-Host "reusing app $appId"
}
az ad sp show --id $appId 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { az ad sp create --id $appId | Out-Null }

function Add-Fic($ficName, $subject) {
  $p = "{`"name`":`"$ficName`",`"issuer`":`"$issuer`",`"subject`":`"$subject`",`"audiences`":[`"$aud`"]}"
  az ad app federated-credential create --id $appId --parameters $p 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host "  + fic $ficName ($subject)" } else { Write-Host "  = fic $ficName already present" }
}
Add-Fic "gh-pull-request" "repo:${repo}:pull_request"
Add-Fic ("gh-branch-" + ($Branch -replace '/','-')) "repo:${repo}:ref:refs/heads/$Branch"

# RBAC: Contributor on the subscription (narrow the scope if you prefer)
az role assignment create --assignee $appId --role Contributor --scope "/subscriptions/$Subscription" 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Host "granted Contributor on /subscriptions/$Subscription" } else { Write-Host "Contributor role assignment already present (or insufficient perms)" }

# Repo variables the workflow reads
gh variable set AZURE_CLIENT_ID       -b $appId
gh variable set AZURE_TENANT_ID       -b $tenant
gh variable set AZURE_SUBSCRIPTION_ID -b $Subscription

Write-Host ""
Write-Host "Done. The e2e workflow's what-if gate will now run for compiling apps."
Write-Host "Revoke anytime with:  az ad app delete --id $appId"
