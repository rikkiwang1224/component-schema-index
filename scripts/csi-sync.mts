/**
 * CSI Sync — 将 CSI 索引器输出智能合并到 registry.json 和 metadata/*.json
 *
 * 使用方式:
 *   npx tsx scripts/csi-sync.mts                    # 同步所有库
 *   npx tsx scripts/csi-sync.mts --dry-run           # 仅展示差异，不写文件
 *   npx tsx scripts/csi-sync.mts --library ssc-ui-react  # 只同步指定库
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import {
  PROJECT_ROOT,
  CSI_DIR,
  REGISTRY_PATH,
  METADATA_DIR,
} from './paths.mts';

// ======================== 颜色输出 ========================

interface Registry {
  $schema?: string;
  version: string;
  libraries: Record<string, LibraryConfig>;
}

interface LibraryConfig {
  displayName: string;
  platform: string[];
  importPrefix: string;
  npmPackage: string;
  typesPath: string | string[];
  examplesDir?: string;
  defaultContextLevel: string;
  skill?: string;
  csi?: CSIMetadata;
  components?: Record<string, ComponentConfig>;
}

interface CSIMetadata {
  lastIndexed: string;
  discoveredCount: number;
  typesEntry: string;
}

interface ComponentConfig {
  contextLevel?: string;
  dirName?: string;
  typesPath?: string;
  aliases?: string[];
  flattenTypes?: boolean;
  complexity?: { score: number; level: string };
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
  components: CSIComponentSchema[];
}

interface CSIComponentSchema {
  name: string;
  dirName?: string;
  complexity: {
    total: number;
    level: string;
    contextLevel: string;
    flattenTypes: boolean;
  };
  [key: string]: unknown;
}

interface CSISuggestion {
  displayName: string;
  platform: string[];
  importPrefix: string;
  npmPackage: string;
  typesPath: string;
  defaultContextLevel: string;
  components: Record<string, { contextLevel?: string; flattenTypes?: boolean; dirName?: string }>;
}

interface MetadataFile {
  library: string;
  version: string;
  generatedAt?: string;
  generator?: string;
  components: MetadataComponent[];
}

interface MetadataComponent {
  name: string;
  description: string;
  category?: string;
  keyProps: string[];
  detailedProps?: DetailedProp[];
  importPath?: string;
  exportName?: string;
  subComponents?: string[];
  tags?: string[];
  examples?: string[];
  deprecated?: boolean;
  deprecationMessage?: string;
}

interface DetailedProp {
  name: string;
  description: string;
  type: string;
  default?: string;
  required?: boolean;
  deprecated?: boolean;
}


// ======================== 类型定义 ========================

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function added(text: string) { return `${C.green}+ ${text}${C.reset}`; }
function changed(text: string) { return `${C.yellow}~ ${text}${C.reset}`; }
function preserved(text: string) { return `${C.dim}= ${text}${C.reset}`; }
function removed(text: string) { return `${C.red}- ${text}${C.reset}`; }
function warn(text: string) { return `${C.yellow}⚠ ${text}${C.reset}`; }
function heading(text: string) { return `${C.bold}${C.cyan}${text}${C.reset}`; }

// ======================== 文件读写 ========================

function readJSON<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeJSON(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// ======================== CSI 包发现 ========================

interface CSIPackage {
  name: string;
  dir: string;
  manifest: CSIManifest;
  suggestion: CSISuggestion;
  metadata: MetadataFile;
}

function discoverCSIPackages(): CSIPackage[] {
  if (!existsSync(CSI_DIR)) return [];

  const packages: CSIPackage[] = [];
  for (const entry of readdirSync(CSI_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgDir = join(CSI_DIR, entry.name);
    const manifestPath = join(pkgDir, 'manifest.json');
    const suggestionPath = join(pkgDir, 'registry-suggestion.json');
    const metadataPath = join(pkgDir, 'metadata.json');

    if (!existsSync(manifestPath) || !existsSync(suggestionPath) || !existsSync(metadataPath)) continue;

    packages.push({
      name: entry.name,
      dir: pkgDir,
      manifest: readJSON<CSIManifest>(manifestPath)!,
      suggestion: readJSON<CSISuggestion>(suggestionPath)!,
      metadata: readJSON<MetadataFile>(metadataPath)!,
    });
  }
  return packages;
}

// ======================== Registry 合并 ========================

interface RegistryChanges {
  libraryName: string;
  libChanges: FieldChange[];
  compAdded: string[];
  compUpdated: Array<{ name: string; changes: FieldChange[] }>;
  compManualOnly: string[];
}

interface FieldChange {
  field: string;
  type: 'added' | 'changed' | 'preserved';
  oldValue?: unknown;
  newValue?: unknown;
}

function findLibraryKey(registry: Registry, npmPackage: string): string | null {
  for (const [key, lib] of Object.entries(registry.libraries)) {
    if (lib.npmPackage === npmPackage) return key;
  }
  return null;
}

function mergeLibraryConfig(
  existing: LibraryConfig,
  suggestion: CSISuggestion,
  manifest: CSIManifest,
): { merged: LibraryConfig; changes: RegistryChanges } {
  const changes: RegistryChanges = {
    libraryName: existing.displayName,
    libChanges: [],
    compAdded: [],
    compUpdated: [],
    compManualOnly: [],
  };

  const merged = { ...existing };

  // --- 库级字段 ---

  // CSI 覆盖：csi 元数据
  const newCSI: CSIMetadata = {
    lastIndexed: new Date().toISOString().slice(0, 10),
    discoveredCount: manifest.library.componentCount,
    typesEntry: manifest.library.typesEntry,
  };
  if (JSON.stringify(merged.csi) !== JSON.stringify(newCSI)) {
    changes.libChanges.push({ field: 'csi', type: merged.csi ? 'changed' : 'added', oldValue: merged.csi, newValue: newCSI });
  }
  merged.csi = newCSI;

  // 手动优先（保留现有值）：displayName, platform, examplesDir, skill — 不动

  // CSI 更新（如现有无值则采用 CSI）：typesPath, importPrefix, npmPackage
  if (!merged.typesPath && suggestion.typesPath) {
    merged.typesPath = suggestion.typesPath;
    changes.libChanges.push({ field: 'typesPath', type: 'added', newValue: suggestion.typesPath });
  }
  if (!merged.importPrefix && suggestion.importPrefix) {
    merged.importPrefix = suggestion.importPrefix;
    changes.libChanges.push({ field: 'importPrefix', type: 'added', newValue: suggestion.importPrefix });
  }

  // 保守处理：defaultContextLevel
  if (!merged.defaultContextLevel && suggestion.defaultContextLevel) {
    merged.defaultContextLevel = suggestion.defaultContextLevel;
    changes.libChanges.push({ field: 'defaultContextLevel', type: 'added', newValue: suggestion.defaultContextLevel });
  }

  // --- 组件级字段 ---
  if (!merged.components) merged.components = {};

  const existingCompNames = new Set(Object.keys(merged.components));
  const csiCompNames = new Set(Object.keys(suggestion.components));

  // 合并 CSI 中有的组件
  for (const [compName, csiComp] of Object.entries(suggestion.components)) {
    const existing = merged.components[compName];

    if (!existing) {
      // 新组件：CSI 发现，手工 registry 中没有
      const newEntry: ComponentConfig = {};
      if (csiComp.contextLevel) newEntry.contextLevel = csiComp.contextLevel;
      if (csiComp.flattenTypes) newEntry.flattenTypes = true;
      if (csiComp.dirName) newEntry.dirName = csiComp.dirName;
      merged.components[compName] = newEntry;
      changes.compAdded.push(compName);
    } else {
      // 已有组件：按字段合并
      const compChanges: FieldChange[] = [];

      // contextLevel: CSI 建议 + 手动覆盖
      if (csiComp.contextLevel && !existing.contextLevel) {
        existing.contextLevel = csiComp.contextLevel;
        compChanges.push({ field: 'contextLevel', type: 'added', newValue: csiComp.contextLevel });
      } else if (csiComp.contextLevel && existing.contextLevel && existing.contextLevel !== csiComp.contextLevel) {
        compChanges.push({ field: 'contextLevel', type: 'preserved', oldValue: existing.contextLevel, newValue: csiComp.contextLevel });
      }

      // flattenTypes: CSI 建议 + 手动覆盖
      if (csiComp.flattenTypes && existing.flattenTypes === undefined) {
        existing.flattenTypes = true;
        compChanges.push({ field: 'flattenTypes', type: 'added', newValue: true });
      } else if (csiComp.flattenTypes && existing.flattenTypes === false) {
        compChanges.push({ field: 'flattenTypes', type: 'preserved', oldValue: false, newValue: true });
      }

      // dirName: 手动优先（绝不覆盖）
      if (csiComp.dirName && !existing.dirName) {
        existing.dirName = csiComp.dirName;
        compChanges.push({ field: 'dirName', type: 'added', newValue: csiComp.dirName });
      } else if (csiComp.dirName && existing.dirName && existing.dirName !== csiComp.dirName) {
        compChanges.push({ field: 'dirName', type: 'preserved', oldValue: existing.dirName, newValue: csiComp.dirName });
      }

      if (compChanges.length > 0) {
        changes.compUpdated.push({ name: compName, changes: compChanges });
      }
    }
  }

  // 仅存在于手工 registry 的组件：保留不删，记录
  for (const compName of existingCompNames) {
    if (!csiCompNames.has(compName)) {
      changes.compManualOnly.push(compName);
    }
  }

  // 排序 components
  const sortedComponents: Record<string, ComponentConfig> = {};
  for (const key of Object.keys(merged.components).sort()) {
    sortedComponents[key] = merged.components[key];
  }
  merged.components = sortedComponents;

  return { merged, changes };
}

// ======================== Metadata 合并 ========================

interface MetadataChanges {
  libraryName: string;
  totalBefore: number;
  totalAfter: number;
  componentsAdded: string[];
  componentsRemoved: string[];
  descriptionsPreserved: number;
  examplesPreserved: number;
  propsPreserved: number;
}

function isGenericDescription(name: string, desc: string): boolean {
  const base = name.replace(/\./g, '');
  const generics = [
    `${base} component`,
    `${base} 组件`,
    `${name} component`,
    `${name} 组件`,
    '',
  ];
  return generics.some(g => desc.toLowerCase().trim() === g.toLowerCase().trim());
}

/**
 * CSI 自动生成的 prop description 通常只是 prop 名本身（如 "type"、"className"）。
 * 如果手工版有更丰富的描述，应保留。
 */
