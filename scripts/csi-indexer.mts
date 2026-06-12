/**
 * CSI (Component Schema Index) Indexer
 *
 * 自动从 npm 包的 TypeScript 类型声明中生成组件索引。
 * 输入：npm 包名（或从 registry.json 读取已注册的库）
 * 输出：manifest.json + index.compact.md + registry 建议
 *
 * 使用方式:
 *   npx tsx scripts/csi-indexer.mts                          # 索引所有已注册的库
 *   npx tsx scripts/csi-indexer.mts react-pro-components     # 索引指定的库
 *   npx tsx scripts/csi-indexer.mts --discover <npm-package> # 发现新库
 */

import * as ts from 'typescript';
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'fs';
import { join, resolve, relative, dirname, basename } from 'path';
import {
  PROJECT_ROOT,
  CSI_DIR as OUTPUT_BASE,
  REGISTRY_PATH,
  METADATA_DIR,
} from './paths.mts';

// ======================== 配置 ========================

interface PackageJson {
  name: string;
  version: string;
  types?: string;
  typings?: string;
  module?: string;
  main?: string;
  exports?: Record<string, unknown>;
}

interface DiscoveredComponent {
  name: string;
  exportName: string;
  localImportPath: string;      // barrel 中的 import 源路径 (e.g. './pro-table')
  dirName: string;              // 组件目录名 (e.g. 'pro-table')
  resolvedDir: string;          // 组件类型目录的绝对路径
  isDefaultExport: boolean;     // 是否通过 default export 导入
  isSubComponent: boolean;      // 是否为子组件 (e.g. ProForm.BasicForm)
  parentComponent?: string;     // 父组件名称
  deprecated: boolean;          // 是否标记了 @deprecated
  deprecatedMessage?: string;   // 废弃说明
}

interface ExtractedProp {
  name: string;
  type: string;
  description: string;
  required: boolean;
  hasDefault: boolean;
}

interface ComponentSchema {
  name: string;
  library: string;
  version: string;
  description: string;
  importPath: string;           // Where: 组件导入路径
  typeImportPath: string;       // Where: 类型导入子路径
  dirName?: string;             // 组件目录名（当与 kebab-case(name) 不同时需要）
  keyProps: string[];
  props: ExtractedProp[];
  propsInterfaceName: string;
  complexity: ComplexityScore;
  hasStaticMembers: boolean;
  staticMembers: string[];
  subComponents: string[];
  dependencyDepth: number;
  crossFileRefs: number;
  deprecated: boolean;
  deprecatedMessage?: string;
}

interface ComplexityScore {
  total: number;
  level: 'simple' | 'moderate' | 'complex';
  contextLevel: 'types-only' | 'types-with-brief-example' | 'full-example';
  flattenTypes: boolean;
}

interface CSIManifest {
  version: string;
  generatedAt: string;
  generatedBy: string;
  library: {
    name: string;
    npmPackage: string;
    version: string;
    typesEntry: string;
    typesPathPattern: string;
    componentCount: number;
  };
  components: ComponentSchema[];
}


// ======================== 类型定义 ========================

function resolvePackageRoot(npmPackage: string): string | null {
  const packageDir = join(PROJECT_ROOT, 'node_modules', npmPackage);
  if (!existsSync(packageDir)) return null;
  try {
    return realpathSync(packageDir);
  } catch {
    return packageDir;
  }
}

function readPackageJson(packageRoot: string): PackageJson | null {
  const pkgPath = join(packageRoot, 'package.json');
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    return null;
  }
}

function findBarrelTypesFile(packageRoot: string, pkg: PackageJson): string | null {
  const candidates: string[] = [];

  if (pkg.typings) candidates.push(pkg.typings);
  if (pkg.types) candidates.push(pkg.types);

  // 从 exports 中提取 types
  if (pkg.exports) {
    const rootExport = (pkg.exports as any)['.'];
    if (rootExport?.types) candidates.push(rootExport.types);
    if (typeof rootExport === 'object' && rootExport?.import) {
      const importEntry = rootExport.import;
      if (typeof importEntry === 'object' && importEntry?.types) {
        candidates.push(importEntry.types);
      }
    }
  }

  // Fallback 猜测
  candidates.push('index.d.ts', 'dist/index.d.ts', 'typings/index.d.ts');

  for (const candidate of candidates) {
    const fullPath = join(packageRoot, candidate);
    if (existsSync(fullPath)) return fullPath;
  }
  return null;
}

// ======================== Component Discovery ========================

/**
 * 解析 barrel export 文件，发现所有导出的组件
 *
 * 支持两种模式：
 * 1. import X from './path'; export { X, ... };  (react-pro-components, ssc-ui-react)
 * 2. export { default as X } from './components/x';  (ssc-mobile-ui-react)
 */
