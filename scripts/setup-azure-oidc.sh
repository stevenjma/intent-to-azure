#!/usr/bin/env bash
# scripts/setup-azure-oidc.sh
#
# One-time BYO-Azure setup that lets the e2e workflow's OPTIONAL what-if gate
# authenticate to *your* Azure subscription via GitHub OIDC (no client secret stored).
#
# It creates an Entra app registration + service principal, federates it to this
# GitHub repo (pull_request + a branch ref), grants it Contributor on the target
# subscription, and sets the three repo VARIABLES the workflow reads:
#   AZURE_CLIENT_ID  AZURE_TENANT_ID  AZURE_SUBSCRIPTION_ID
#
# These are variables, not secrets — they are not sensitive. Deleting the app
# (az ad app delete) fully revokes access.
#
# Requirements: az CLI (logged in: `az login`), gh CLI (logged in: `gh auth login`),
# permission to create app registrations in your tenant and role assignments on the sub.
#
# Usage:
#   scripts/setup-azure-oidc.sh [--subscription <id>] [--branch <name>] [--name <appName>]
set -euo pipefail

APP_NAME="azx-e2e-oidc"
BRANCH="poc-1-dry-run-engine"
SUBSCRIPTION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --subscription) SUBSCRIPTION="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --name) APP_NAME="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
[[ -n "$SUBSCRIPTION" ]] || SUBSCRIPTION="$(az account show --query id -o tsv)"
TENANT="$(az account show --query tenantId -o tsv)"
ISSUER="https://token.actions.githubusercontent.com"
AUD="api://AzureADTokenExchange"

echo "repo=$REPO  subscription=$SUBSCRIPTION  tenant=$TENANT  branch=$BRANCH  app=$APP_NAME"

# App registration + SP (reuse if it already exists)
APP_ID="$(az ad app list --display-name "$APP_NAME" --query '[0].appId' -o tsv)"
if [[ -z "$APP_ID" ]]; then
  APP_ID="$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)"
  echo "created app $APP_ID"
else
  echo "reusing app $APP_ID"
fi
az ad sp show --id "$APP_ID" >/dev/null 2>&1 || az ad sp create --id "$APP_ID" >/dev/null

# Federated credentials: pull_request + branch ref
add_fic () {
  local name="$1" subject="$2"
  az ad app federated-credential create --id "$APP_ID" --parameters \
    "{\"name\":\"$name\",\"issuer\":\"$ISSUER\",\"subject\":\"$subject\",\"audiences\":[\"$AUD\"]}" \
    >/dev/null 2>&1 && echo "  + fic $name ($subject)" || echo "  = fic $name already present"
}
add_fic "gh-pull-request" "repo:${REPO}:pull_request"
add_fic "gh-branch-${BRANCH//\//-}" "repo:${REPO}:ref:refs/heads/${BRANCH}"

# RBAC: Contributor on the subscription (sandbox-friendly; narrow the scope if you prefer)
az role assignment create --assignee "$APP_ID" --role Contributor \
  --scope "/subscriptions/${SUBSCRIPTION}" >/dev/null 2>&1 \
  && echo "granted Contributor on /subscriptions/${SUBSCRIPTION}" \
  || echo "Contributor role assignment already present (or insufficient perms)"

# Repo variables the workflow reads
gh variable set AZURE_CLIENT_ID       -b "$APP_ID"
gh variable set AZURE_TENANT_ID       -b "$TENANT"
gh variable set AZURE_SUBSCRIPTION_ID -b "$SUBSCRIPTION"

echo
echo "Done. The e2e workflow's what-if gate will now run for compiling apps."
echo "Revoke anytime with:  az ad app delete --id $APP_ID"
