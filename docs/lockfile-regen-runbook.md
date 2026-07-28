# Lockfile regeneration runbook

## Invariant

Every dependency in every tracked `package-lock.json` **must** resolve from the
public npm registry, `https://registry.npmjs.org/`. Internal Azure DevOps feed
hosts — `pkgs.visualstudio.com`, `ms-feed`, `1es-public`, `pkgs.dev.azure.com` —
must never appear in a committed lockfile: they leak internal build
infrastructure and break external `npm ci`. No `_authToken` / `_auth` /
`_password` may be committed in a lockfile or `.npmrc`.

This invariant is enforced in CI by `.github/workflows/lockfile-guard.yml`
(which runs `scripts/verify-lockfile.sh`). Run the check locally any time with:

```bash
bash scripts/verify-lockfile.sh
```

## The constraint that shapes this procedure

`registry.npmjs.org` is TLS-blocked on the corporate network **and** on the
cloud dev runner, so `npm install` cannot be run against the public registry
from a normal dev box. Regeneration therefore has to happen on a
**GitHub-hosted Actions runner**, which has clean public internet.

## Regenerating the root lockfile (public-registry regen)

Use this when `package.json` dependency ranges change, or to re-pin a poisoned
lockfile from scratch.

1. Confirm the root `.npmrc` contains exactly `registry=https://registry.npmjs.org/`
   and **no** auth token.
2. On a disposable branch, add a throwaway `on: push` workflow that runs on a
   GitHub-hosted `ubuntu-latest` runner and:
   - deletes the root `package-lock.json` and any `node_modules/`,
   - runs `npm install --registry=https://registry.npmjs.org/`,
   - prints a host histogram of every `resolved` URL and asserts
     `0` internal-feed hits and `0` auth tokens,
   - commits the regenerated `package-lock.json` (and uploads it as a build
     artifact for out-of-band inspection).
3. Verify from the run logs / artifact:
   - all `resolved` URLs start with `https://registry.npmjs.org/`,
   - `0` matches for the internal feed hosts,
   - `0` occurrences of `_authToken` / `_auth` / `_password`.
4. Land **only** the `package-lock.json` change. Do **not** leave the throwaway
   workflow in the tree; delete the disposable branch afterward.

> PR #3 (`fix/regen-lockfile` -> `main`) was produced with exactly this
> procedure: 9/9 deps on `registry.npmjs.org`, 0 internal-feed hits, 0 tokens,
> 17/17 tests green. (That regen floated `fast-uri` 3.1.3 -> 3.1.4, the
> GHSA-v2hh-gcrm-f6hx security patch — a benign transitive bump.)

## Propagating to sibling branches without a regen

When `package.json` is byte-identical across branches, a full regen on each
sibling is unnecessary and risks re-floating transitive versions. Instead,
**transplant** the already-verified clean lockfile:

```bash
# from a clean checkout, with <clean-ref> = the branch/commit holding the good lockfile
git checkout <sibling-branch>
git checkout <clean-ref> -- package-lock.json
bash scripts/verify-lockfile.sh      # must pass
git commit -m "fix: transplant clean package-lock.json (registry.npmjs.org)" package-lock.json
```

Confirm identity first with `git rev-parse <ref>:package.json` on both refs — if
the `package.json` blobs match, the clean lockfile is an exact, valid resolution
for the sibling.