function discoverComponents(
  barrelFile: string,
  packageRoot: string,
): DiscoveredComponent[] {
  const sourceText = readFileSync(barrelFile, 'utf-8');
  const sourceFile = ts.createSourceFile(barrelFile, sourceText, ts.ScriptTarget.Latest, true);

  // Phase 1: 收集 import 映射 (localName → importPath)
  const importMap = new Map<string, { path: string; isDefault: boolean }>();

  // Phase 2: 收集 re-export 映射 (exportName → { path, isDefault })
  const reExportMap = new Map<string, { path: string; isDefault: boolean }>();

  // Phase 3: 收集 export 列表中的名称
  const exportedNames = new Set<string>();

  ts.forEachChild(sourceFile, (node) => {
    // import X from './path'
    // import { X, Y } from './path'
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const modulePath = node.moduleSpecifier.text;
      if (!modulePath.startsWith('.')) return; // 跳过外部包

      const clause = node.importClause;
      if (!clause) return;

      // default import: import X from '...'
      if (clause.name) {
        importMap.set(clause.name.text, { path: modulePath, isDefault: true });
      }
      // named imports: import { X, Y } from '...'
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          importMap.set(element.name.text, { path: modulePath, isDefault: false });
        }
      }
    }

    // export { X, Y, Z }  (无 from)
    if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause) {
      if (ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          exportedNames.add(element.name.text);
        }
      }
    }

    // export { default as X } from './path'
    // export { X } from './path'
    // 但排除 export type { ... } from '...'
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const modulePath = node.moduleSpecifier.text;
      if (!modulePath.startsWith('.')) return;

      // 跳过 export type { ... } — 这些是纯类型导出，不是组件
      if (node.isTypeOnly) return;

      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const exportName = element.name.text;
          const propertyName = element.propertyName?.text;
          const isDefault = propertyName === 'default';
          reExportMap.set(exportName, { path: modulePath, isDefault });
        }
      }
    }
  });

  // 合并结果
  const components: DiscoveredComponent[] = [];
  const barrelDir = dirname(barrelFile);

  // 处理 import + export 模式
  for (const name of exportedNames) {
    const imp = importMap.get(name);
    if (!imp) continue;
    if (!isComponentOrAPI(name)) continue;

    const resolvedImportDir = resolveComponentDir(barrelDir, imp.path, packageRoot);
    if (!resolvedImportDir) continue;

    const dirName = extractDirName(imp.path);
    const depInfo = detectDeprecation(resolvedImportDir, dirName, name);

    components.push({
      name,
      exportName: name,
      localImportPath: imp.path,
      dirName,
      resolvedDir: resolvedImportDir,
      isDefaultExport: imp.isDefault,
      isSubComponent: false,
      deprecated: depInfo.deprecated,
      deprecatedMessage: depInfo.message,
    });
  }

  // 处理 re-export 模式 (export { default as X } from '...')
  for (const [name, info] of reExportMap) {
    if (!isComponentOrAPI(name)) continue;
    if (components.some(c => c.name === name)) continue;

    const resolvedImportDir = resolveComponentDir(barrelDir, info.path, packageRoot);
    if (!resolvedImportDir) continue;

    const dirName = extractDirName(info.path);
    const barrelDep = detectBarrelDeprecation(barrelFile, name);
    const declDep = barrelDep.deprecated ? barrelDep : detectDeprecation(resolvedImportDir, dirName, name);

    components.push({
      name,
      exportName: name,
      localImportPath: info.path,
      dirName,
      resolvedDir: resolvedImportDir,
      isDefaultExport: info.isDefault,
      isSubComponent: false,
      deprecated: declDep.deprecated,
      deprecatedMessage: declDep.message,
    });
  }

  // 按名称排序
  components.sort((a, b) => a.name.localeCompare(b.name));

  // Phase 4: 发现子组件（通过 CompType 静态成员）
  const subComponents: DiscoveredComponent[] = [];
  for (const comp of components) {
    const { members } = detectStaticMembers(comp);
    const subComps = members.filter(m => /^[A-Z]/.test(m));
    for (const sub of subComps) {
      subComponents.push({
        name: `${comp.name}.${sub}`,
        exportName: `${comp.name}.${sub}`,
        localImportPath: comp.localImportPath,
        dirName: comp.dirName,
        resolvedDir: comp.resolvedDir,
        isDefaultExport: false,
        isSubComponent: true,
        parentComponent: comp.name,
        deprecated: false,
      });
    }
  }
  components.push(...subComponents);

  components.sort((a, b) => a.name.localeCompare(b.name));
  return components;
}

function isComponentOrAPI(name: string): boolean {
  // 过滤掉明显是类型名而非组件/API 名的导出
  const typeSuffixes = /Props$|Ref$|Type$|Types$|Handler$|Option$|Options$|Config$|Instance$/;
  if (typeSuffixes.test(name)) return false;

  // 组件以大写开头 (Button, ProTable)
  if (/^[A-Z]/.test(name)) return true;

  // 常见的 API 函数名 (message, notification) — 小写但也是有效导出
  const knownAPIs = ['message', 'notification'];
  if (knownAPIs.includes(name)) return true;

  return false;
}

/**
 * 检测组件声明文件中指定导出名是否有 @deprecated 标记
 * 精确匹配：只检测 exportName 对应的声明，而非文件中任意声明
 */
function detectDeprecation(resolvedDir: string, dirName: string, exportName: string): { deprecated: boolean; message?: string } {
  const filesToCheck = [
    join(resolvedDir, 'index.d.ts'),
    join(resolvedDir, `${dirName}.d.ts`),
  ];

  for (const filePath of filesToCheck) {
    if (!existsSync(filePath)) continue;
    const sourceText = readFileSync(filePath, 'utf-8');
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
    const fullText = sourceFile.getFullText();

    let result: { deprecated: boolean; message?: string } | null = null;

    ts.forEachChild(sourceFile, (node) => {
      if (result) return;

      // 匹配: export declare const ExportName / declare const ExportName
      if (ts.isVariableStatement(node)) {
        const match = node.declarationList.declarations.some(
          d => ts.isIdentifier(d.name) && d.name.text === exportName
        );
        if (!match) return;
      }
      // 匹配: export { default as ExportName } from '...'
      else if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
        const match = node.exportClause.elements.some(
          e => e.name.text === exportName
        );
        if (!match) return;
      }
      // 匹配: declare const _default (代表 default export)
      else if (ts.isVariableStatement(node)) {
        const match = node.declarationList.declarations.some(
          d => ts.isIdentifier(d.name) && d.name.text === '_default'
        );
        // 只在 default export 场景下匹配，且 exportName 匹配 dirName 的 PascalCase
        if (!match) return;
      } else {
        return;
      }

      const commentRanges = ts.getLeadingCommentRanges(fullText, node.getFullStart());
      if (!commentRanges) return;

      for (const range of commentRanges) {
        const comment = fullText.substring(range.pos, range.end);
        if (comment.includes('@deprecated')) {
          const msgMatch = comment.match(/@deprecated\s+(.*?)(?:\n|\*\/)/s);
          const message = msgMatch?.[1]?.replace(/\s*\*\s*/g, ' ').trim() || undefined;
          result = { deprecated: true, message };
        }
      }
    });

    if (result) return result;
  }

  return { deprecated: false };
}

