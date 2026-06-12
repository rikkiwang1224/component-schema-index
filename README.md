# Component Schema Index (CSI)

**Automated metadata extraction and on-demand retrieval for closed-source component libraries.**

AI agents generating UI code need component names, prop types, and usage examples — but closed-source libraries have no public docs crawlable by LLMs. CSI solves this with a **build-time index + runtime two-tier MCP retrieval** pipeline, originally proven in production on 180+ Figma2Code runs with measurable tool-call telemetry.

```
npm .d.ts  →  csi:index  →  csi:sync  →  registry + metadata
                                              ↓
                         list-available-components  (light catalog)
                         get-component-source       (deep types + examples)
```

## Features

- **CSI Indexer** — TypeScript AST extraction from npm `.d.ts` (props, complexity, deprecated detection)
- **Smart sync** — merges auto-indexed data with manual overrides (`contextLevel`, `subsumes`, descriptions)
- **Two-tier retrieval** — catalog (~26K chars) for discovery, spec (~90K) on demand only
- **Graded context** — `types-only` / `types-with-brief-example` / `full-example` per component
- **Flattened types** — pre-merged `.d.ts` for deep reference chains (ProTable, ProForm, etc.)
- **Semantic example ranking** — `relevantFeatures` prioritizes examples by design intent
- **Subsumes** — prevents redundant lookups when high-order components internalize base controls
- **MCP-ready** — Claude Agent SDK servers out of the box

## Packages

| Package | Description |
|---------|-------------|
| [`@csi/core`](./packages/core) | Registry loader, npm/examples resolvers, formatters |
| [`@csi/mcp`](./packages/mcp) | `component-catalog` + `component-spec` MCP servers |

## Quick start

```bash
pnpm install
pnpm build

# Configure your library
cp data/registry.example.json data/registry.json
# Edit data/registry.json — set npmPackage, typesPath, platform

# Install your component library (must ship .d.ts)
pnpm add -D your-ui-library

# Build index
pnpm csi:all
pnpm generate:types
pnpm verify:resolver
```

Point to external data (e.g. from [agent-server](https://github.com/your-org/agent-server)):

```bash
export CSI_DATA_ROOT=/path/to/component-data
pnpm verify:resolver
```

## Runtime usage

```typescript
import { join } from 'path';
import { configureCsi } from '@csi/core';
import { createCsiMcpServers } from '@csi/mcp';

configureCsi({
  dataRoot: join(process.cwd(), 'data'),
  nodeModulesRoot: join(process.cwd(), 'node_modules'),
});

const { catalog, spec } = createCsiMcpServers({
  enableIcons: true,
  iconProvider: (platform) => ({ /* your icon rules */ }),
});

// Register with Claude Agent SDK toolManager:
// toolManager.register('component-catalog', catalog);
// toolManager.register('component-spec', spec);
```

### MCP tools

| Tool | Server | Purpose |
|------|--------|---------|
| `list-available-components` | component-catalog | Name, description, keyProps |
| `get-component-source` | component-spec | Types + ranked examples |
| `list-icons` | component-catalog | Optional, via `iconProvider` |

## CLI

| Command | Description |
|---------|-------------|
| `pnpm csi:index [package]` | Index npm package(s) → `data/csi/` |
| `pnpm csi:sync [--dry-run]` | Merge CSI → `registry.json` + `metadata/` |
| `pnpm csi:all` | Index + sync |
| `pnpm generate:types` | Build `flattened-types/` |
| `pnpm verify:resolver` | Smoke test resolvers |

## Architecture

See [docs/architecture.md](./docs/architecture.md) and [docs/subsumes.md](./docs/subsumes.md).

## Integration with agent-server

See [examples/agent-server-integration/README.md](./examples/agent-server-integration/README.md).

## Why this approach works (evidence)

From production Figma2Code telemetry:

- **180+ runs** with tool-call breakdown — component queries are ~30% of context, tunable via `contextLevel`
- **Per-call audit** — `tool_name`, `duration_ms`, `content_length`, `input_json` in DB
- **Subsumes** — born from a real ProFilter regression (dual API confusion → fields not rendering)
- **Latency model** — 5–6 agentic rounds; parallel catalog + spec queries save ~20–25% (see optimization doc)

## License

MIT
