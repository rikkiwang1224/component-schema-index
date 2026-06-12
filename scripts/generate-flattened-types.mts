/**
 * 高阶组件扁平化类型生成器
 *
 * 使用 TypeScript Compiler API 精确解析 .d.ts 类型引用链，
 * 将跨文件的类型定义提取并合并为单一文件，供 AI 消费。
 *
 * 只针对 registry.json 中标记 flattenTypes: true 的高阶组件执行。
 *
 * 使用方式: npx tsx scripts/generate-flattened-types.mts
 */

import * as ts from 'typescript';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, resolve, relative, join } from 'path';
import { REGISTRY_PATH, FLATTENED_TYPES_DIR as OUTPUT_BASE, PROJECT_ROOT } from './paths.mts';

interface ComponentConfig {
  dirName?: string;
  typesPath?: string;
  flattenTypes?: boolean;
}

interface LibraryConfig {
  displayName: string;
  npmPackage: string;
  typesPath: string | string[];
  components?: Record<string, ComponentConfig>;
}

interface Registry {
  version: string;
  libraries: Record<string, LibraryConfig>;
}

// ======================== TS Compiler 工具 ========================

/**
 * 创建 TS 编译器程序
 */
function createTsProgram(rootFiles: string[]): ts.Program {
  return ts.createProgram(rootFiles, {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  });
}

/**
 * 使用 TS 模块解析来查找 import 的实际文件路径
 */
function resolveModulePath(
  moduleName: string,
  containingFile: string,
  compilerOptions: ts.CompilerOptions,
): string | null {
  const resolved = ts.resolveModuleName(moduleName, containingFile, compilerOptions, ts.sys);
  return resolved.resolvedModule?.resolvedFileName ?? null;
}

// ======================== 依赖图收集 ========================

interface FileNode {
  fileName: string;
  relativePath: string;
  imports: string[];       // 内部依赖（同包内的绝对路径）
  externalImports: Map<string, Set<string>>; // 外部依赖: modulePath → importedNames
}

/**
 * 从入口文件出发，收集同包内的所有依赖文件
 * 使用 TS AST 精确解析 import/export 语句
 * 支持多入口文件（如 types.d.ts + 组件主声明文件）
 */
function collectDependencyGraph(
  entryFiles: string[],
  packageRoot: string,
  compilerOptions: ts.CompilerOptions,
): Map<string, FileNode> {
  const graph = new Map<string, FileNode>();
  const queue = entryFiles.map(f => resolve(f));

  while (queue.length > 0) {
    const filePath = queue.shift()!;
    if (graph.has(filePath)) continue;

    const sourceText = safeReadFile(filePath);
    if (!sourceText) continue;

    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
    const node: FileNode = {
      fileName: filePath,
      relativePath: relative(packageRoot, filePath),
      imports: [],
      externalImports: new Map(),
    };

    ts.forEachChild(sourceFile, (child) => {
      // import type { X } from '...' / import { X } from '...'
      if (ts.isImportDeclaration(child) && child.moduleSpecifier && ts.isStringLiteral(child.moduleSpecifier)) {
        const moduleName = child.moduleSpecifier.text;
        processModuleReference(moduleName, filePath, packageRoot, compilerOptions, node, queue, child);
      }
      // export * from '...' / export { X } from '...'
      if (ts.isExportDeclaration(child) && child.moduleSpecifier && ts.isStringLiteral(child.moduleSpecifier)) {
        const moduleName = child.moduleSpecifier.text;
        processModuleReference(moduleName, filePath, packageRoot, compilerOptions, node, queue, child);
      }
    });

    graph.set(filePath, node);
  }

  return graph;
}

/**
 * 处理单个模块引用：区分内部依赖和外部依赖
 */
