# Go-live and rollback runbook

## Release gate

A release is ready only when:

- `CI`, `CodeQL`, `lockfile-guard`, and applicable `e2e` checks pass.
- The Pages workflow validates all public configuration and its post-deploy smoke test passes.
- `Production health` passes against both Pages and the OAuth Worker.
- The OAuth Worker has been deployed from the reviewed commit.
- The Entra publisher, redirect URIs, GitHub OAuth callback, and Worker `ALLOWED_ORIGIN`
  match the production origin exactly.

Do not bypass a failed gate. Resolve the failure or roll back.

## Monitoring

`.github/workflows/health.yml` probes the Pages application and Worker every 15 minutes.
Workflow failure notifications are the initial alert channel. Tokens and OAuth responses
must never be logged; probes use only public health endpoints.

Review GitHub Actions failures and Cloudflare Worker errors. Treat elevated OAuth failures,
deployment polling timeouts, and unexpected repository-write errors as release regressions.

## Pages rollback

1. Identify the last known-good commit from the Pages deployment history.
2. Revert the bad commit through a pull request; do not force-push `main`.
3. Merge only after required checks pass.
4. Confirm `Deploy SPA to GitHub Pages` and `Production health` succeed.

For an active credential-exposure incident, disable the Pages workflow or Pages site until
the credential path is closed.

## OAuth Worker rollback

1. Stop new exchanges by rotating or revoking the GitHub OAuth client secret when compromise
   is suspected.
2. Roll back the Worker in Cloudflare to the last known-good deployment.
3. Run the `Deploy OAuth Worker` workflow for the reviewed revision when a forward fix is ready.
4. Confirm `/health`, then complete an end-to-end OAuth login before restoring normal traffic.

The GitHub OAuth client secret belongs only in Cloudflare. The GitHub deployment workflow
uses separate `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` environment secrets.

## Incident ownership

The release operator owns triage, rollback, and customer-impact assessment. Record the bad
commit, affected interval, credential actions, and proof of recovery. Do not include customer
tokens, repository contents, or OAuth response bodies in the incident record.
