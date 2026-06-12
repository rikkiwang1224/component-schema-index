# 组件库索引与检索（CSI）方案

> Component Schema Index — 自动化组件元数据提取、注册与 AI 运行时检索

## 1. 背景与目标

AI Agent 在生成页面代码时需要了解可用组件的名称、Props 类型、使用示例等信息。早期通过手工维护硬编码的 TypeScript 文件（`react-pro-components.ts` 等），存在以下问题：

- 组件库升级时人工同步成本高，容易遗漏
- 废弃组件未及时清理，导致 AI 推荐已废弃 API
- 元数据分散在多处，数据流不清晰

CSI 的目标是将这一过程自动化，形成**单向数据流**：

```
组件库 npm 包 → CSI 索引 → CSI 同步 → registry + metadata → AI MCP 工具
```

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                       构建时 (Build-time)                     │
│                                                             │
│  node_modules/                                              │
│  ├── react-pro-components/typings/                          │
│  ├── ssc-ui-react/typings/                                  │
│  └── ssc-mobile-ui-react/dist/esm/                          │
│         │                                                   │
│         ▼                                                   │
│  ┌─────────────┐     ┌──────────────┐                       │
│  │ csi:index    │────▶│ csi/<lib>/   │                       │
│  │ (csi-indexer)│     │ manifest     │                       │
│  └─────────────┘     │ metadata     │                       │
│                      │ registry-sug │                       │
│                      │ index.compact│                       │
│                      └──────┬───────┘                       │
│                             │                               │
│                             ▼                               │
│  ┌─────────────┐     ┌──────────────┐    ┌───────────────┐  │
│  │ csi:sync     │────▶│ registry.json│    │ metadata/     │  │
│  │ (csi-sync)   │────▶│              │    │ *.json        │  │
│  └─────────────┘     └──────┬───────┘    └──────┬────────┘  │
│                             │                   │           │
│  ┌──────────────────┐       │                   │           │
│  │generate-flattened│       │                   │           │
│  │-types            │       │                   │           │
│  └────────┬─────────┘       │                   │           │
│           │                 │                   │           │
│           ▼                 ▼                   ▼           │
│  ┌────────────────────────────────────────────────────┐     │
│  │              component-data/ (dist)                │     │
│  │  registry.json │ metadata/*.json │ flattened-types/│     │
│  │  examples/                                         │     │
│  └────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                       运行时 (Runtime)                        │
│                                                             │
│  ┌───────────────────────┐    ┌──────────────────────────┐  │
│  │ list-available-        │    │ get-component-source     │  │
│  │ components (MCP)       │    │ (MCP)                    │  │
│  │                        │    │                          │  │
│  │  MetadataLoader        │    │  ComponentResolver       │  │
│  │  ← metadata/*.json     │    │  ← registry.json         │  │
│  │                        │    │  ← flattened-types/       │  │
│  │  返回: name, desc,     │    │  ← examples/             │  │
│  │  keyProps, library     │    │  ← node_modules/ (types) │  │
│  └───────────────────────┘    └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## 3. 数据流详解

### 3.1 CSI Indexer（`scripts/csi-indexer.mts`）

从 npm 包的 `.d.ts` 类型声明中自动提取组件元数据。

**输入**：`node_modules/<package>/typings/` 或 `dist/esm/` 下的类型声明文件

**处理流程**：

1. **发现组件** — 解析 barrel 导出文件（`index.d.ts`），提取所有 `export { ComponentName }` 声明
2. **提取 Props** — 对每个组件定位 `types.d.ts`，使用 TypeScript AST 解析 `interface XxxProps`
3. **检测子组件** — 扫描静态成员（如 `ProForm.BasicForm`），标记为子组件并关联到父组件目录
4. **排除废弃** — 检测 `@deprecated` JSDoc 标签，完全排除废弃组件
5. **评估复杂度** — 基于 Props 数量、示例数量、嵌套深度，自动建议 `contextLevel`

**输出**（写入 `component-data/csi/<library>/`）：

| 文件 | 用途 |
|------|------|
| `manifest.json` | 完整的 `ComponentSchema[]`，包含 Props、复杂度、静态成员等 |
| `metadata.json` | 兼容 `metadata/*.json` 格式，供 `csi:sync` 消费 |
| `registry-suggestion.json` | 建议的 `registry.json` 更新（contextLevel、flattenTypes、dirName） |
| `index.compact.md` | 人可读的组件列表，按复杂度分类 |

**命令**：

```bash
pnpm csi:index                    # 索引所有库
pnpm csi:index -- react-pro-components  # 索引指定库
```

### 3.2 CSI Sync（`scripts/csi-sync.mts`）

将 CSI 索引的原始输出与手动维护的配置智能合并。

**合并策略**：

| 字段 | 规则 | 说明 |
|------|------|------|
| `contextLevel` | 手动 > CSI | 手动设置的精度控制优先 |
| `flattenTypes` | 手动 > CSI | 手动关闭扁平化优先 |
| `dirName` | 手动 > CSI | 手动路径映射优先 |
| `description` | 保留手动（非泛化） | CSI 生成的 "X component" 泛化描述会被手动丰富的描述覆盖 |
| `examples` | 保留手动 | 手动维护的示例说明不被覆盖 |
| `tags` | 保留手动（更丰富时） | 手动标签比 CSI 自动分类更精确 |
| `csi.*` | CSI 覆盖 | lastIndexed、discoveredCount 等元信息总是更新 |

**特殊处理**：

- 新发现的组件自动添加到 registry 和 metadata
- 仅存在于手动 registry 中的组件发出警告（可能是别名或聚合组件）
- 废弃组件不会出现在 CSI 输出中，因此不会被同步

**命令**：

```bash
pnpm csi:sync                    # 同步所有库
pnpm csi:sync -- --dry-run       # 预览变更，不写入
pnpm csi:sync -- --library ssc-ui-react  # 仅同步指定库
```

### 3.3 一键执行

```bash
pnpm csi:all    # = csi:index + csi:sync
```

## 4. 核心数据结构

### 4.1 registry.json

组件库的中央注册表，控制运行时行为：

```jsonc
{
  "version": "2.0.0",
  "libraries": {
    "ssc-ui-react": {
      "displayName": "SSC UI React",
      "platform": ["pc"],
      "importPrefix": "ssc-ui-react",
      "npmPackage": "ssc-ui-react",
      "typesPath": "typings/components/{component}/index.d.ts",
      "examplesDir": "examples",
      "defaultContextLevel": "types-only",
      "csi": {
        "lastIndexed": "2026-02-18T...",
        "discoveredCount": 86,
        "typesEntry": "typings/components/index.d.ts"
      },
      "components": {
        "Table": {
          "contextLevel": "full-example",
          "flattenTypes": true
        },
        "Button": {
          // 使用库默认的 types-only
        },
        "Form.Item": {
          "dirName": "form"   // 子组件指向父目录
        }
      }
    }
  }
}
```

**关键字段说明**：

| 字段 | 说明 |
|------|------|
| `typesPath` | 类型文件路径模板，`{component}` 被替换为 kebab-case 目录名 |
| `defaultContextLevel` | 未单独配置的组件使用此级别 |
| `contextLevel` | `types-only` → 仅类型；`types-with-brief-example` → 类型 + ≤2 个示例；`full-example` → 全量 |
| `flattenTypes` | 是否使用预生成的扁平化类型（适用于深引用链组件） |
| `dirName` | 组件对应的 npm 包目录名（子组件需要显式指定） |

### 4.2 metadata/*.json

运行时供 `list-available-components` MCP 工具消费：

```jsonc
{
  "library": "ssc-ui-react",
  "version": "1.1.130",
  "generatedAt": "2026-02-18T...",
  "generator": "csi-sync",
  "components": [
    {
      "name": "Button",
      "description": "按钮组件，支持多种类型、尺寸和状态",
      "keyProps": ["type", "size", "disabled", "loading", "onClick"],
      "category": "通用",
      "importPath": "ssc-ui-react",
      "tags": ["button", "action"]
    }
  ]
}
```

## 5. 运行时检索

### 5.1 list-available-components（MCP 工具）

AI 用此工具了解有哪些组件可用。

**入参**：`platform`（pc / h5）或 `library`

**流程**：

1. 根据 platform 或 library 确定要查询的组件库列表
2. `MetadataLoader.load(library)` 从 `component-data/metadata/<lib>.json` 加载
3. 返回组件列表（name、description、keyProps）

**MetadataLoader 设计**：
- 文件级缓存，首次加载后缓存到内存
- 支持 `preload()` 预加载所有库
- 路径：`component-data/metadata/<library>.json`

### 5.2 get-component-source（MCP 工具）

AI 选定组件后，用此工具获取详细类型和示例。

**入参**：`componentName`、`library`、可选 `includeExamples`、`includeProps`

**类型解析优先级**：

| 优先级 | 方式 | 条件 |
|--------|------|------|
| 1 | 预生成扁平化类型 | registry 中 `flattenTypes: true` |
| 2 | 深度引用解析 | BFS 遍历 `.d.ts` import 链（深度 ≤3，≤30 文件，≤100KB） |
| 3 | 单文件读取 | 简单组件直接读取 `types.d.ts` |

**扁平化类型**（`flattened-types/<lib>/<Component>.d.ts`）：
- 构建时由 `generate-flattened-types.mts` 生成
- 将深度引用链中所有类型声明合并到单个文件
- 适用于 ProTable、ProForm 等高阶组件（引用链深、文件数多）

**示例解析**：
- 从 `component-data/examples/<lib>/<comp-dir>/` 加载
- 组件名到目录名映射：registry `dirName` > 点分名取父级 > PascalCase → kebab-case
- 根据 `contextLevel` 控制返回的示例数量

**输出格式**：Markdown，包含 import 信息、类型声明、示例代码

## 6. 目录结构

```
src/agent/tools/
├── component-data/                    # 组件数据（构建时生成 + 手动维护）
│   ├── registry.json                  # 中央注册表
│   ├── registry.schema.json           # 注册表 JSON Schema
│   ├── metadata/                      # 运行时元数据（csi:sync 输出）
│   │   ├── .schema.json
│   │   ├── react-pro-components.json
│   │   ├── ssc-ui-react.json
│   │   └── ssc-mobile-ui-react.json
│   ├── csi/                           # CSI 索引原始输出（仅构建时使用）
│   │   └── <library>/
│   │       ├── manifest.json
│   │       ├── metadata.json
│   │       ├── registry-suggestion.json
│   │       └── index.compact.md
│   ├── flattened-types/               # 预生成扁平化类型
│   │   └── <library>/<Component>.d.ts
│   └── examples/                      # 组件示例代码
│       └── <library>/<comp-dir>/*.tsx
│
├── component-catalog/                 # list-available-components MCP 工具（轻量摘要）
│   ├── sdkMcpServer.ts                # MCP 服务入口
│   ├── index.ts                       # 统一导出
│   ├── loader/
│   │   └── metadataLoader.ts          # 元数据加载器（读 metadata/*.json）
│   ├── constants.ts                   # 平台 → 库映射
│   ├── types.ts                       # ComponentSummary 等类型
│   └── icons.ts                       # 图标摘要
│
└── component-spec/                    # get-component-source MCP 工具（按需深度检索）
    ├── sdkMcpServer.ts                # MCP 服务入口
    └── resolvers/
        ├── registryLoader.ts          # 加载 registry.json，名称 → 目录转换
        ├── npmResolver.ts             # 类型解析（扁平化 / 深度解析 / 单文件）
        ├── examplesResolver.ts        # 示例文件加载
        └── componentResolver.ts       # 组合解析器，输出 Markdown
```

## 7. 构建与部署

### 构建流水线

```bash
pnpm build
# 等价于：
#   1. generate-flattened-types  — 生成扁平化类型文件
#   2. tsc                       — TypeScript 编译
#   3. copy-agent-skills         — 复制 Agent 技能文件
#   4. copy-component-assets     — 复制组件数据到 dist（排除 csi/）
#   5. add-js-extensions         — 补全相对 import 的 .js 扩展名
```

### dist 输出

```
dist/agent/tools/component-data/
├── registry.json
├── registry.schema.json
├── metadata/*.json          ← 运行时元数据
├── flattened-types/**       ← 预生成扁平化类型
└── examples/**              ← 组件示例

# 注意：csi/ 目录不会复制到 dist（仅构建时使用）
```

### 验证

```bash
pnpm verify:resolver     # 验证组件列表、类型获取、示例、格式化输出
```

## 8. 日常维护流程

### 组件库升级后

```bash
pnpm install              # 更新 node_modules
pnpm csi:all              # 重新索引 + 同步
pnpm verify:resolver      # 验证无回归
pnpm build                # 重新构建
```

### 需要手动调整时

直接编辑 `registry.json` 或 `metadata/*.json`，下次 `csi:sync` 会保留手动覆盖。

常见场景：
- 调整某组件的 `contextLevel`（如将 Input 从 `types-only` 提升到 `types-with-brief-example`）
- 丰富组件的 `description`（替换 CSI 自动生成的泛化描述）
- 为聚合组件添加 `aliases`
- 关闭某组件的 `flattenTypes`（如扁平化结果过大时）

### 新增组件库

1. 在 `registry.json` 中添加库配置（`displayName`、`platform`、`npmPackage`、`typesPath` 等）
2. 运行 `pnpm csi:all`
3. 检查 `csi/<library>/` 输出是否符合预期
4. 运行 `pnpm build` 完成集成