function processModuleReference(
  moduleName: string,
  containingFile: string,
  packageRoot: string,
  compilerOptions: ts.CompilerOptions,
  node: FileNode,
  queue: string[],
  declaration: ts.ImportDeclaration | ts.ExportDeclaration,
): void {
  const resolved = resolveModulePath(moduleName, containingFile, compilerOptions);

  if (resolved && resolved.startsWith(resolve(packageRoot))) {
    // 内部依赖：同包内的文件
    node.imports.push(resolved);
    queue.push(resolved);
  } else {
    // 外部依赖：其他包或未解析
    const names = extractImportedNames(declaration);
    if (names.length > 0) {
      const existing = node.externalImports.get(moduleName) ?? new Set();
      for (const n of names) existing.add(n);
      node.externalImports.set(moduleName, existing);
    }
  }
}

/**
 * 从 import/export 声明中提取导入的名称
 */
function extractImportedNames(decl: ts.ImportDeclaration | ts.ExportDeclaration): string[] {
  if (ts.isImportDeclaration(decl)) {
    const clause = decl.importClause;
    if (!clause) return [];
    // import type * as X from '...'
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      return [`* as ${clause.namedBindings.name.text}`];
    }
    // import type { X, Y } from '...'
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      return clause.namedBindings.elements.map(e => e.name.text);
    }
    // import X from '...'
    if (clause.name) {
      return [clause.name.text];
    }
  }

  if (ts.isExportDeclaration(decl)) {
    if (!decl.exportClause) return ['*']; // export * from '...'
    if (ts.isNamedExports(decl.exportClause)) {
      return decl.exportClause.elements.map(e => e.name.text);
    }
  }

  return [];
}

// ======================== 拓扑排序 ========================

/**
 * 拓扑排序：依赖在前，入口在后
 * 处理循环引用（跳过已在栈中的节点）
 * 支持多入口文件
 */
function topologicalSort(graph: Map<string, FileNode>, entryFiles: string[]): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function visit(file: string) {
    if (visited.has(file)) return;
    if (inStack.has(file)) return; // 循环引用，跳过

    inStack.add(file);
    const node = graph.get(file);
    if (node) {
      for (const dep of node.imports) {
        if (graph.has(dep)) {
          visit(dep);
        }
      }
    }
    inStack.delete(file);
    visited.add(file);
    result.push(file);
  }

  // 从所有入口开始
  for (const entry of entryFiles) {
    visit(resolve(entry));
  }

  // 确保所有文件都被访问
  for (const file of graph.keys()) {
    visit(file);
  }

  return result;
}

// ======================== AST 声明提取 ========================

/**
 * 从源文件中提取所有类型声明（interface, type, enum）
 * 保留 JSDoc 注释
 */
function extractTypeDeclarations(filePath: string): string[] {
  const sourceText = safeReadFile(filePath);
  if (!sourceText) return [];

  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const declarations: string[] = [];

  ts.forEachChild(sourceFile, (node) => {
    // 跳过 import/export-from 语句（已被内联）
    if (ts.isImportDeclaration(node)) return;
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) return;
    // 跳过 /// <reference> 指令
    if (ts.isNotEmittedStatement(node)) return;

    // 提取类型声明
    if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isModuleDeclaration(node)
    ) {
      const text = getNodeTextWithJSDoc(node, sourceFile);
      if (text.trim()) {
        declarations.push(text);
      }
    }

    // 提取顶级 declare/const/function 声明
    // 组件主声明文件中通常有:
    //   declare const _default: CompType;
    //   declare const formatText: (format: string, num: number) => React.ReactNode;
    if (ts.isVariableStatement(node) || ts.isFunctionDeclaration(node)) {
      const text = getNodeTextWithJSDoc(node, sourceFile);
      if (text.trim()) {
        declarations.push(text);
      }
    }

    // 提取 export default 声明
    if (ts.isExportAssignment(node)) {
      const text = getNodeTextWithJSDoc(node, sourceFile);
      if (text.trim()) {
        declarations.push(text);
      }
    }

    // 也提取顶级 export { X } 不带 from 的（纯 re-export 本地类型）
    if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause) {
      // 这些是本地类型的 re-export，已在上面提取
      return;
    }
  });

  return declarations;
}

/**
 * 获取节点文本，包含前导 JSDoc 注释
 */