function isGenericPropDescription(propName: string, description: string): boolean {
  if (!description) return true;
  return description.trim().toLowerCase() === propName.trim().toLowerCase();
}

/**
 * 将手工增强的 detailedProps 合并到 CSI 的 prop 列表上。
 * - CSI 决定「有哪些 prop」（新增/删除由 CSI 控制）
 * - 手工增强的 description / type / default / defaultValue 保留（当 CSI 的是泛型时）
 */
function mergeDetailedProps(
  csiProps: DetailedProp[],
  manualProps: DetailedProp[],
): { merged: DetailedProp[]; preservedCount: number } {
  const manualMap = new Map(manualProps.map(p => [p.name, p]));
  let preservedCount = 0;

  const merged = csiProps.map(csiProp => {
    const manualProp = manualMap.get(csiProp.name);
    if (!manualProp) return csiProp;

    const csiIsGeneric = isGenericPropDescription(csiProp.name, csiProp.description);
    const manualIsGeneric = isGenericPropDescription(manualProp.name, manualProp.description);

    if (!manualIsGeneric && csiIsGeneric) {
      preservedCount++;
      return { ...csiProp, ...manualProp };
    }
    return csiProp;
  });

  return { merged, preservedCount };
}

function mergeMetadata(
  csiMeta: MetadataFile,
  manualMeta: MetadataFile | null,
  importPrefix: string,
): { merged: MetadataFile; changes: MetadataChanges } {
  const changes: MetadataChanges = {
    libraryName: csiMeta.library,
    totalBefore: manualMeta?.components.length ?? 0,
    totalAfter: csiMeta.components.length,
    componentsAdded: [],
    componentsRemoved: [],
    descriptionsPreserved: 0,
    examplesPreserved: 0,
    propsPreserved: 0,
  };

  const manualMap = new Map<string, MetadataComponent>();
  if (manualMeta) {
    for (const comp of manualMeta.components) {
      manualMap.set(comp.name, comp);
    }
  }

  const mergedComponents: MetadataComponent[] = [];

  for (const csiComp of csiMeta.components) {
    const manual = manualMap.get(csiComp.name);
    const merged = { ...csiComp };

    // importPath: 使用 registry 的 importPrefix
    merged.importPath = importPrefix;

    if (manual) {
      // 手工有更好的描述：保留
      if (!isGenericDescription(csiComp.name, manual.description) && isGenericDescription(csiComp.name, csiComp.description)) {
        merged.description = manual.description;
        changes.descriptionsPreserved++;
      }

      // 保留手工的 examples
      if (manual.examples && manual.examples.length > 0) {
        merged.examples = manual.examples;
        changes.examplesPreserved++;
      }

      // 保留手工的 tags（如果 CSI 只生成了泛型 tags 而手工有更精确的）
      if (manual.tags && manual.tags.length > 0 && csiComp.tags) {
        const csiHasOnlyCategory = csiComp.tags.length <= 2;
        if (csiHasOnlyCategory && manual.tags.length > csiComp.tags.length) {
          merged.tags = manual.tags;
        }
      }

      // 保留手工新增的 keyProps（CSI 不一定覆盖所有有用 prop）
      if (manual.keyProps && manual.keyProps.length > 0) {
        const csiKeySet = new Set(merged.keyProps);
        const manualExtras = manual.keyProps.filter(k => !csiKeySet.has(k));
        if (manualExtras.length > 0) {
          merged.keyProps = [...merged.keyProps, ...manualExtras];
        }
      }

      // 保留手工增强的 detailedProps（description / type / defaultValue 等）
      if (manual.detailedProps && manual.detailedProps.length > 0 && merged.detailedProps) {
        const { merged: mergedProps, preservedCount } = mergeDetailedProps(
          merged.detailedProps,
          manual.detailedProps,
        );
        merged.detailedProps = mergedProps;
        changes.propsPreserved += preservedCount;
      }
    } else {
      changes.componentsAdded.push(csiComp.name);
    }

    mergedComponents.push(merged);
  }

  // 记录仅存在于手工 metadata 的组件（不加入合并结果，因为 CSI 是权威来源）
  if (manualMeta) {
    const csiNames = new Set(csiMeta.components.map(c => c.name));
    for (const comp of manualMeta.components) {
      if (!csiNames.has(comp.name)) {
        changes.componentsRemoved.push(comp.name);
      }
    }
  }

  const merged: MetadataFile = {
    library: csiMeta.library,
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generator: 'csi-sync@1.0.0',
    components: mergedComponents,
  };

  return { merged, changes };
}

