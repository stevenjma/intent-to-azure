#!/usr/bin/env bash
# Guard against internal npm feed hosts or committed auth material leaking into
# any tracked package-lock.json or .npmrc.
#
# All npm dependencies must resolve from the public registry
# (https://registry.npmjs.org/). Internal Azure DevOps feeds
# (pkgs.visualstudio.com, ms-feed, 1es-public, pkgs.dev.azure.com) leak build
# infrastructure and break external `npm ci`. Auth tokens must never be committed.
#
# Exit 0 = clean, exit 1 = violation. Scans TRACKED files only (git ls-files),
# so it reflects what is committed rather than local working-tree cruft.
# Run locally with: bash scripts/verify-lockfile.sh
set -euo pipefail

HOST_RE='pkgs\.visualstudio\.com|ms-feed|1es-public|pkgs\.dev\.azure\.com'
TOKEN_RE='_authToken|_auth[=:]|_password'

fail=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    node_modules/*|*/node_modules/*) continue ;;
  esac
  [ -f "$f" ] || continue
  if grep -Eqs "$HOST_RE" "$f"; then
    echo "::error file=$f::internal npm feed host found in committed file"
    grep -Ens "$HOST_RE" "$f" | sed 's/^/    /' || true
    fail=1
  fi
  if grep -Eqs "$TOKEN_RE" "$f"; then
    echo "::error file=$f::npm auth token/credential found in committed file"
    fail=1
  fi
done < <(git ls-files | grep -E '(^|/)(package-lock\.json|\.npmrc)$' || true)

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "Lockfile guard FAILED: dependencies must resolve from registry.npmjs.org"
  echo "and no auth tokens may be committed. See docs/lockfile-regen-runbook.md"
  exit 1
fi
echo "Lockfile guard passed: no internal feeds or auth tokens in tracked lockfiles/.npmrc."