function getNodeTextWithJSDoc(node: ts.Node, sourceFile: ts.SourceFile): string {
  const fullText = sourceFile.getFullText();
  const nodeStart = node.getFullStart();
  const nodeEnd = node.getEnd();

  // 获取 full start（包含 JSDoc）到 end
  let text = fullText.substring(nodeStart, nodeEnd);

  // 清理前导空行
  text = text.replace(/^\s*\n/, '');

  return text;
}

// ======================== 扁平化生成 ========================

interface FlattenResult {
  content: string;
  stats: {
    totalFiles: number;
    totalDeclarations: number;
    externalDeps: string[];
    contentSize: number;
  };
}

/**
 * 为一个组件生成扁平化类型定义
 * 支持多入口文件（types.d.ts + 组件主声明文件）
 */
function flattenComponentTypes(
  entryFiles: string[],
  packageRoot: string,
  componentName: string,
  libraryName: string,
  npmPackage: string,
): FlattenResult {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    skipLibCheck: true,
    noEmit: true,
    types: [],
    baseUrl: packageRoot,
  };

  // 1. 收集依赖图（从所有入口文件出发）
  const graph = collectDependencyGraph(entryFiles, packageRoot, compilerOptions);

  // 2. 拓扑排序
  const sortedFiles = topologicalSort(graph, entryFiles);

  // 3. 收集外部 imports（去重合并）
  const allExternalImports = new Map<string, Set<string>>();
  for (const file of sortedFiles) {
    const node = graph.get(file);
    if (!node) continue;
    for (const [mod, names] of node.externalImports) {
      const existing = allExternalImports.get(mod) ?? new Set();
      for (const n of names) existing.add(n);
      allExternalImports.set(mod, existing);
    }
  }

  // 4. 生成外部 imports 代码
  const externalImportLines: string[] = [];
  for (const [mod, names] of allExternalImports) {
    const nameList = [...names];
    if (nameList.length === 1 && nameList[0] === '*') {
      externalImportLines.push(`export * from '${mod}';`);
    } else if (nameList.length === 1 && nameList[0].startsWith('* as ')) {
      externalImportLines.push(`import type ${nameList[0]} from '${mod}';`);
    } else {
      const filtered = nameList.filter(n => n !== '*');
      if (filtered.length > 0) {
        externalImportLines.push(`import type { ${filtered.join(', ')} } from '${mod}';`);
      }
    }
  }

  // 5. 提取各文件的类型声明，分为入口类型和依赖类型
  const entrySet = new Set(entryFiles.map(f => resolve(f)));

  // 收集入口文件直接引用的文件（一级依赖），用于优先排序
  const directDepSet = new Set<string>();
  for (const entryFile of entryFiles) {
    const entryNode = graph.get(resolve(entryFile));
    if (entryNode) {
      for (const dep of entryNode.imports) {
        if (!entrySet.has(dep)) directDepSet.add(dep);
      }
    }
  }

  const entrySections: string[] = [];
  const directDepSections: string[] = [];
  const deepDepSections: string[] = [];
  let totalDeclarations = 0;
  const allExportedNames: string[] = []; // 收集入口文件导出的类型名称

  for (const file of sortedFiles) {
    const node = graph.get(file);
    if (!node) continue;

    const declarations = extractTypeDeclarations(file);
    if (declarations.length === 0) continue;

    totalDeclarations += declarations.length;
    const resolvedFile = resolve(file);
    const isEntry = entrySet.has(resolvedFile);
    const isDirectDep = directDepSet.has(resolvedFile);

    if (isEntry) {
      const label = `${node.relativePath} (入口)`;
      entrySections.push(`// --- ${label} ---\n${declarations.join('\n\n')}`);
      for (const decl of declarations) {
        const names = extractDeclaredNames(decl);
        allExportedNames.push(...names);
      }
    } else if (isDirectDep) {
      const label = node.relativePath;
      directDepSections.push(`// --- ${label} ---\n${declarations.join('\n\n')}`);
      // 也收集一级依赖的类型名称
      for (const decl of declarations) {
        const names = extractDeclaredNames(decl);
        allExportedNames.push(...names);
      }
    } else {
      const label = node.relativePath;
      deepDepSections.push(`// --- ${label} ---\n${declarations.join('\n\n')}`);
    }
  }

  // 6. 组装最终输出：入口类型在前（AI 最先看到），依赖类型在后
  const header = [
    `/**`,
    ` * ${componentName} 扁平化类型定义`,
    ` * 库: ${libraryName} (${npmPackage})`,
    ` * 自动生成 - 请勿手动编辑`,
    ` * 生成时间: ${new Date().toISOString().slice(0, 10)}`,
    ` *`,
    ` * 此文件通过 AST 精确提取跨文件类型引用链并合并而成，`,
    ` * 包含 ${componentName} 及其所有依赖的完整类型定义。`,
    ` *`,
    ` * 关键类型速查:`,
    ...allExportedNames.map(n => ` *   - ${n}`),
    ` */`,
  ].join('\n');

  const parts: string[] = [header, ''];

  if (externalImportLines.length > 0) {
    parts.push('// External dependencies');
    parts.push(externalImportLines.join('\n'));
    parts.push('');
  }

  // 第一层：入口类型（组件自身的 Props、CompType 等核心 API）
  if (entrySections.length > 0) {
    parts.push('// ============================================================');
    parts.push(`// ${componentName} 核心类型（API Surface）`);
    parts.push('// ============================================================');
    parts.push('');
    parts.push(entrySections.join('\n\n'));
    parts.push('');
  }

  // 第二层：一级依赖（入口直接 import 的类型，如 FieldType、EditAreaProps）
  if (directDepSections.length > 0) {
    parts.push('// ============================================================');
    parts.push('// 一级依赖类型（入口文件直接引用）');
    parts.push('// ============================================================');
    parts.push('');
    parts.push(directDepSections.join('\n\n'));
    parts.push('');
  }

  // 第三层：深层依赖（间接引用的底层类型）
  if (deepDepSections.length > 0) {
    parts.push('// ============================================================');
    parts.push('// 深层依赖类型（间接引用，可在截断时省略）');
    parts.push('// ============================================================');
    parts.push('');
    parts.push(deepDepSections.join('\n\n'));
    parts.push('');
  }

  const content = parts.join('\n');

  return {
    content,
    stats: {
      totalFiles: sortedFiles.length,
      totalDeclarations,
      externalDeps: [...allExternalImports.keys()],
      contentSize: content.length,
    },
  };
}