// ======================== 差异输出 ========================

function printRegistryChanges(changes: RegistryChanges) {
  console.log(`  ${heading('Registry:')}`);

  for (const change of changes.libChanges) {
    if (change.type === 'added') {
      console.log(`    ${added(`${change.field}: ${formatValue(change.newValue)}`)}`);
    } else if (change.type === 'changed') {
      console.log(`    ${changed(`${change.field}: ${formatValue(change.oldValue)} → ${formatValue(change.newValue)}`)}`);
    } else {
      console.log(`    ${preserved(`${change.field}: ${formatValue(change.oldValue)} (manual preserved)`)}`);
    }
  }

  if (changes.compAdded.length > 0) {
    console.log(`    ${added(`${changes.compAdded.length} new components: ${changes.compAdded.join(', ')}`)}`);
  }

  for (const comp of changes.compUpdated) {
    for (const change of comp.changes) {
      if (change.type === 'added') {
        console.log(`    ${added(`${comp.name}.${change.field}: ${formatValue(change.newValue)}`)}`);
      } else if (change.type === 'preserved') {
        console.log(`    ${preserved(`${comp.name}.${change.field}: ${formatValue(change.oldValue)} (manual, CSI suggests ${formatValue(change.newValue)})`)}`);
      }
    }
  }

  if (changes.compManualOnly.length > 0) {
    console.log(`    ${warn(`${changes.compManualOnly.length} manual-only (not in CSI): ${changes.compManualOnly.join(', ')}`)}`);
  }

  const totalChanges = changes.libChanges.length + changes.compAdded.length +
    changes.compUpdated.reduce((n, c) => n + c.changes.filter(ch => ch.type !== 'preserved').length, 0);
  if (totalChanges === 0) {
    console.log(`    ${C.dim}(no changes)${C.reset}`);
  }
}

