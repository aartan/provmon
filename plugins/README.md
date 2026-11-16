# Retailer plugins

This directory is the deployment-owned plugin installation directory. It is
intentionally empty in the ProvMon repository: retailer integrations are
external packages and are not part of the public core codebase.

Typical contents after installation:

```
plugins/
  package.json
  package-lock.json
  provmon.plugins.json
  node_modules/@your-scope/retailer-example/...
```

`provmon.plugins.json` lists the enabled packages:

```json
{
  "plugins": ["@your-scope/retailer-example"]
}
```

`PROVMON_PLUGINS` can override that list with a comma-separated package list.
`PROVMON_PLUGIN_DIR` changes the directory location. Copy
`provmon.plugins.example.json` to `provmon.plugins.json` and replace the
example package name with the plugins you installed.

See `docs/plugin-development.md` for the full guide.
