# Retailer Integrations

Retailer integrations are external plugins. This page is kept as a short
pointer for older links.

- Architecture and trust model:
  [`plugin-architecture.md`](plugin-architecture.md)
- Plugin development, testing and installation:
  [`plugin-development.md`](plugin-development.md)
- Migrating an existing deployment to plugin-provided retailers:
  [`plugin-migration.md`](plugin-migration.md)
- Catalogue discovery contract:
  [`catalogue-discovery.md`](catalogue-discovery.md)

ProvMon core does not contain retailer-specific API code, credentials,
fixtures or documentation. A retailer is added by installing a plugin package
into `plugins/` and enabling it in `plugins/provmon.plugins.json` (or
`PROVMON_PLUGINS`). No monitoring, catalogue or notification engine changes
are required.
