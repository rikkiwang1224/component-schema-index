# 组件内化机制 (Subsumes)

## 1. 问题背景

### 1.1 直接问题：ProFilter 字段不显示

在一次生成中，LLM 需要使用 ProFilter 组件。它在 Step 3 同时查询了 ProFilter 和多个基础组件（Select、Input、DatePicker 等）的源码文档。LLM 看到了两套 API：

- **ProFilter 方式**：`fields: [{ type: 'select', name: 'status', label: '状态' }]`
- **Select 独立方式**：`<Select options={[...]} onChange={...} />`

结果 LLM 混淆了两种用法，将 `fields` 错误地放进了 `formProps` 而非 ProFilter 的顶层 prop，导致筛选字段不渲染。

### 1.2 根本原因

高阶组件（ProFilter、ProTable、ProForm 等）通过配置化的 `fields`/`columns` 已经**内化**了基础组件的能力。当 LLM 同时获得高阶组件和基础组件的 API 文档时：

1. **上下文冗余**：基础组件文档对已选择高阶组件的场景完全多余，白白占用 context 空间
2. **API 混淆**：两套 API 共存导致 LLM 做出错误的用法决策
3. **查询浪费**：每次 `get-component-source` 调用都消耗一个 agentic loop round，增加延迟

## 2. 方案设计

### 2.1 核心思路

在 `registry.json` 中为高阶组件声明 `subsumes` 列表，标明该组件内化了哪些其他组件。这个声明在三个层面生效：

```
registry.json                     Step 2 提示词                   get-component-source 输出
     │                                  │                                  │
     │  subsumes: ["Select", ...]       │  字段内化规则表                     │  ⚠️ 字段内化说明
     │                                  │  → 排除被内化组件                   │  → 提醒无需单独查询
     ▼                                  ▼                                  ▼
   声明层                             决策层                              执行层
(哪些被内化)                    (LLM 决定不查询)                   (查询后再次提醒)
```

**双重防御**：Step 2 提示词引导 LLM 在组件清单中排除被内化组件（预防）；`formatComponentSourceForAI` 在返回结果中注入"字段内化说明"（兜底）。

### 2.2 内化的定义

**「当使用组件 A 时，组件 B 不需要被单独查询」**— 即 A subsumes B。

这种关系可能源自两种组合方式：

| 组合类型 | 含义 | 例子 |
|----------|------|------|
| **字段内化** | A 通过 `fields`/`formDescriptors` 配置替代 B 的独立使用 | ProFilter → Select, Input（通过 `type: 'select'`） |
| **模块组合** | A 通过 prop 嵌入 B 的完整功能 | ProTable → ProFilter（通过 `searchForm: ProFilterProps`） |

两者的运营含义相同：选了 A 就不用再查 B。

### 2.3 当前各组件的内化关系

#### PC 端 (react-pro-components + ssc-ui-react)

| 高阶组件 | 直接内化 | 内化方式 |
|----------|----------|----------|
| **ProFilter** | Select, Input, Input.Number, Input.Range, InputNumber, DatePicker, TimePicker, RangePicker, Cascader, Radio, Checkbox, Switch, TreeSelect, TextArea, Button | 字段内化 (`fields[].type`) |
| **ProForm** | 同 ProFilter | 字段内化 (`fields[].type`) |
| **ProTable** | ProFilter, Table, MassTool + 所有叶子控件 | 模块组合 (`searchForm`, `table`, `massTool`) + 传递性字段内化 |
| **EditableTable2** | Table + Select, Input, InputNumber, DatePicker, RangePicker, Radio, Checkbox, Switch, TextArea, Cascader | 包裹 Table + 字段内化 (`columns[].formDescriptors.type`) |
| **Table** | Pagination | 内置分页 (`pagination` prop) |

#### H5 端 (ssc-mobile-ui-react)