/**
 * 检测 barrel export 中指定导出名的 @deprecated 标记
 */
function detectBarrelDeprecation(barrelFile: string, exportName: string): { deprecated: boolean; message?: string } {
  const sourceText = readFileSync(barrelFile, 'utf-8');
  const sourceFile = ts.createSourceFile(barrelFile, sourceText, ts.ScriptTarget.Latest, true);
  const fullText = sourceFile.getFullText();

  let result: { deprecated: boolean; message?: string } | null = null;

  ts.forEachChild(sourceFile, (node) => {
    if (result) return;

    // export { default as X } from '...' 或 export const X = ...
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      const hasTarget = node.exportClause.elements.some(
        e => e.name.text === exportName || e.propertyName?.text === exportName
      );
      if (!hasTarget) return;
    } else if (ts.isVariableStatement(node)) {
      const hasTarget = node.declarationList.declarations.some(
        d => ts.isIdentifier(d.name) && d.name.text === exportName
      );
      if (!hasTarget) return;
    } else {
      return;
    }

    const commentRanges = ts.getLeadingCommentRanges(fullText, node.getFullStart());
    if (!commentRanges) return;

    for (const range of commentRanges) {
      const comment = fullText.substring(range.pos, range.end);
      if (comment.includes('@deprecated')) {
        const msgMatch = comment.match(/@deprecated\s+(.*?)(?:\n|\*\/)/s);
        const message = msgMatch?.[1]?.replace(/\s*\*\s*/g, ' ').trim() || undefined;
        result = { deprecated: true, message };
      }
    }
  });

  return result ?? { deprecated: false };
}

function extractDirName(importPath: string): string {
  // './pro-table' → 'pro-table'
  // './components/button' → 'button'
  const parts = importPath.split('/');
  return parts[parts.length - 1];
}

function resolveComponentDir(barrelDir: string, importPath: string, packageRoot: string): string | null {
  // 尝试解析为目录
  const fullPath = resolve(barrelDir, importPath);

  // 可能是目录（含 index.d.ts）
  if (existsSync(join(fullPath, 'index.d.ts'))) return fullPath;
  if (existsSync(fullPath + '.d.ts')) return dirname(fullPath + '.d.ts');

  // 尝试直接作为文件
  if (existsSync(fullPath)) return dirname(fullPath);

  return null;
}

// ======================== Props Extraction ========================

/**
 * 查找组件的 Props 接口，提取其成员
 */
function extractComponentProps(
  component: DiscoveredComponent,
  packageRoot: string,
): { props: ExtractedProp[]; propsInterfaceName: string; description: string } | null {
  const propsNames = guessPropsInterfaceNames(component.name);

  const searchFiles = [
    join(component.resolvedDir, 'types.d.ts'),
    join(component.resolvedDir, 'index.d.ts'),
    join(component.resolvedDir, `${component.dirName}.d.ts`),
  ];

  for (const filePath of searchFiles) {
    if (!existsSync(filePath)) continue;

    // 优先用精确名称匹配
    const result = parsePropsFromFile(filePath, propsNames, component.name);
    if (result) return result;
  }

  // Fallback: 在 types.d.ts 中查找任何包含 "Props" 的 export 类型
  for (const filePath of searchFiles) {
    if (!existsSync(filePath)) continue;
    const result = findFirstPropsExport(filePath, component.name);
    if (result) return result;
  }

  return null;
}

function guessPropsInterfaceNames(componentName: string): string[] {
  const base = componentName.replace(/\./g, '').replace(/\d+$/, ''); // 'EditableTable2' → 'EditableTable'
  const exact = componentName.replace(/\./g, '');
  const names = [
    `${exact}Props`,       // EditableTable2Props
    `${base}Props`,        // EditableTableProps
    `${exact}Properties`,
    `I${exact}Props`,
  ];
  // 去重
  return [...new Set(names)];
}

function parsePropsFromFile(
  filePath: string,
  propsNames: string[],
  componentName: string,
): { props: ExtractedProp[]; propsInterfaceName: string; description: string } | null {
  const sourceText = readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);

  let targetNode: ts.InterfaceDeclaration | ts.TypeAliasDeclaration | null = null;
  let foundName = '';

  ts.forEachChild(sourceFile, (node) => {
    if (targetNode) return;

    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text;
      if (propsNames.includes(name)) {
        targetNode = node;
        foundName = name;
      }
    }
    if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text;
      if (propsNames.includes(name)) {
        targetNode = node;
        foundName = name;
      }
    }
  });

  if (!targetNode) return null;

  const description = extractJSDocDescription(targetNode, sourceFile);
  const props = extractPropsFromNode(targetNode, sourceFile);

  return { props, propsInterfaceName: foundName, description };
}

/**
 * Fallback: 在文件中查找第一个名称包含 "Props" 的导出类型
 */