// ======================== 工具函数 ========================

/**
 * 从声明文本中提取类型/接口/变量名称
 * 用于生成关键类型速查摘要
 */
function extractDeclaredNames(declaration: string): string[] {
  const names: string[] = [];
  const patterns = [
    /^export\s+(?:interface|type|enum|class)\s+(\w+)/m,
    /^interface\s+(\w+)/m,
    /^type\s+(\w+)/m,
    /^enum\s+(\w+)/m,
    /^declare\s+(?:const|function)\s+(\w+)/m,
  ];
  for (const pattern of patterns) {
    const match = declaration.match(pattern);
    if (match) {
      names.push(match[1]);
      break;
    }
  }
  return names;
}

function safeReadFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function toKebabCase(name: string): string {
  return name.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
}

function resolveNodeModules(): string | null {
  const nmPath = join(PROJECT_ROOT, 'node_modules');
  return existsSync(nmPath) ? nmPath : null;
}

/**
 * 查找 npm 包的实际安装路径（处理 pnpm 符号链接）
 */
function resolvePackageRoot(npmPackage: string): string | null {
  const nodeModules = resolveNodeModules();
  if (!nodeModules) return null;

  const packageDir = join(nodeModules, npmPackage);
  if (!existsSync(packageDir)) return null;

  // 解析符号链接获取真实路径
  try {
    const realPath = require('fs').realpathSync(packageDir);
    return realPath;
  } catch {
    return packageDir;
  }
}

/**
 * 查找组件的所有入口类型文件
 *
 * 除 typesPath 指定的 types.d.ts 外，还自动探测组件主声明文件
 * （如 pro-form.d.ts），该文件通常包含 CompType 接口定义了
 * 组件的静态属性和子组件（如 ProForm.useFormModel, ProForm.BasicForm）。
 */
