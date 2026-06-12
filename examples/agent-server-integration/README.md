# agent-server integration

This guide shows how to replace the inlined `component-catalog` / `component-spec` modules in [agent-server](https://github.com/your-org/agent-server) with the standalone CSI packages.

## 1. Install packages

In `agent-server/package.json`:

```json
{
  "dependencies": {
    "@csi/core": "^0.1.0",
    "@csi/mcp": "^0.1.0"
  }
}
```

During local development, use a workspace link:

```json
{
  "dependencies": {
    "@csi/core": "link:../component-schema-index/packages/core",
    "@csi/mcp": "link:../component-schema-index/packages/mcp"
  }
}
```

## 2. Configure at startup

In `AgentService` or `OptionsBuilder` initialization:

```typescript
import { join } from 'path';
import { configureCsi } from '@csi/core';
import { createCsiMcpServers } from '@csi/mcp';
import { getIconsSummary } from './tools/component-catalog/icons'; // keep icon provider in app

const dataRoot = join(process.cwd(), 'dist/agent/tools/component-data');

configureCsi({
  dataRoot,
  nodeModulesRoot: join(process.cwd(), 'node_modules'),
});

const { catalog, spec } = createCsiMcpServers({
  enableIcons: true,
  iconProvider: (platform) => getIconsSummary(platform as 'pc' | 'h5'),
});

toolManager.register('component-catalog', catalog);
toolManager.register('component-spec', spec);
```

## 3. Keep existing data layout

No change to `src/agent/tools/component-data/` — CSI scripts now live in the standalone repo:

```bash
cd ../component-schema-index
export CSI_DATA_ROOT=../agent-server/src/agent/tools/component-data
pnpm csi:all
pnpm generate:types
```

## 4. Remove duplicated code (optional migration)

After verifying MCP tools work via `@csi/mcp`, you can delete:

- `src/agent/tools/component-spec/` (except thin re-export shim if desired)
- `src/agent/tools/component-catalog/sdkMcpServer.ts` + resolvers
- `scripts/csi-indexer.mts`, `csi-sync.mts`, `generate-flattened-types.mts`

Keep in agent-server:

- Workflow prompts referencing `mcp__component-catalog__*` / `mcp__component-spec__*`
- `component-data/` assets (registry, metadata, examples)
- Icon provider (`icons.ts`) — app-specific

## 5. Tool IDs unchanged

MCP server names remain `component-catalog` and `component-spec`, so existing prompts and performance DB queries (`figma2code_tool_call_detail.tool_name`) stay compatible.

## 6. Verification

```bash
# In agent-server after integration
pnpm build
pnpm verify:resolver  # or run via CSI repo with CSI_DATA_ROOT
```

Compare a generateCode run's `tool_calls_json` — `get-component-source` call counts and `content_length` should match baseline.