function findFirstPropsExport(
  filePath: string,
  componentName: string,
): { props: ExtractedProp[]; propsInterfaceName: string; description: string } | null {
  const sourceText = readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const compLower = componentName.replace(/\d+$/, '').toLowerCase();

  let bestNode: ts.InterfaceDeclaration | ts.TypeAliasDeclaration | null = null;
  let bestName = '';

  ts.forEachChild(sourceFile, (node) => {
    if (bestNode) return;

    const isExported = !!(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export);
    if (!isExported) return;

    if (ts.isInterfaceDeclaration(node) && node.name.text.toLowerCase().includes(compLower) && node.name.text.endsWith('Props')) {
      bestNode = node;
      bestName = node.name.text;
    }
    if (ts.isTypeAliasDeclaration(node) && node.name.text.toLowerCase().includes(compLower) && node.name.text.endsWith('Props')) {
      bestNode = node;
      bestName = node.name.text;
    }
  });

  if (!bestNode) return null;

  const description = extractJSDocDescription(bestNode, sourceFile);
  const props = extractPropsFromNode(bestNode, sourceFile);
  return { props, propsInterfaceName: bestName, description };
}

/**
 * 从声明节点中提取 props，支持 interface / type literal / intersection type
 */
function extractPropsFromNode(
  node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration,
  sourceFile: ts.SourceFile,
): ExtractedProp[] {
  if (ts.isInterfaceDeclaration(node)) {
    return extractMembersFromTypeElements(node.members, sourceFile);
  }

  if (ts.isTypeAliasDeclaration(node) && node.type) {
    return extractPropsFromTypeNode(node.type, sourceFile);
  }

  return [];
}

function extractPropsFromTypeNode(typeNode: ts.TypeNode, sourceFile: ts.SourceFile): ExtractedProp[] {
  // 1. Type literal: { key: value; ... }
  if (ts.isTypeLiteralNode(typeNode)) {
    return extractMembersFromTypeElements(typeNode.members, sourceFile);
  }

  // 2. Intersection type: A & B & { ... }
  if (ts.isIntersectionTypeNode(typeNode)) {
    const props: ExtractedProp[] = [];
    for (const member of typeNode.types) {
      if (ts.isTypeLiteralNode(member)) {
        props.push(...extractMembersFromTypeElements(member.members, sourceFile));
      }
    }
    return props;
  }

  // 3. Parenthesized: (A & { ... })
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return extractPropsFromTypeNode(typeNode.type, sourceFile);
  }

  return [];
}

function extractMembersFromTypeElements(
  members: ts.NodeArray<ts.TypeElement>,
  sourceFile: ts.SourceFile,
): ExtractedProp[] {
  const props: ExtractedProp[] = [];
  for (const member of members) {
    if (ts.isPropertySignature(member) && member.name) {
      const name = member.name.getText(sourceFile);
      const type = member.type ? member.type.getText(sourceFile) : 'unknown';
      const required = !member.questionToken;
      const description = extractJSDocDescription(member, sourceFile);
      props.push({ name, type, description, required, hasDefault: false });
    }
    if (ts.isMethodSignature(member) && member.name) {
      const name = member.name.getText(sourceFile);
      const type = member.getText(sourceFile).replace(name, '').trim();
      const required = !member.questionToken;
      const description = extractJSDocDescription(member, sourceFile);
      props.push({ name, type: `method: ${type}`, description, required, hasDefault: false });
    }
  }
  return props;
}

function extractJSDocDescription(node: ts.Node, sourceFile: ts.SourceFile): string {
  const fullText = sourceFile.getFullText();
  const commentRanges = ts.getLeadingCommentRanges(fullText, node.getFullStart());
  if (!commentRanges) return '';

  for (const range of commentRanges) {
    const comment = fullText.substring(range.pos, range.end);
    if (comment.startsWith('/**')) {
      // 提取 JSDoc 内容（去除 /** */ 和 * 前缀）
      const cleaned = comment
        .replace(/^\/\*\*\s*/, '')
        .replace(/\s*\*\/$/, '')
        .split('\n')
        .map(line => line.replace(/^\s*\*\s?/, '').trim())
        .filter(line => !line.startsWith('@'))
        .join(' ')
        .trim();
      if (cleaned) return cleaned;
    }
  }
  return '';
}

// ======================== Static Members Detection ========================

/**
 * 检测组件是否有静态成员（CompType 模式）
 * 支持两种定义方式：
 *   interface CompType { ... }
 *   type CompType = typeof X & { Number: ...; TextArea: ...; }
 */
function detectStaticMembers(
  component: DiscoveredComponent,
): { hasStaticMembers: boolean; members: string[] } {
  const declFile = join(component.resolvedDir, `${component.dirName}.d.ts`);
  if (!existsSync(declFile)) {
    return { hasStaticMembers: false, members: [] };
  }

  const sourceText = readFileSync(declFile, 'utf-8');
  const sourceFile = ts.createSourceFile(declFile, sourceText, ts.ScriptTarget.Latest, true);

  const members: string[] = [];

  function extractMembersFromTypeNode(typeNode: ts.TypeNode) {
    if (ts.isTypeLiteralNode(typeNode)) {
      for (const member of typeNode.members) {
        if ((ts.isPropertySignature(member) || ts.isMethodSignature(member)) && member.name) {
          members.push(member.name.getText(sourceFile));
        }
      }
    }
    if (ts.isIntersectionTypeNode(typeNode)) {
      for (const part of typeNode.types) {
        extractMembersFromTypeNode(part);
      }
    }
  }

  ts.forEachChild(sourceFile, (node) => {
    // interface CompType { ... }
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'CompType') {
      for (const member of node.members) {
        if ((ts.isPropertySignature(member) || ts.isMethodSignature(member)) && member.name) {
          members.push(member.name.getText(sourceFile));
        }
      }
    }
    // type CompType = typeof X & { Number: ...; TextArea: ...; }
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'CompType' && node.type) {
      extractMembersFromTypeNode(node.type);
    }
  });

  return { hasStaticMembers: members.length > 0, members };
}