function findEntryFiles(
  packageRoot: string,
  typesPath: string | string[],
  componentName: string,
  compConfig: ComponentConfig,
): string[] {
  const dirName = compConfig.dirName ?? toKebabCase(componentName);
  const entryFiles: string[] = [];

  // 1. 按 typesPath 配置查找主类型文件
  const patterns = Array.isArray(typesPath) ? typesPath : [typesPath];
  for (const pattern of patterns) {
    const resolved = pattern.replace(/\{component\}/g, dirName);
    const fullPath = join(packageRoot, resolved);
    if (existsSync(fullPath)) {
      entryFiles.push(fullPath);
      break; // 只取第一个匹配
    }
  }

  // Fallback for types file
  if (entryFiles.length === 0) {
    const fallbacks = [
      `typings/components/${dirName}/types.d.ts`,
      `dist/esm/components/${dirName}/types.d.ts`,
      `lib/components/${dirName}/types.d.ts`,
    ];
    for (const fb of fallbacks) {
      const fullPath = join(packageRoot, fb);
      if (existsSync(fullPath)) {
        entryFiles.push(fullPath);
        break;
      }
    }
  }

  // 2. 自动探测组件主声明文件（{component}.d.ts）
  //    该文件定义 CompType 接口，包含组件的静态方法和子组件
  const componentDeclPatterns = [
    `typings/components/${dirName}/${dirName}.d.ts`,
    `dist/esm/components/${dirName}/${dirName}.d.ts`,
    `lib/components/${dirName}/${dirName}.d.ts`,
  ];
  for (const pattern of componentDeclPatterns) {
    const fullPath = join(packageRoot, pattern);
    if (existsSync(fullPath) && !entryFiles.includes(fullPath)) {
      entryFiles.push(fullPath);
      break;
    }
  }

  return entryFiles;
}

// ======================== 主流程 ========================

function main() {
  console.log('=== 高阶组件扁平化类型生成 ===\n');

  const registry: Registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
  let generated = 0;
  let failed = 0;

  for (const [libName, libConfig] of Object.entries(registry.libraries)) {
    const components = libConfig.components ?? {};
    const flattenComponents = Object.entries(components).filter(([, c]) => c.flattenTypes);

    if (flattenComponents.length === 0) continue;

    console.log(`--- ${libConfig.displayName} (${libName}) ---`);

    const packageRoot = resolvePackageRoot(libConfig.npmPackage);
    if (!packageRoot) {
      console.log(`  ✗ npm 包 ${libConfig.npmPackage} 未找到`);
      failed += flattenComponents.length;
      continue;
    }

    const outputDir = join(OUTPUT_BASE, libName);
    mkdirSync(outputDir, { recursive: true });

    for (const [compName, compConfig] of flattenComponents) {
      const entryFiles = findEntryFiles(packageRoot, libConfig.typesPath, compName, compConfig);
      if (entryFiles.length === 0) {
        console.log(`  ✗ ${compName}: 入口文件未找到`);
        failed++;
        continue;
      }

      try {
        const result = flattenComponentTypes(entryFiles, packageRoot, compName, libName, libConfig.npmPackage);
        const outputFile = join(outputDir, `${compName}.d.ts`);
        writeFileSync(outputFile, result.content, 'utf-8');

        const sizeKB = (result.stats.contentSize / 1024).toFixed(1);
        const entryNames = entryFiles.map(f => relative(packageRoot, f)).join(' + ');
        console.log(
          `  ✓ ${compName}: ${result.stats.totalFiles} 文件, ` +
          `${result.stats.totalDeclarations} 个声明, ${sizeKB}KB (入口: ${entryNames})`
        );
        generated++;
      } catch (error) {
        console.log(`  ✗ ${compName}: ${error instanceof Error ? error.message : String(error)}`);
        failed++;
      }
    }
  }

  console.log(`\n=== 完成: 生成 ${generated} 个, 失败 ${failed} 个 ===`);
  if (failed > 0) process.exit(1);
}

main();
