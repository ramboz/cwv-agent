# Skill: cwv-setup

## Purpose
Prepare or report prerequisites for a selected cwv-agent execution profile
without touching customer data. Use this before optional provider work so the
operator sees which local commands, credentials, services, and setup artifacts
are ready.

## When to Invoke
- At the start of a new workbench session when the operator asks to set up the
  local environment.
- Before selecting an optional profile such as `source-s3`, `aem-clientlibs`,
  `validate-aso`, `publish-spacecat`, or `adobe-full`.
- When a provider command fails because a prerequisite may be missing.

Do not invoke this as a substitute for validation. Setup reports readiness; it
does not prove a CWV fix.

## Prerequisites
- Node.js >=20.
- The repository checkout.
- No `.env` or optional provider credentials are required for the default
  `local` profile.

## Workflow

1. Select the profile deliberately. Default to `local` unless the operator
   names an optional provider.
2. Run the deterministic setup script:
   ```
   npm run setup -- --profile <profile>
   ```
3. For a non-mutating report, use:
   ```
   npm run setup -- --profile <profile> --dry-run
   ```
4. For local ASO service setup, use explicit action flags:
   ```
   npm run setup -- --profile validate-aso --aso-build
   npm run setup -- --profile validate-aso --aso-smoke
   npm run setup -- --profile validate-aso --aso-start
   npm run setup -- --profile validate-aso --aso-stop
   ```
   The setup script runs ASO's own `npm run image:build`,
   `npm run image:smoke`, and `docker-compose.local.yml`; it does not submit
   validation jobs.
   Configure the checkout and service with `ASO_SHALLOW_VALIDATOR_DIR`,
   `ASO_SHALLOW_VALIDATOR_BASE_URL`, and `ASO_SHALLOW_VALIDATOR_IMAGE`.
   Short aliases (`ASO_VALIDATOR_DIR`, `ASO_BASE_URL`, `ASO_IMAGE_TAG`) are
   accepted for local convenience, but prefer the long names in committed docs.
5. Read every `missing` row. Each one includes the command or environment
   variable needed to retry.
6. For Docker-backed AEM CS source validation and ASO setup, trust the Docker distinction:
   `Docker CLI not found` means install Docker; `daemon unavailable` means start
   Docker Desktop or the configured daemon.

Supported setup profiles mirror `npm run doctor -- --profile <profile>`:
`local`, `source-s3`, `aem-clientlibs`, `validate-aso`, `publish-spacecat`,
`adobe-full`, plus the other field/headful profiles exposed by doctor.

## Output Format

The script emits a human-readable report by default and JSON with `--json`.
For machine consumers, call the script directly or silence npm's banner:

```
node .agents/scripts/setup.js --profile <profile> --json
npm --silent run setup -- --profile <profile> --json
```

Each prerequisite has one setup status:

- `ready` - already satisfied.
- `fixed` - safely created or repaired by this run.
- `missing` - operator action is required; see `retry`.
- `skipped` - informational or dry-run-only.

## Safety

- Setup does not perform SpaceCat writes, customer-data mutations, or publish
  actions.
- The default `local` profile does not require Docker, ASO, mysticat, AWS, RUM,
  Google API keys, or SpaceCat access.
- Optional profiles may report missing credentials or tools, but environment
  variables never activate those providers by themselves.
- `validate-aso` setup only manages the local ASO service. The validation job
  adapter is a separate provider step and must not be implied by setup success.