// ======================== Module Path Inference ========================

/**
 * 推断组件库的 typesPath 模式
 * 扫描多个组件的类型文件位置，归纳出通用模式
 */
function inferTypesPathPattern(
  components: DiscoveredComponent[],
  packageRoot: string,
): string {
  const patterns = new Map<string, number>(); // pattern → count

  for (const comp of components.slice(0, 10)) { // 取前 10 个采样
    const typesFile = join(comp.resolvedDir, 'types.d.ts');
    if (existsSync(typesFile)) {
      const relPath = relative(packageRoot, typesFile);
      const pattern = relPath.replace(comp.dirName, '{component}');
      patterns.set(pattern, (patterns.get(pattern) ?? 0) + 1);
    }

    const indexFile = join(comp.resolvedDir, 'index.d.ts');
    if (existsSync(indexFile)) {
      const relPath = relative(packageRoot, indexFile);
      const pattern = relPath.replace(comp.dirName, '{component}');
      patterns.set(pattern, (patterns.get(pattern) ?? 0) + 1);
    }
  }

  // 取频率最高的模式
  let bestPattern = 'typings/components/{component}/types.d.ts';
  let bestCount = 0;
  for (const [pattern, count] of patterns) {
    if (count > bestCount) {
      bestPattern = pattern;
      bestCount = count;
    }
  }

  return bestPattern;
}

/**
 * 推断组件的类型导入子路径
 * e.g. 'react-pro-components/typings/components/pro-table/types'
 */
function inferTypeImportPath(
  component: DiscoveredComponent,
  packageRoot: string,
  npmPackage: string,
): string {
  // 查找 types.d.ts 或 index.d.ts
  const typesFile = join(component.resolvedDir, 'types.d.ts');
  if (existsSync(typesFile)) {
    const relPath = relative(packageRoot, typesFile).replace(/\.d\.ts$/, '');
    return `${npmPackage}/${relPath}`;
  }

  const indexFile = join(component.resolvedDir, 'index.d.ts');
  if (existsSync(indexFile)) {
    const relPath = relative(packageRoot, indexFile).replace(/index\.d\.ts$/, '').replace(/\/$/, '');
    return `${npmPackage}/${relPath}`;
  }

  return npmPackage;
}

// ======================== Complexity Scoring ========================

function scoreComplexity(schema: Partial<ComponentSchema>): ComplexityScore {
  const propsCount = schema.props?.length ?? 0;
  const requiredCount = schema.props?.filter(p => p.required).length ?? 0;
  const hasStatic = schema.hasStaticMembers ? 1 : 0;
  const subCount = schema.subComponents?.length ?? 0;
  const depDepth = schema.dependencyDepth ?? 0;
  const crossRefs = schema.crossFileRefs ?? 0;

  // 加权评分
  const total =
    propsCount * 1 +
    requiredCount * 0.5 +
    depDepth * 3 +
    hasStatic * 10 +
    subCount * 8 +
    crossRefs * 2;

  let level: ComplexityScore['level'];
  let contextLevel: ComplexityScore['contextLevel'];
  let flattenTypes: boolean;

  if (total > 30) {
    level = 'complex';
    contextLevel = 'full-example';
    flattenTypes = true;
  } else if (total > 15) {
    level = 'moderate';
    contextLevel = 'types-with-brief-example';
    flattenTypes = false;
  } else {
    level = 'simple';
    contextLevel = 'types-only';
    flattenTypes = false;
  }

  return { total: Math.round(total), level, contextLevel, flattenTypes };
}

// ======================== Cross-file Reference Counting ========================

function countCrossFileRefs(componentDir: string): number {
  const typesFile = join(componentDir, 'types.d.ts');
  if (!existsSync(typesFile)) return 0;

  const content = readFileSync(typesFile, 'utf-8');
  const importMatches = content.match(/import\s+.*from\s+['"][^'"]+['"]/g);
  return importMatches?.length ?? 0;
}

function countDependencyDepth(componentDir: string, packageRoot: string, maxDepth: number = 5): number {
  const visited = new Set<string>();
  let depth = 0;

  function traverse(dir: string, currentDepth: number) {
    if (currentDepth > maxDepth) return;
    if (visited.has(dir)) return;
    visited.add(dir);

    const typesFile = join(dir, 'types.d.ts');
    if (!existsSync(typesFile)) return;

    const content = readFileSync(typesFile, 'utf-8');
    const importRegex = /from\s+['"](\.[^'"]+)['"]/g;
    let match;

    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1];
      const resolvedDir = resolve(dirname(typesFile), importPath);
      if (resolvedDir.startsWith(packageRoot)) {
        depth = Math.max(depth, currentDepth + 1);
        // 尝试作为目录
        if (existsSync(join(resolvedDir, 'types.d.ts'))) {
          traverse(resolvedDir, currentDepth + 1);
        } else if (existsSync(resolvedDir + '.d.ts')) {
          traverse(dirname(resolvedDir + '.d.ts'), currentDepth + 1);
        }
      }
    }
  }

  traverse(componentDir, 0);
  return depth;
}

// ======================== Sub-component Detection ========================

/**
 * 检测子组件（如 ProForm.BasicForm、ProForm.StepForm）
 * 通过 CompType interface 中的属性来检测
 */
