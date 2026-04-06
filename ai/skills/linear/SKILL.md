---
name: linear
description: Work with Linear carefully. Prefer read-only operations, inspect help/docs first, and require an explicit preview before writes.
user-invocable: true
allowed-tools:
  - "Bash(linear *)"
  - "Bash(curl *)"
  - "WebFetch(domain:linear.app)"
---

# Linear Skill

Work with Linear conservatively.

## Default posture

- Prefer read-only operations first.
- Before doing anything unfamiliar, check local help with `linear --help` and the relevant subcommand help.
- If the CLI is missing or the subcommand is unclear, use the official docs:
  - `https://linear.app/developers/graphql`
  - `https://linear.app/developers/filtering`
  - `https://linear.app/developers/rate-limiting`
  - `https://linear.app/docs/creating-issues`

## Safety rules

- Treat reads and writes differently. Reads are usually fine; writes need extra care.
- Prefer specific commands over the generic `linear api` subcommand.
- Treat `linear api` as high risk for mutations. Do not use it for writes until you have inspected the relevant docs/help and can state exactly which GraphQL mutation will run and with which arguments.
- For any write, first produce a short preview covering:
  - target object type
  - target identifier(s)
  - exact fields to change
  - whether the change is reversible
- If the user did not already request that exact mutation, ask for confirmation before executing it.
- Avoid bulk updates unless the user explicitly asks for bulk changes.
- Never guess IDs, team keys, workflow state IDs, or project IDs. Resolve them with read-only queries first.

## Recommended workflow

1. Inspect help: `linear --help` and `linear <subcommand> --help`.
2. Resolve the target with read-only queries or listing commands.
3. Summarize the intended write in one short preview.
4. Execute the narrowest command possible.
5. Report exactly what changed.

## Using `linear api`

Use `linear api` mainly for:

- read-only GraphQL queries
- schema discovery
- cases where the normal CLI has no dedicated subcommand

Before any `linear api` mutation:

1. Find the relevant docs or schema.
2. Draft the exact mutation and variables.
3. Show the payload in a compact preview.
4. Confirm the scope is minimal.
5. Only then execute it.

## Useful Linear API facts

- Linear's public API is GraphQL at `https://api.linear.app/graphql`.
- Auth is via personal API key or OAuth.
- Queries are reads; mutations are writes.
- Rate limits and query complexity are documented, so keep queries narrow and filtered.

## If more depth is needed

Do not improvise. Check:

- `linear --help`
- `linear <subcommand> --help`
- the relevant page under `https://linear.app/developers`
