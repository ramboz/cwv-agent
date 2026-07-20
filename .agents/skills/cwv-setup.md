# Skill: cwv-setup

## Purpose
Prepare or report prerequisites for a selected cwv-agent execution profile
without touching site data. Use this before optional provider work so the
operator sees which local commands, credentials, and setup artifacts are
ready.

## When to Invoke
- At the start of a new session when the operator asks to set up the local
  environment.
- Before selecting an optional profile such as `field-google` or
  `stealth-headful`.
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
4. Read every `missing` row. Each one includes the command or environment
   variable needed to retry.

Supported setup profiles mirror `npm run doctor -- --profile <profile>`:
`local`, `field-google`, and `stealth-headful`.

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

- Setup performs no external writes, site-data mutations, or publish actions.
- The default `local` profile does not require Google API keys or any other
  provider credentials.
- Optional profiles may report missing credentials or tools, but environment
  variables never activate those providers by themselves.
