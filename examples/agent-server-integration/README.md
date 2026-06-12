# agent-server 集成指南

本文说明如何用独立 CSI 包替换 agent-server 内联的 `component-catalog` / `component-spec` 模块。

## 1. 安装包

在 `agent-server/package.json` 中添加：

```json
{
  "dependencies": {
    "@csi/core": "^0.1.0",
    "@csi/mcp": "^0.1.0"
  }
}
```

本地开发可使用 workspace 链接：

```json
{
  "dependencies": {
    "@csi/core": "link:../component-schema-index/packages/core",
    "@csi/mcp": "link:../component-schema-index/packages/mcp"
  }
}
```

## 2. 启动时配置

在 `AgentService` 或 `OptionsBuilder` 初始化处：

```typescript
import { join } from 'path';
import { configureCsi } from '@csi/core';
import { createCsiMcpServers } from '@csi/mcp';
import { getIconsSummary } from './tools/component-catalog/icons'; // 图标 provider 保留在应用层

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

## 3. 保持现有数据目录不变

`src/agent/tools/component-data/` 无需改动 — CSI 脚本已迁移到独立仓库：

```bash
cd ../component-schema-index
export CSI_DATA_ROOT=../agent-server/src/agent/tools/component-data
pnpm csi:all
pnpm generate:types
```

## 4. 删除重复代码（可选迁移步骤）

确认 `@csi/mcp` 工作正常后，可删除：

- `src/agent/tools/component-spec/`（或保留薄 re-export 垫片）
- `src/agent/tools/component-catalog/sdkMcpServer.ts` 及解析器
- `scripts/csi-indexer.mts`、`csi-sync.mts`、`generate-flattened-types.mts`

agent-server 中应保留：

- 引用 `mcp__component-catalog__*` / `mcp__component-spec__*` 的工作流提示词
- `component-data/` 资产（registry、metadata、examples）
- 图标 provider（`icons.ts`）— 应用特有逻辑

## 5. 工具 ID 不变

MCP 服务名仍为 `component-catalog` 和 `component-spec`，现有提示词及性能数据库查询（`figma2code_tool_call_detail.tool_name`）保持兼容。

## 6. 验证

```bash
# agent-server 集成完成后
pnpm build

# 在 agent-server 目录运行（需有 node_modules 中的组件库）
CSI_DATA_ROOT="$(pwd)/src/agent/tools/component-data" \
  node --import tsx/esm ../component-schema-index/scripts/verify-resolver.mts
```

对比一次 generateCode 运行的 `tool_calls_json` — `get-component-source` 的调用次数和 `content_length` 应与基线一致。
