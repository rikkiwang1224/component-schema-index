# 组件数据目录

本目录存放运行时消费的 **注册表与生成产物**。

| 路径 | 用途 | 是否提交 Git |
|------|------|--------------|
| `registry.json` | 中央库配置（contextLevel、subsumes、typesPath） | 是（项目相关） |
| `registry.schema.json` | registry 的 JSON Schema | 是 |
| `metadata/*.json` | catalog MCP 使用的轻量摘要 | 由 `pnpm csi:sync` 生成 |
| `examples/` | 手工维护的使用示例 | 是 |
| `flattened-types/` | 高阶组件预合并的 `.d.ts` | 由 `pnpm generate:types` 生成 |
| `csi/` | CSI 索引器原始输出（仅构建时使用） | 已 gitignore |

## 快速开始

```bash
cp registry.example.json registry.json
# 按你的 npm 包编辑 registry.json

pnpm install your-ui-library   # 安装带类型的包
pnpm csi:all                   # 索引 + 同步 metadata
pnpm generate:types            # 扁平化高阶组件类型
pnpm verify:resolver           # 冒烟测试
```

## 复用 agent-server 现有数据

直接通过环境变量指向 agent-server 的 `component-data` 目录即可，无需软链接：

```bash
export CSI_DATA_ROOT=../agent-server/src/agent/tools/component-data
pnpm verify:resolver
```

或一次性复制到本仓库 `data/` 目录：

```bash
rsync -a ../agent-server/src/agent/tools/component-data/ ./data/
pnpm verify:resolver
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CSI_DATA_ROOT` | `./data` | component-data 根目录路径 |