| 高阶组件 | 直接内化 | 内化方式 |
|----------|----------|----------|
| **ProForm** | Input, TextArea, Select, DatePicker, DateRangePicker, Cascader, Picker, RadioPicker, CheckboxPicker, ChipPicker, Switch, Button | 字段内化 |
| **QueryFilter** | 同 ProForm | 字段内化 |

### 2.4 层级结构

以 ProTable 为例的完整依赖树：

```
ProTable
├── ProFilter (via searchForm: ProFilterProps)
│   ├── Select         ─┐
│   ├── Input          │
│   ├── Input.Number   │
│   ├── Input.Range    │
│   ├── InputNumber    │ 通过 fields[].type 配置
│   ├── DatePicker     │
│   ├── TimePicker     │
│   ├── RangePicker    │
│   ├── Cascader       │
│   ├── Radio          │
│   ├── Checkbox       │
│   ├── Switch         │
│   ├── TreeSelect     │
│   ├── TextArea       │
│   └── Button         ─┘ (footerProps 内化)
├── Table (via table: ExtendTableProps)
│   └── Pagination
└── MassTool (via massTool: MassToolProps)
```

## 3. 实现细节

### 3.1 registry.json 声明

```json
{
  "ProFilter": {
    "contextLevel": "full-example",
    "flattenTypes": true,
    "subsumes": ["Select", "Input", "Input.Number", "Input.Range", "InputNumber",
                 "DatePicker", "TimePicker", "RangePicker", "Cascader",
                 "Radio", "Checkbox", "Switch", "TreeSelect", "TextArea", "Button"]
  },
  "ProTable": {
    "contextLevel": "full-example",
    "flattenTypes": true,
    "subsumes": ["Select", "Input", "...(全部叶子)", "Table", "Pagination", "MassTool"]
  },
  "Table": {
    "subsumes": ["Pagination"]
  }
}
```

> **当前实现**：ProTable 的 subsumes 是**扁平列表**，手动列出所有被（直接或传递性）内化的组件。
>
> **后续优化方向**：改为只声明直接内化关系（`["ProFilter", "Table", "MassTool"]`），系统递归解析出完整列表（见第 5 节）。

### 3.2 类型定义

```typescript
// src/agent/tools/component-spec/resolvers/types.ts
interface ComponentConfig {
  contextLevel?: ContextLevel;
  flattenTypes?: boolean;
  /** 本组件通过 fields 配置内化的基础组件列表（无需单独查询） */
  subsumes?: string[];
  // ...
}

// src/agent/tools/component-spec/types.ts
interface ComponentSource {
  name: string;
  library: ComponentLibrary;
  typesContent?: string;
  examples?: ClassifiedFile[];
  /** 本组件通过 fields 配置内化的基础组件列表 */
  subsumes?: string[];
}
```

### 3.3 格式化输出

`formatComponentSourceForAI` 在组件标题后注入内化提示：

```typescript
// src/agent/tools/component-spec/utils.ts
if (source.subsumes && source.subsumes.length > 0) {
  append(
    `### ⚠️ 字段内化说明\n` +
    `本组件通过 \`fields\` 配置内化了以下基础组件，**无需单独查询它们的源码**：` +
    `${source.subsumes.join(', ')}\n\n` +
    `使用方式：在 \`fields\` 数组中通过 \`type\` 属性指定字段类型（如 \`type: 'select'\`），` +
    `通过 \`ctrlProps\` 传递组件属性。\n`
  );
}
```

### 3.4 Step 2 提示词引导

在 Step 2（识别高阶组件）中，通过决策表 + 正反例引导 LLM 排除被内化组件：

```markdown
**⚠️ 高阶组件字段内化规则**：当选择这些高阶组件时，
**被内化的基础组件不要列入最终组件清单**：

