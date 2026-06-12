# Component Schema Index (CSI)

**面向闭源组件库的自动化元数据提取与按需检索方案。**

AI Agent 在生成 UI 代码时需要了解组件名称、Props 类型和使用示例，但闭源组件库往往没有可被 LLM 直接爬取的公开文档。CSI 通过 **构建时索引 + 运行时两级 MCP 检索** 解决这一问题，并已在 Figma2Code 生产环境中经过 **180+ 次生码任务** 验证，具备完整的工具调用遥测数据支撑。

```
npm .d.ts  →  csi:index  →  csi:sync  →  registry + metadata
                                              ↓
                         list-available-components  （轻量目录）
                         get-component-source       （深度类型 + 示例）
```

## 特性

- **CSI Indexer** — 从 npm 包的 `.d.ts` 通过 TypeScript AST 自动提取（Props、复杂度、废弃检测）
- **智能同步** — 自动索引结果与手动配置合并（`contextLevel`、`subsumes`、描述等）
- **两级检索** — catalog 用于发现（约 26K 字符），spec 按需深度查询（约 90K 字符）
- **分级上下文** — 按组件配置 `types-only` / `types-with-brief-example` / `full-example`
- **扁平化类型** — 为高阶组件（ProTable、ProForm 等）预合并深层 `.d.ts` 引用链
- **语义示例排序** — `relevantFeatures` 按设计意图优先返回最相关示例
- **内化机制（subsumes）** — 高阶组件已内化基础控件时，避免冗余查询
- **MCP 开箱即用** — 基于 Claude Agent SDK 的服务端可直接注册

## 包结构

| 包 | 说明 |
|----|------|
| [`@csi/core`](./packages/core) | 注册表加载、npm/示例解析、格式化输出 |
| [`@csi/mcp`](./packages/mcp) | `component-catalog` + `component-spec` MCP 服务 |

## 快速开始

```bash
pnpm install
pnpm build

# 配置你的组件库
cp data/registry.example.json data/registry.json
# 编辑 data/registry.json — 设置 npmPackage、typesPath、platform

# 安装组件库（需包含 .d.ts 类型声明）
pnpm add -D your-ui-library

# 构建索引
pnpm csi:all
pnpm generate:types
pnpm verify:resolver
```

指向外部数据目录（例如来自 agent-server）：

```bash
export CSI_DATA_ROOT=/path/to/component-data
pnpm verify:resolver
```

## 运行时使用

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
  iconProvider: (platform) => ({ /* 你的图标规则 */ }),
});

// 注册到 Claude Agent SDK toolManager：
// toolManager.register('component-catalog', catalog);
// toolManager.register('component-spec', spec);
```

### MCP 工具

| 工具 | 服务 | 用途 |
|------|------|------|
| `list-available-components` | component-catalog | 组件名、描述、keyProps |
| `get-component-source` | component-spec | 类型定义 + 排序后的示例 |
| `list-icons` | component-catalog | 可选，通过 `iconProvider` 注入 |

## CLI 命令

| 命令 | 说明 |
|------|------|
| `pnpm csi:index [package]` | 索引 npm 包 → `data/csi/` |
| `pnpm csi:sync [--dry-run]` | 合并 CSI 输出 → `registry.json` + `metadata/` |
| `pnpm csi:all` | 索引 + 同步 |
| `pnpm generate:types` | 生成 `flattened-types/` |
| `pnpm verify:resolver` | 解析器冒烟测试 |

## 架构文档

详见 [docs/architecture.md](./docs/architecture.md) 和 [docs/subsumes.md](./docs/subsumes.md)。

## 与 agent-server 集成

详见 [examples/agent-server-integration/README.md](./examples/agent-server-integration/README.md)。

## 为什么这套方案有效（数据佐证）

来自 Figma2Code 生产遥测：

- **180+ 次运行** 的工具调用分解 — 组件查询约占上下文 30%，可通过 `contextLevel` 调节
- **逐次审计** — 数据库记录 `tool_name`、`duration_ms`、`content_length`、`input_json`
- **subsumes 机制** — 源于 ProFilter 真实回归（双 API 混淆导致 fields 不渲染）
- **延迟模型** — 5–6 轮 Agentic Loop；catalog 与 spec 并行可节省约 20–25% 耗时

## 许可证

MIT