function printMetadataChanges(changes: MetadataChanges) {
  console.log(`  ${heading('Metadata:')}`);
  console.log(`    ${changed(`${changes.totalBefore} → ${changes.totalAfter} components`)}`);

  if (changes.componentsAdded.length > 0) {
    console.log(`    ${added(`${changes.componentsAdded.length} new: ${changes.componentsAdded.slice(0, 10).join(', ')}${changes.componentsAdded.length > 10 ? ` (+${changes.componentsAdded.length - 10} more)` : ''}`)}`);
  }
  if (changes.componentsRemoved.length > 0) {
    console.log(`    ${removed(`${changes.componentsRemoved.length} removed: ${changes.componentsRemoved.join(', ')}`)}`);
  }
  if (changes.descriptionsPreserved > 0) {
    console.log(`    ${preserved(`${changes.descriptionsPreserved} descriptions preserved from manual`)}`);
  }
  if (changes.examplesPreserved > 0) {
    console.log(`    ${preserved(`${changes.examplesPreserved} examples preserved from manual`)}`);
  }
  if (changes.propsPreserved > 0) {
    console.log(`    ${preserved(`${changes.propsPreserved} prop descriptions preserved from manual`)}`);
  }
}

function formatValue(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ======================== 主流程 ========================

function main() {
  console.log(`${C.bold}CSI Sync${C.reset} — Merging CSI output into registry and metadata\n`);

  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const libIdx = args.indexOf('--library');
  const targetLib = libIdx >= 0 ? args[libIdx + 1] : null;

  if (dryRun) {
    console.log(`${C.magenta}[DRY RUN] No files will be written${C.reset}\n`);
  }

  // 1. 发现 CSI 包
  const csiPackages = discoverCSIPackages();
  if (csiPackages.length === 0) {
    console.log('No CSI output found. Run `pnpm csi:index` first.');
    process.exit(1);
  }
  console.log(`Found ${csiPackages.length} CSI packages: ${csiPackages.map(p => p.name).join(', ')}\n`);

  // 2. 读取现有 registry
  const registry = readJSON<Registry>(REGISTRY_PATH);
  if (!registry) {
    console.log(`Cannot read ${relative(PROJECT_ROOT, REGISTRY_PATH)}`);
    process.exit(1);
  }
  const originalRegistry = JSON.parse(JSON.stringify(registry));

  // 3. 逐包处理
  const allRegChanges: RegistryChanges[] = [];
  const allMetaChanges: MetadataChanges[] = [];
  let metaFilesWritten = 0;

  for (const pkg of csiPackages) {
    if (targetLib && pkg.name !== targetLib) continue;

    console.log(heading(`[${pkg.name}]`));

    // --- Registry 合并 ---
    const libKey = findLibraryKey(registry, pkg.manifest.library.npmPackage);
    if (!libKey) {
      console.log(`  ${warn(`Library not found in registry.json for npmPackage="${pkg.manifest.library.npmPackage}", skipping registry merge`)}`);
    } else {
      const { merged, changes } = mergeLibraryConfig(
        registry.libraries[libKey],
        pkg.suggestion,
        pkg.manifest,
      );
      registry.libraries[libKey] = merged;
      allRegChanges.push(changes);
      printRegistryChanges(changes);
    }

    // --- Metadata 合并 ---
    const manualMetaPath = join(METADATA_DIR, `${pkg.name}.json`);
    const manualMeta = readJSON<MetadataFile>(manualMetaPath);
    const importPrefix = libKey ? registry.libraries[libKey].importPrefix : pkg.manifest.library.npmPackage;

    const { merged: mergedMeta, changes: metaChanges } = mergeMetadata(
      pkg.metadata,
      manualMeta,
      importPrefix,
    );
    allMetaChanges.push(metaChanges);
    printMetadataChanges(metaChanges);

    if (!dryRun) {
      writeJSON(manualMetaPath, mergedMeta);
      metaFilesWritten++;
    }

    console.log('');
  }

  // 4. 写入 registry.json
  if (!dryRun && JSON.stringify(registry) !== JSON.stringify(originalRegistry)) {
    writeJSON(REGISTRY_PATH, registry);
  }

  // 5. 汇总
  console.log('═'.repeat(55));
  console.log(heading('Summary:'));

  const totalCompAdded = allRegChanges.reduce((n, c) => n + c.compAdded.length, 0);
  const totalFieldChanges = allRegChanges.reduce((n, c) =>
    n + c.libChanges.filter(ch => ch.type !== 'preserved').length +
    c.compUpdated.reduce((m, u) => m + u.changes.filter(ch => ch.type !== 'preserved').length, 0), 0);

  console.log(`  registry.json: ${allRegChanges.length} libraries processed, ${totalCompAdded} components added, ${totalFieldChanges} fields changed`);
  console.log(`  metadata: ${allMetaChanges.length} files processed`);

  for (const mc of allMetaChanges) {
    const delta = mc.totalAfter - mc.totalBefore;
    const sign = delta > 0 ? '+' : delta === 0 ? '±' : '';
    console.log(`    ${mc.libraryName}: ${mc.totalBefore} → ${mc.totalAfter} (${sign}${delta})`);
  }

  if (dryRun) {
    console.log(`\n${C.magenta}Run without --dry-run to apply changes.${C.reset}`);
  } else {
    console.log(`\n${C.green}✓ Changes applied.${C.reset}`);
    console.log(`  → ${relative(PROJECT_ROOT, REGISTRY_PATH)}`);
    for (const mc of allMetaChanges) {
      console.log(`  → ${relative(PROJECT_ROOT, join(METADATA_DIR, `${mc.libraryName}.json`))}`);
    }
  }
}

main();