function detectSubComponents(
  component: DiscoveredComponent,
): string[] {
  const { members } = detectStaticMembers(component);
  return members.filter(m => /^[A-Z]/.test(m)); // 大写开头的通常是子组件
}

// ======================== Category Inference ========================

function inferCategory(name: string, props: ExtractedProp[]): string {
  const nameLower = name.toLowerCase();
  const propNames = props.map(p => p.name.toLowerCase());

  if (/form|filter|input|select|picker|cascader|checkbox|radio|stepper|slider|switch|textarea|upload|uploader|scan|verify/.test(nameLower))
    return 'form';
  if (/table|list|grid/.test(nameLower)) return 'table';
  if (/layout|header|page|detail|container|space|divider|safe/.test(nameLower)) return 'layout';
  if (/modal|dialog|drawer|popup|popover|tooltip|toast|message|notification|alert|action-sheet|bottom-sheet|tour|tips/.test(nameLower))
    return 'feedback';
  if (/tab|menu|step|breadcrumb|anchor|nav|dropdown|pagination/.test(nameLower)) return 'navigation';
  if (/tag|badge|progress|skeleton|empty|spin|loading|calendar|tracking|formatter|watermark|image|video|card|number-icon/.test(nameLower))
    return 'data-display';
  if (propNames.includes('value') && propNames.includes('onchange')) return 'input';

  return 'other';
}

function inferTags(schema: ComponentSchema): string[] {
  const tags: string[] = [];
  const nameLower = schema.name.toLowerCase();

  if (nameLower.includes('pro')) tags.push('pro');
  if (schema.hasStaticMembers) tags.push('compound');
  if (schema.subComponents.length > 0) tags.push('nested');
  if (schema.complexity.level === 'complex') tags.push('complex');

  const category = inferCategory(schema.name, schema.props);
  tags.push(category);

  return tags;
}

// ======================== Metadata Output (compatible with metadata/*.json) ========================

interface MetadataOutput {
  library: string;
  version: string;
  generatedAt: string;
  generator: string;
  components: MetadataComponent[];
}

interface MetadataComponent {
  name: string;
  description: string;
  category: string;
  keyProps: string[];
  detailedProps: { name: string; description: string; type: string; required?: boolean }[];
  importPath: string;
  exportName: string;
  subComponents?: string[];
  tags: string[];
}

function generateMetadata(manifest: CSIManifest): MetadataOutput {
  const components: MetadataComponent[] = manifest.components.map(schema => ({
    name: schema.name,
    description: schema.description || `${schema.name} component`,
    category: inferCategory(schema.name, schema.props),
    keyProps: schema.keyProps,
    detailedProps: schema.props.map(p => ({
      name: p.name,
      description: p.description || p.name,
      type: p.type,
      ...(p.required ? { required: true } : {}),
    })),
    importPath: schema.library,
    exportName: schema.name,
    ...(schema.subComponents.length > 0 ? { subComponents: schema.subComponents } : {}),
    tags: inferTags(schema),
    ...(schema.deprecated ? { deprecated: true, deprecationMessage: schema.deprecatedMessage } : {}),
  }));

  return {
    library: manifest.library.npmPackage,
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generator: 'csi-indexer@1.0.0',
    components,
  };
}

// ======================== Comparison with Manual Data ========================

function compareWithManual(manifest: CSIManifest, npmPackage: string): string {
  const metadataPath = join(METADATA_DIR, `${npmPackage}.json`);
  if (!existsSync(metadataPath)) {
    return `  [compare] No manual metadata found at ${relative(PROJECT_ROOT, metadataPath)}`;
  }

  const manual = JSON.parse(readFileSync(metadataPath, 'utf-8'));
  const manualNames = new Set<string>(manual.components.map((c: any) => c.name));
  const csiNames = new Set(manifest.components.map(c => c.name));

  const added = [...csiNames].filter(n => !manualNames.has(n));
  const removed = [...manualNames].filter(n => !csiNames.has(n));

  const lines: string[] = [];
  lines.push(`  [compare] Manual: ${manualNames.size} components, CSI: ${csiNames.size} components`);
  if (added.length > 0) lines.push(`  [compare] + CSI added: ${added.join(', ')}`);
  if (removed.length > 0) lines.push(`  [compare] - CSI missing: ${removed.join(', ')}`);
  if (added.length === 0 && removed.length === 0) lines.push(`  [compare] ✓ Component lists match perfectly`);

  return lines.join('\n');
}

// ======================== Output Generation ========================

function generateManifest(
  npmPackage: string,
  version: string,
  typesEntry: string,
  typesPathPattern: string,
  packageRoot: string,
  schemas: ComponentSchema[],
): CSIManifest {
  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'csi-indexer@1.0.0',
    library: {
      name: npmPackage,
      npmPackage,
      version,
      typesEntry: relative(packageRoot, typesEntry),
      typesPathPattern,
      componentCount: schemas.length,
    },
    components: schemas,
  };
}