| 高阶组件     | 内化的基础组件（无需单独查询）                          |
|-------------|------------------------------------------------------|
| ProFilter   | Select, Input, ..., Button（footerProps 内化）         |
| ProTable    | 包含 ProFilter 内化的全部组件 + Table + Pagination + MassTool |
| ProForm     | 同 ProFilter                                          |
| EditableTable2 | Select, Input, InputNumber, ...                    |

❌ 错误清单：ProFilter + Select + Input + Input.Range + Button + Tag
✅ 正确清单：ProFilter + Tag
```

### 3.5 全局约束

```markdown
6. **禁止跳过源码查询**：最终组件清单中的每个组件必须调用 `get-component-source`
   获取完整源码（已被高阶组件内化的基础组件不应出现在清单中，见第 2 步「字段内化规则」）
```

## 4. 效果

实测对比（同一 Figma 页面）：

| 指标 | 优化前 | 优化后 | 变化 |
|------|--------|--------|------|
| 组件查询次数 | 11 次 | 8 次 | -27% |
| 组件文档上下文 | ~50K chars | ~30K chars | -40% |
| ProFilter 用法正确率 | 不稳定 | 稳定正确 | — |

## 5. 后续优化方向：层级化 subsumes

### 5.1 问题

当前 ProTable 的 subsumes 是**扁平列表**（18 项），手动维护与 ProFilter 的 subsumes 同步。如果 ProFilter 新增一个支持的字段类型，需要同时更新 ProFilter 和 ProTable 两处。

### 5.2 方案

改为只声明**直接内化**关系，系统递归解析：

```json
{
  "ProFilter": { "subsumes": ["Select", "Input", "..."] },
  "ProTable":  { "subsumes": ["ProFilter", "Table", "MassTool"] },
  "Table":     { "subsumes": ["Pagination"] }
}
```

新增递归解析函数：

```typescript
function resolveAllSubsumed(
  componentName: string,
  library: ComponentLibrary,
  visited = new Set<string>()
): string[] {
  if (visited.has(componentName)) return []; // 防循环
  visited.add(componentName);

  const config = getComponentConfig(library, componentName);
  const direct = config.subsumes ?? [];
  const all = new Set<string>();

  for (const name of direct) {
    all.add(name);
    for (const t of resolveAllSubsumed(name, library, visited)) {
      all.add(t);
    }
  }
  return [...all];
}
```

`resolveAllSubsumed("ProTable", "react-pro-components")` 自动展开为完整列表：ProFilter, Select, Input, ..., Table, Pagination, MassTool。

### 5.3 收益

- **维护成本降低**：每个组件只维护自己的直接关系
- **语义更准确**：反映真实的组件组合架构
- **提示词可简化**：内化规则表可从 registry 自动生成，不用手动维护

## 6. 关键文件

| 文件 | 职责 |
|------|------|
| `src/agent/tools/component-data/registry.json` | subsumes 声明 |
| `src/agent/tools/component-spec/resolvers/types.ts` | `ComponentConfig.subsumes` 类型 |
| `src/agent/tools/component-spec/types.ts` | `ComponentSource.subsumes` 类型 |
| `src/agent/tools/component-spec/resolvers/index.ts` | 将 subsumes 从 config 传递到 source |
| `src/agent/tools/component-spec/resolvers/registryLoader.ts` | 读取组件配置 |
| `src/agent/tools/component-spec/utils.ts` | `formatComponentSourceForAI` 注入内化说明 |
| `src/agent/platforms/pc/workflow/figma2code/step2-identify-components.ts` | PC 端字段内化规则 |
| `src/agent/platforms/pc/workflow/figma2code/step3-query-source.ts` | PC 端查询优化提示 |
| `src/agent/platforms/h5/workflow/figma2code/step2-identify-components.ts` | H5 端字段内化规则 |
| `src/agent/platforms/h5/workflow/figma2code/step3-query-source.ts` | H5 端查询优化提示 |
| `src/agent/platforms/shared/constraints.ts` | 全局约束 #6 |
