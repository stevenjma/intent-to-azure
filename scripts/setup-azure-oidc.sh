#!/usr/bin/env bash
# scripts/setup-azure-oidc.sh
#
# One-time BYO-Azure setup that lets the e2e workflow's OPTIONAL what-if gate
# authenticate to *your* Azure subscription via GitHub OIDC (no client secret stored).
#
# It creates an Entra app registration + service principal, federates it to this
# GitHub repo's trusted branch, creates persistent validation resource groups,
# grants Contributor only on those groups, and sets the repo VARIABLES:
#   E2E_AZURE_CLIENT_ID  E2E_AZURE_TENANT_ID  E2E_AZURE_SUBSCRIPTION_ID
#
# These are variables, not secrets — they are not sensitive. Deleting the app
# (az ad app delete) fully revokes access.
#
# Requirements: az CLI (logged in: `az login`), gh CLI (logged in: `gh auth login`),
# permission to create app registrations in your tenant and role assignments on the sub.
#
# Usage:
#   scripts/setup-azure-oidc.sh [--subscription <id>] [--branch <name>]
#                               [--name <appName>] [--app-id <existingAppId>]
set -euo pipefail

APP_NAME="azx-e2e-oidc"
APP_ID=""
BRANCH=""
SUBSCRIPTION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --subscription) SUBSCRIPTION="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --name) APP_NAME="$2"; shift 2 ;;
    --app-id) APP_ID="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
# Default the federated branch to the repo's actual default branch so the branch
# FIC subject matches real pushes. A hardcoded default silently no-ops for any repo
# whose default branch differs. Override with --branch.
[[ -n "$BRANCH" ]] || BRANCH="$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)"
[[ -n "$BRANCH" ]] || BRANCH="main"
[[ -n "$SUBSCRIPTION" ]] || SUBSCRIPTION="$(az account show --query id -o tsv)"
TENANT="$(az account show --query tenantId -o tsv)"
ISSUER="https://token.actions.githubusercontent.com"
AUD="api://AzureADTokenExchange"

echo "repo=$REPO  subscription=$SUBSCRIPTION  tenant=$TENANT  branch=$BRANCH  app=$APP_NAME"

# App registration + SP. Reuse must be explicit because display names are not unique
# and this script reconciles credentials and RBAC destructively.
if [[ -n "$APP_ID" ]]; then
  requested_app_id="$APP_ID"
  APP_ID="$(az ad app show --id "$APP_ID" --query appId -o tsv)"
  [[ -n "$APP_ID" ]] || { echo "app not found: $requested_app_id" >&2; exit 1; }
  echo "using existing app $APP_ID"
else
  matches="$(az ad app list --display-name "$APP_NAME" --query '[].appId' -o tsv)"
  if [[ -n "$matches" ]]; then
    echo "refusing implicit reuse of app named '$APP_NAME'; rerun with --app-id <id>" >&2
    echo "$matches" >&2
    exit 1
  fi
  APP_ID="$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)"
  echo "created app $APP_ID"
fi
az ad sp show --id "$APP_ID" >/dev/null 2>&1 || az ad sp create --id "$APP_ID" >/dev/null

# Reconcile federation to the trusted branch only. This also removes credentials
# created by older script versions, including pull_request trust.
TRUSTED_SUBJECT="repo:${REPO}:ref:refs/heads/${BRANCH}"
TRUSTED_CREDENTIAL_NAME="gh-branch-${BRANCH//\//-}"
credential_rows="$(az ad app federated-credential list --id "$APP_ID" \
  --query '[].[id,name,subject,issuer,audiences[0],length(audiences)]' -o tsv)"
while IFS=$'\t' read -r credential_id credential_name credential_subject credential_issuer credential_audience audience_count; do
  [[ -n "$credential_id" ]] || continue
  if [[ "$credential_name" != "$TRUSTED_CREDENTIAL_NAME" ||
        "$credential_subject" != "$TRUSTED_SUBJECT" ||
        "$credential_issuer" != "$ISSUER" ||
        "$credential_audience" != "$AUD" ||
        "$audience_count" != "1" ]]; then
    az ad app federated-credential delete --id "$APP_ID" \
      --federated-credential-id "$credential_id"
    echo "  - fic $credential_name ($credential_subject)"
  fi
done <<< "$credential_rows"

add_fic () {
  local name="$1" subject="$2"
  if [[ -n "$(az ad app federated-credential list --id "$APP_ID" \
    --query "[?name=='$name'].name | [0]" -o tsv)" ]]; then
    echo "  = fic $name already present"
    return
  fi
  for _ in 1 2 3 4 5 6; do
    if az ad app federated-credential create --id "$APP_ID" --parameters \
      "{\"name\":\"$name\",\"issuer\":\"$ISSUER\",\"subject\":\"$subject\",\"audiences\":[\"$AUD\"]}" \
      >/dev/null 2>&1; then
      echo "  + fic $name ($subject)"
      return
    fi
    sleep 5
  done
  echo "failed to create federated credential $name" >&2
  return 1
}
add_fic "$TRUSTED_CREDENTIAL_NAME" "$TRUSTED_SUBJECT"

# Remove the subscription-wide Contributor assignment created by older versions.
SUBSCRIPTION_SCOPE="/subscriptions/${SUBSCRIPTION}"
assignment_rows="$(az role assignment list --assignee "$APP_ID" --scope "$SUBSCRIPTION_SCOPE" \
  --query "[?roleDefinitionName=='Contributor'].[id,scope]" -o tsv)"
while IFS=$'\t' read -r assignment_id assignment_scope; do
  [[ -n "$assignment_id" ]] || continue
  if [[ "${assignment_scope,,}" == "${SUBSCRIPTION_SCOPE,,}" ]]; then
    az role assignment delete --ids "$assignment_id"
    echo "removed legacy Contributor on $assignment_scope"
  fi
done <<< "$assignment_rows"

ensure_contributor () {
  local scope="$1" assignment_id=""
  for _ in 1 2 3 4 5 6; do
    if az role assignment create --assignee "$APP_ID" --role Contributor \
      --scope "$scope" >/dev/null 2>&1; then
      :
    fi
    assignment_id="$(az role assignment list --assignee "$APP_ID" --scope "$scope" \
      --query "[?roleDefinitionName=='Contributor'].id | [0]" -o tsv)"
    if [[ -n "$assignment_id" ]]; then
      echo "verified Contributor on $scope"
      return
    fi
    sleep 5
  done
  echo "failed to grant Contributor on $scope" >&2
  return 1
}

# Persistent empty groups let CI run what-if without subscription-wide access.
for fixture in next-minimal next-prisma-postgres next-openai next-blob-storage; do
  rg="azx-e2e-$fixture"
  az group create --subscription "$SUBSCRIPTION" --name "$rg" --location eastus2 \
    --tags azx-e2e=1 >/dev/null
  scope="/subscriptions/${SUBSCRIPTION}/resourceGroups/${rg}"
  ensure_contributor "$scope"
done

# Repo variables the workflow reads
gh variable set E2E_AZURE_CLIENT_ID       -b "$APP_ID"
gh variable set E2E_AZURE_TENANT_ID       -b "$TENANT"
gh variable set E2E_AZURE_SUBSCRIPTION_ID -b "$SUBSCRIPTION"

echo
echo "Done. The e2e workflow's what-if gate will now run for compiling apps."
echo "Revoke anytime with:  az ad app delete --id $APP_ID"