function generateCompactIndex(manifest: CSIManifest): string {
  const lines: string[] = [];
  lines.push(`# ${manifest.library.npmPackage} (v${manifest.library.version})`);
  lines.push(`# ${manifest.library.componentCount} components | Generated by CSI Indexer`);
  lines.push('');

  const complex = manifest.components.filter(c => c.complexity.level === 'complex');
  const moderate = manifest.components.filter(c => c.complexity.level === 'moderate');
  const simple = manifest.components.filter(c => c.complexity.level === 'simple');

  if (complex.length > 0) {
    lines.push('## Complex Components (full schema available)');
    for (const c of complex) {
      const keyPropsStr = c.keyProps.length > 0 ? ` \`{${c.keyProps.join(', ')}}\`` : '';
      const staticStr = c.hasStaticMembers ? ` [static: ${c.staticMembers.join(', ')}]` : '';
      const subStr = c.subComponents.length > 0 ? ` [sub: ${c.subComponents.join(', ')}]` : '';
      lines.push(`- **${c.name}** (score:${c.complexity.total}) ${c.description}${keyPropsStr}${staticStr}${subStr}`);
    }
    lines.push('');
  }

  if (moderate.length > 0) {
    lines.push('## Moderate Components (types + example)');
    for (const c of moderate) {
      const keyPropsStr = c.keyProps.length > 0 ? ` \`{${c.keyProps.join(', ')}}\`` : '';
      lines.push(`- **${c.name}** ${c.description}${keyPropsStr}`);
    }
    lines.push('');
  }

  if (simple.length > 0) {
    lines.push('## Simple Components (types only)');
    for (const c of simple) {
      const keyPropsStr = c.keyProps.length > 0 ? ` \`{${c.keyProps.join(', ')}}\`` : '';
      lines.push(`- **${c.name}** ${c.description}${keyPropsStr}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function generateRegistryEntry(manifest: CSIManifest, existingPlatform?: string[]): object {
  const entry: Record<string, unknown> = {
    displayName: manifest.library.npmPackage,
    platform: existingPlatform ?? ['pc'],
    importPrefix: manifest.library.npmPackage,
    npmPackage: manifest.library.npmPackage,
    typesPath: manifest.library.typesPathPattern,
    defaultContextLevel: 'types-only',
    components: {} as Record<string, Record<string, unknown>>,
  };

  const components: Record<string, Record<string, unknown>> = {};
  for (const schema of manifest.components) {
    const compEntry: Record<string, unknown> = {};

    if (schema.complexity.contextLevel !== 'types-only') {
      compEntry.contextLevel = schema.complexity.contextLevel;
    }
    if (schema.complexity.flattenTypes) {
      compEntry.flattenTypes = true;
    }
    if (schema.dirName) {
      compEntry.dirName = schema.dirName;
    }

    if (Object.keys(compEntry).length > 0) {
      components[schema.name] = compEntry;
    }
  }

  entry.components = components;
  return entry;
}

// ======================== 工具函数 ========================

function toKebabCase(name: string): string {
  return name.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
}

function selectKeyProps(props: ExtractedProp[], maxCount: number = 5): string[] {
  // 优先级：required → 常见模式 → 前 N 个
  const commonPatterns = ['value', 'onChange', 'onSubmit', 'children', 'data', 'columns', 'fields', 'form', 'model', 'visible', 'title', 'type', 'mode'];
  const required = props.filter(p => p.required);
  const common = props.filter(p => commonPatterns.some(cp => p.name.toLowerCase().includes(cp)));

  const seen = new Set<string>();
  const result: string[] = [];

  // required 优先
  for (const p of required) {
    if (result.length >= maxCount) break;
    if (!seen.has(p.name)) {
      result.push(p.name);
      seen.add(p.name);
    }
  }
  // 常见模式补充
  for (const p of common) {
    if (result.length >= maxCount) break;
    if (!seen.has(p.name)) {
      result.push(p.name);
      seen.add(p.name);
    }
  }
  // 剩余按顺序补充
  for (const p of props) {
    if (result.length >= maxCount) break;
    if (!seen.has(p.name)) {
      result.push(p.name);
      seen.add(p.name);
    }
  }

  return result;
}

// ======================== 主流程 ========================

function indexPackage(npmPackage: string): CSIManifest | null {
  console.log(`\n📦 Indexing: ${npmPackage}`);
  console.log('─'.repeat(50));

  // 1. 解析包
  const packageRoot = resolvePackageRoot(npmPackage);
  if (!packageRoot) {
    console.log(`  ✗ Package not found in node_modules`);
    return null;
  }

  const pkg = readPackageJson(packageRoot);
  if (!pkg) {
    console.log(`  ✗ Cannot read package.json`);
    return null;
  }

  console.log(`  Version: ${pkg.version}`);

  // 2. 查找 barrel export
  const barrelFile = findBarrelTypesFile(packageRoot, pkg);
  if (!barrelFile) {
    console.log(`  ✗ Cannot find barrel types file`);
    return null;
  }
  console.log(`  Types entry: ${relative(packageRoot, barrelFile)}`);

  // 3. 发现组件
  const components = discoverComponents(barrelFile, packageRoot);
  console.log(`  Discovered: ${components.length} components`);

  // 4. 推断 typesPath 模式
  const typesPathPattern = inferTypesPathPattern(components, packageRoot);
  console.log(`  Types pattern: ${typesPathPattern}`);

  // 5. 为每个组件提取 Schema
  const schemas: ComponentSchema[] = [];
  let propsFound = 0;
  let propsNotFound = 0;

  for (const comp of components) {
    const propsResult = extractComponentProps(comp, packageRoot);
    // 子组件不继承父组件的静态成员
    const staticInfo = comp.isSubComponent
      ? { hasStaticMembers: false, members: [] }
      : detectStaticMembers(comp);
    const subComponents = comp.isSubComponent ? [] : detectSubComponents(comp);
    const crossFileRefs = comp.isSubComponent ? 0 : countCrossFileRefs(comp.resolvedDir);
    const dependencyDepth = comp.isSubComponent ? 0 : countDependencyDepth(comp.resolvedDir, packageRoot);
    const typeImportPath = inferTypeImportPath(comp, packageRoot, npmPackage);

    const partialSchema: Partial<ComponentSchema> = {
      name: comp.name,
      props: propsResult?.props ?? [],
      hasStaticMembers: staticInfo.hasStaticMembers,
      staticMembers: staticInfo.members,
      subComponents,
      dependencyDepth,
      crossFileRefs,
    };

    const complexity = scoreComplexity(partialSchema);

    const expectedDir = toKebabCase(comp.name);
    const needsDirName = comp.isSubComponent || comp.dirName !== expectedDir;

    const schema: ComponentSchema = {
      name: comp.name,
      library: npmPackage,
      version: pkg.version,
      description: propsResult?.description || '',
      importPath: npmPackage,
      typeImportPath,
      ...(needsDirName ? { dirName: comp.dirName } : {}),
      keyProps: selectKeyProps(propsResult?.props ?? []),
      props: propsResult?.props ?? [],
      propsInterfaceName: propsResult?.propsInterfaceName ?? `${comp.name}Props`,
      complexity,
      hasStaticMembers: staticInfo.hasStaticMembers,
      staticMembers: staticInfo.members,
      subComponents,
      dependencyDepth,
      crossFileRefs,
      deprecated: comp.deprecated,
      deprecatedMessage: comp.deprecatedMessage,
    };

    schemas.push(schema);

    if (propsResult) {
      propsFound++;
    } else {
      propsNotFound++;
    }
  }

  console.log(`  Props extracted: ${propsFound}/${components.length} (${propsNotFound} not found)`);

  // 统计复杂度分布
  const complexCount = schemas.filter(s => s.complexity.level === 'complex').length;
  const moderateCount = schemas.filter(s => s.complexity.level === 'moderate').length;
  const simpleCount = schemas.filter(s => s.complexity.level === 'simple').length;
  console.log(`  Complexity: ${complexCount} complex, ${moderateCount} moderate, ${simpleCount} simple`);

  const deprecatedCount = schemas.filter(s => s.deprecated).length;
  if (deprecatedCount > 0) {
    const depNames = schemas.filter(s => s.deprecated).map(s => s.name);
    console.log(`  Deprecated (excluded): ${deprecatedCount} → ${depNames.join(', ')}`);
  }

  // 过滤掉废弃组件 — 不输出到任何索引中
  const activeSchemas = schemas.filter(s => !s.deprecated);

  const flattenCount = activeSchemas.filter(s => s.complexity.flattenTypes).length;
  console.log(`  Active: ${activeSchemas.length} components, Flatten recommended: ${flattenCount}`);

  return generateManifest(npmPackage, pkg.version, barrelFile, typesPathPattern, packageRoot, activeSchemas);
}

function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   CSI (Component Schema Index)       ║');
  console.log('║   Indexer v1.0.0                     ║');
  console.log('╚══════════════════════════════════════╝');

  const args = process.argv.slice(2);

  let packages: string[];

  if (args.length > 0 && !args[0].startsWith('--')) {
    packages = args;
  } else {
    // 从 registry.json 获取已注册的库
    if (existsSync(REGISTRY_PATH)) {
      const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
      packages = Object.values(registry.libraries).map((lib: any) => lib.npmPackage);
      console.log(`\nLoading from registry.json: ${packages.length} libraries`);
    } else {
      console.log('\nNo registry.json found and no package specified.');
      console.log('Usage: npx tsx scripts/csi-indexer.mts <npm-package>');
      process.exit(1);
    }
  }

  const outputDir = OUTPUT_BASE;
  mkdirSync(outputDir, { recursive: true });

  const results: CSIManifest[] = [];

  for (const pkg of packages) {
    const manifest = indexPackage(pkg);
    if (manifest) {
      results.push(manifest);

      const pkgOutputDir = join(outputDir, pkg);
      mkdirSync(pkgOutputDir, { recursive: true });

      const manifestPath = join(pkgOutputDir, 'manifest.json');
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
      console.log(`  → ${relative(PROJECT_ROOT, manifestPath)}`);

      const compactPath = join(pkgOutputDir, 'index.compact.md');
      writeFileSync(compactPath, generateCompactIndex(manifest), 'utf-8');
      console.log(`  → ${relative(PROJECT_ROOT, compactPath)}`);

      // 从已有 registry 读取 platform 信息
      let existingPlatform: string[] | undefined;
      if (existsSync(REGISTRY_PATH)) {
        const reg = JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
        const libKey = Object.keys(reg.libraries ?? {}).find(
          (k: string) => reg.libraries[k].npmPackage === pkg
        );
        if (libKey) existingPlatform = reg.libraries[libKey].platform;
      }

      const registryPath = join(pkgOutputDir, 'registry-suggestion.json');
      writeFileSync(registryPath, JSON.stringify(generateRegistryEntry(manifest, existingPlatform), null, 2), 'utf-8');
      console.log(`  → ${relative(PROJECT_ROOT, registryPath)}`);

      const metadataPath = join(pkgOutputDir, 'metadata.json');
      writeFileSync(metadataPath, JSON.stringify(generateMetadata(manifest), null, 2), 'utf-8');
      console.log(`  → ${relative(PROJECT_ROOT, metadataPath)}`);

      console.log(compareWithManual(manifest, pkg));
    }
  }

  // 汇总
  console.log('\n' + '═'.repeat(50));
  console.log('Summary:');
  for (const manifest of results) {
    const { library } = manifest;
    const complexCount = manifest.components.filter(c => c.complexity.level === 'complex').length;
    console.log(`  ${library.npmPackage}@${library.version}: ${library.componentCount} components (${complexCount} complex)`);
  }
  console.log(`\nOutput: ${relative(PROJECT_ROOT, outputDir)}/`);
}

main();
