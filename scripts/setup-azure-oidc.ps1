<#
  scripts/setup-azure-oidc.ps1

  One-time BYO-Azure setup that lets the e2e workflow's OPTIONAL what-if gate
  authenticate to *your* Azure subscription via GitHub OIDC (no client secret stored).

  Creates an Entra app registration + service principal, federates it to this GitHub
  repo's trusted branch, creates four persistent validation resource groups, grants
  Contributor only on those groups,
  and sets the three repo VARIABLES the workflow reads:
    E2E_AZURE_CLIENT_ID  E2E_AZURE_TENANT_ID  E2E_AZURE_SUBSCRIPTION_ID

  These are variables, not secrets. Revoke fully with: az ad app delete --id <appId>

  Requirements: az CLI (az login), gh CLI (gh auth login), rights to create app
  registrations and role assignments.

  Usage:
    scripts/setup-azure-oidc.ps1 [-Subscription <id>] [-Branch <name>]
                                  [-Name <appName>] [-AppId <existingAppId>]
#>
[CmdletBinding()]
param(
  [string]$Subscription = "",
  [string]$Branch = "main",
  [string]$Name = "azx-e2e-oidc",
  [string]$AppId = ""
)
$ErrorActionPreference = "Stop"

$repo = gh repo view --json nameWithOwner -q .nameWithOwner
$oidcUseDefault = gh api "repos/$repo/actions/oidc/customization/sub" --jq .use_default
if ($LASTEXITCODE -ne 0 -or $oidcUseDefault -ne "true") {
  throw "custom GitHub OIDC subject templates are not supported by this setup script"
}
$subClaimPrefix = gh api "repos/$repo/actions/oidc/customization/sub" --jq .sub_claim_prefix
if ($LASTEXITCODE -ne 0 -or -not $subClaimPrefix) {
  throw "GitHub returned no OIDC subject prefix"
}
if (-not $Subscription) { $Subscription = az account show --query id -o tsv }
$tenant = az account show --query tenantId -o tsv
$issuer = "https://token.actions.githubusercontent.com"
$aud = "api://AzureADTokenExchange"

Write-Host "repo=$repo  subscription=$Subscription  tenant=$tenant  branch=$Branch  app=$Name"

# App registration + SP. Reuse must be explicit because display names are not unique
# and this script reconciles credentials and RBAC destructively.
if ($AppId) {
  $appId = az ad app show --id $AppId --query appId -o tsv
  if ($LASTEXITCODE -ne 0 -or -not $appId) { throw "app not found: $AppId" }
  Write-Host "using existing app $appId"
} else {
  $matches = @(az ad app list --display-name $Name --query '[].appId' -o tsv)
  if ($LASTEXITCODE -ne 0) { throw "failed to check for existing apps named $Name" }
  if ($matches.Count -gt 0) {
    throw "refusing implicit reuse of app named '$Name'; rerun with -AppId <id>"
  }
  $appId = az ad app create --display-name $Name --query appId -o tsv
  if ($LASTEXITCODE -ne 0 -or -not $appId) { throw "failed to create app $Name" }
  Write-Host "created app $appId"
}
az ad sp show --id $appId 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { az ad sp create --id $appId | Out-Null }

# Reconcile federation to the trusted branch only. This also removes credentials
# created by older script versions, including pull_request trust.
$trustedSubject = "${subClaimPrefix}:ref:refs/heads/$Branch"
$trustedCredentialName = "gh-branch-" + ($Branch -replace '/','-')
$credentials = az ad app federated-credential list --id $appId -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "failed to list federated credentials" }
foreach ($credential in @($credentials)) {
  $audiences = @($credential.audiences)
  if ($credential.name -ne $trustedCredentialName -or
      $credential.subject -ne $trustedSubject -or
      $credential.issuer -ne $issuer -or
      $audiences.Count -ne 1 -or
      $audiences[0] -ne $aud) {
    az ad app federated-credential delete --id $appId --federated-credential-id $credential.id
    if ($LASTEXITCODE -ne 0) {
      throw "failed to remove federated credential $($credential.name)"
    }
    Write-Host "  - fic $($credential.name) ($($credential.subject))"
  }
}

function Add-Fic($ficName, $subject) {
  $existing = az ad app federated-credential list --id $appId --query "[?name=='$ficName'].name | [0]" -o tsv
  if ($existing) {
    Write-Host "  = fic $ficName already present"
    return
  }
  $p = Join-Path $env:TEMP "azx-fic-$ficName.json"
  $json = @{
    name = $ficName
    issuer = $issuer
    subject = $subject
    audiences = @($aud)
  } | ConvertTo-Json -Compress
  $utf8NoBom = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($p, $json, $utf8NoBom)
  foreach ($attempt in 1..6) {
    az ad app federated-credential create --id $appId --parameters $p 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Remove-Item $p -Force
      Write-Host "  + fic $ficName ($subject)"
      return
    }
    Start-Sleep -Seconds 5
  }
  Remove-Item $p -Force
  throw "failed to create federated credential $ficName"
}
Add-Fic $trustedCredentialName $trustedSubject

# Remove the subscription-wide Contributor assignment created by older versions.
$subscriptionScope = "/subscriptions/$Subscription"
$assignments = az role assignment list --assignee $appId --scope $subscriptionScope -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "failed to list role assignments" }
foreach ($assignment in @($assignments)) {
  if ($assignment.roleDefinitionName -eq "Contributor" -and $assignment.scope -ieq $subscriptionScope) {
    az role assignment delete --ids $assignment.id
    if ($LASTEXITCODE -ne 0) {
      throw "failed to remove legacy Contributor assignment $($assignment.id)"
    }
    Write-Host "removed legacy Contributor on $($assignment.scope)"
  }
}

function Grant-Contributor($scope) {
  foreach ($attempt in 1..6) {
    az role assignment create --assignee $appId --role Contributor --scope $scope 2>$null | Out-Null
    $assignmentId = az role assignment list --assignee $appId --scope $scope `
      --query "[?roleDefinitionName=='Contributor'].id | [0]" -o tsv 2>$null
    if ($LASTEXITCODE -eq 0 -and $assignmentId) {
      Write-Host "verified Contributor on $scope"
      return
    }
    Start-Sleep -Seconds 5
  }
  throw "failed to grant Contributor on $scope"
}

# Persistent empty groups let CI run what-if without subscription-wide access.
foreach ($fixture in @("next-minimal", "next-prisma-postgres", "next-openai", "next-blob-storage")) {
  $rg = "azx-e2e-$fixture"
  az group create --subscription $Subscription --name $rg --location eastus2 --tags azx-e2e=1 | Out-Null
  $scope = "/subscriptions/$Subscription/resourceGroups/$rg"
  Grant-Contributor $scope
}

# Repo variables the workflow reads
gh variable set E2E_AZURE_CLIENT_ID       -b $appId
gh variable set E2E_AZURE_TENANT_ID       -b $tenant
gh variable set E2E_AZURE_SUBSCRIPTION_ID -b $Subscription

Write-Host ""
Write-Host "Done. The e2e workflow's what-if gate will now run for compiling apps."
Write-Host "Revoke anytime with:  az ad app delete --id $appId"
