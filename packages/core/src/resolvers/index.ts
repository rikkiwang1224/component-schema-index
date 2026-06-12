import { readFileSync, existsSync, readdirSync } from 'fs';
import { dirname, resolve as pathResolve, relative as pathRelative, join } from 'path';
import type { ClassifiedFile, LibraryConfig, LibraryId } from '../types.js';
import {
  getComponentConfig,
  getLibraryConfig,
  componentNameToDir,
} from '../registry/loader.js';
import { getExamplesDir, getFlattenedTypesDir, getLogger, getNodeModulesRoot } from '../config.js';

const logger = () => getLogger();

function findPrimaryTypesFile(
  libConfig: LibraryConfig,
  packageDir: string,
  compDir: string,
): string | null {
  const typesPathPatterns = Array.isArray(libConfig.typesPath)
    ? libConfig.typesPath
    : [libConfig.typesPath];

  for (const pattern of typesPathPatterns) {
    const resolvedPath = pattern.replace(/\{component\}/g, compDir);
    const fullPath = `${packageDir}/${resolvedPath}`;
    if (existsSync(fullPath)) return fullPath;
  }

  const fallbackPaths = [
    `typings/components/${compDir}/types.d.ts`,
    `dist/esm/components/${compDir}/types.d.ts`,
    `dist/esm/components/${compDir}/${compDir}.d.ts`,
    `es/components/${compDir}/types.d.ts`,
    `lib/components/${compDir}/types.d.ts`,
  ];

  for (const fallback of fallbackPaths) {
    const fullPath = `${packageDir}/${fallback}`;
    if (existsSync(fullPath)) return fullPath;
  }

  return null;
}

function extractImportPaths(content: string): Array<{ path: string; isRelative: boolean }> {
  const pattern = /(?:import|export)\s+(?:type\s+)?(?:\{[\s\S]*?\}|\*(?:\s+as\s+\w+)?)\s+from\s+['"]([^'"]+)['"]/g;
  const results: Array<{ path: string; isRelative: boolean }> = [];
  let match;
  while ((match = pattern.exec(content)) !== null) {
    results.push({
      path: match[1],
      isRelative: match[1].startsWith('.'),
    });
  }
  return results;
}

function resolveImportFilePath(importPath: string, currentFilePath: string): string | null {
  const dir = dirname(currentFilePath);
  const candidates = [
    pathResolve(dir, `${importPath}.d.ts`),
    pathResolve(dir, `${importPath}.ts`),
    pathResolve(dir, `${importPath}/index.d.ts`),
    pathResolve(dir, importPath),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface DeepResolveOptions {
  maxDepth?: number;
  maxFiles?: number;
  maxTotalSize?: number;
}

function deepResolveTypes(
  primaryFilePath: string,
  packageRoot: string,
  options: DeepResolveOptions = {},
): string {
  const { maxDepth = 3, maxFiles = 30, maxTotalSize = 100 * 1024 } = options;

  const queue: Array<{ filePath: string; depth: number }> = [{ filePath: primaryFilePath, depth: 0 }];
  const visited = new Set<string>();
  const resolvedFiles: Array<{ relativePath: string; content: string; depth: number }> = [];
  let totalSize = 0;

  while (queue.length > 0) {
    const { filePath, depth } = queue.shift()!;
    const normalized = pathResolve(filePath);

    if (visited.has(normalized)) continue;
    if (depth > maxDepth) continue;
    if (resolvedFiles.length >= maxFiles) break;
    if (totalSize >= maxTotalSize) break;

    visited.add(normalized);

    try {
      const content = readFileSync(normalized, 'utf-8');
      if (!content.trim()) continue;

      const relativePath = pathRelative(packageRoot, normalized);
      resolvedFiles.push({ relativePath, content, depth });
      totalSize += content.length;

      for (const imp of extractImportPaths(content)) {
        if (!imp.isRelative) continue;
        const resolved = resolveImportFilePath(imp.path, normalized);
        if (resolved && !visited.has(pathResolve(resolved))) {
          queue.push({ filePath: resolved, depth: depth + 1 });
        }
      }
    } catch {
      // ignore read errors
    }
  }

  if (resolvedFiles.length === 0) return '';
  if (resolvedFiles.length === 1) return resolvedFiles[0].content;

  logger().info('Deep resolve completed', {
    primaryFile: pathRelative(packageRoot, primaryFilePath),
    totalFiles: resolvedFiles.length,
    totalSize,
  });

  return resolvedFiles
    .map((file, idx) => {
      const label = idx === 0 ? `${file.relativePath} (primary)` : `ref: ${file.relativePath}`;
      return `// ========== ${label} ==========\n${file.content}`;
    })
    .join('\n\n');
}

function resolveFlattenedTypes(library: LibraryId, componentName: string): string | null {
  const compConfig = getComponentConfig(library, componentName);
  if (!compConfig.flattenTypes) return null;

  const flattenedPath = join(getFlattenedTypesDir(), library, `${componentName}.d.ts`);
  if (!existsSync(flattenedPath)) {
    logger().debug('Flattened types file not found', { library, componentName, path: flattenedPath });
    return null;
  }

  try {
    const content = readFileSync(flattenedPath, 'utf-8');
    if (content.trim()) {
      logger().debug('Resolved from flattened types', { library, componentName });
      return content;
    }
  } catch {
    // fall through
  }

  return null;
}

export function resolveTypes(library: LibraryId, componentName: string): string | null {
  const flattened = resolveFlattenedTypes(library, componentName);
  if (flattened) return flattened;

  const libConfig = getLibraryConfig(library);
  if (!libConfig) {
    logger().warn('Library not found in registry', { library });
    return null;
  }

  const nodeModules = getNodeModulesRoot();
  if (!existsSync(nodeModules)) {
    logger().warn('node_modules not found', { nodeModules });
    return null;
  }

  const compDir = componentNameToDir(componentName, library);
  const packageDir = `${nodeModules}/${libConfig.npmPackage}`;
  const primaryFilePath = findPrimaryTypesFile(libConfig, packageDir, compDir);

  if (!primaryFilePath) {
    logger().warn('Types not found in npm package', { library, componentName, compDir });
    return null;
  }

  const content = deepResolveTypes(primaryFilePath, packageDir);
  return content || null;
}

export function listComponents(library: LibraryId): string[] {
  const libConfig = getLibraryConfig(library);
  if (!libConfig) return [];

  const nodeModules = getNodeModulesRoot();
  if (!existsSync(nodeModules)) return [];

  const typesPath = Array.isArray(libConfig.typesPath) ? libConfig.typesPath[0] : libConfig.typesPath;
  const componentsDir = typesPath.split('/{component}')[0];
  const fullDir = `${nodeModules}/${libConfig.npmPackage}/${componentsDir}`;

  if (!existsSync(fullDir)) return [];

  try {
    return readdirSync(fullDir, { withFileTypes: true })
      .filter((d: { isDirectory(): boolean; name: string }) => d.isDirectory())
      .filter((d: { name: string }) => !d.name.startsWith('_'))
      .map((d: { name: string }) => d.name);
  } catch {
    return [];
  }
}

function readFilesRecursive(dir: string, baseDir: string): ClassifiedFile[] {
  const files: ClassifiedFile[] = [];
  if (!existsSync(dir)) return files;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    const relativePath = fullPath.replace(`${baseDir}/`, '');

    if (entry.isDirectory()) {
      files.push(...readFilesRecursive(fullPath, baseDir));
    } else if (entry.isFile()) {
      const validExts = ['.tsx', '.ts', '.jsx', '.js', '.less', '.css'];
      if (!validExts.some((ext) => entry.name.endsWith(ext))) continue;

      try {
        files.push({
          path: relativePath,
          name: entry.name,
          content: readFileSync(fullPath, 'utf-8'),
        });
      } catch (error) {
        logger().warn('Failed to read example file', { path: fullPath, error: String(error) });
      }
    }
  }

  return files;
}

export function resolveExamples(library: LibraryId, componentName: string): ClassifiedFile[] {
  const compDir = componentNameToDir(componentName, library);
  const examplesDir = join(getExamplesDir(), library, compDir);

  if (!existsSync(examplesDir)) {
    logger().debug('No examples found', { library, componentName, dir: examplesDir });
    return [];
  }

  const files = readFilesRecursive(examplesDir, examplesDir);
  logger().debug('Resolved examples', { library, componentName, count: files.length });
  return files;
}

export function hasExamples(library: LibraryId, componentName: string): boolean {
  const compDir = componentNameToDir(componentName, library);
  return existsSync(join(getExamplesDir(), library, compDir));
}

function extractExampleMeta(content: string): { title: string; desc: string } {
  const jsdocMatch = content.match(/\/\*\*\s*([\s\S]*?)\s*\*\//);
  if (!jsdocMatch) return { title: '', desc: '' };

  const block = jsdocMatch[1];
  const titleMatch = block.match(/\*\s*title:\s*(.+)/);
  const title = titleMatch?.[1]?.trim() ?? '';

  const descParts: string[] = [];
  const lines = block.split('\n');
  let inDesc = false;
  for (const line of lines) {
    const trimmed = line.replace(/^\s*\*\s?/, '');
    if (trimmed.startsWith('desc:')) {
      inDesc = true;
      const rest = trimmed.replace(/^desc:\s*/, '');
      if (rest) descParts.push(rest);
    } else if (inDesc) {
      if (trimmed.startsWith('title:') || trimmed === '/') break;
      descParts.push(trimmed);
    }
  }

  return { title, desc: descParts.join(' ').trim() };
}

function expandFeatureTokens(feature: string): string[] {
  const lower = feature.toLowerCase();
  const parts = lower.split(/[-_\s]+/).filter(Boolean);
  const tokens = [lower, ...parts];
  if (parts.length >= 2) tokens.push(parts.join(''));
  return tokens;
}

function scoreExamplePerFeature(
  file: ClassifiedFile,
  featureTokenSets: string[][],
): { total: number; perFeature: number[] } {
  const nameLC = file.name.toLowerCase().replace(/\.[^.]+$/, '');
  const { title, desc } = extractExampleMeta(file.content);
  const titleLC = title.toLowerCase();
  const descLC = desc.toLowerCase();
  const contentLC = file.content.toLowerCase();

  const perFeature: number[] = [];
  let total = 0;

  for (const tokens of featureTokenSets) {
    let featureScore = 0;
    for (const tok of tokens) {
      if (nameLC.includes(tok)) featureScore += 3;
      if (titleLC.includes(tok)) featureScore += 3;
      if (descLC.includes(tok)) featureScore += 2;
      else if (contentLC.includes(tok)) featureScore += 1;
    }
    perFeature.push(featureScore);
    total += featureScore;
  }

  if (nameLC.startsWith('issue-')) {
    total = Math.floor(total * 0.5);
    for (let i = 0; i < perFeature.length; i++) {
      perFeature[i] = Math.floor(perFeature[i] * 0.5);
    }
  }

  return { total, perFeature };
}

export function rankExamplesByRelevance(
  examples: ClassifiedFile[],
  relevantFeatures: string[],
): ClassifiedFile[] {
  if (!relevantFeatures.length) return examples;

  const featureTokenSets = relevantFeatures.map(expandFeatureTokens);
  const scored = examples.map((file, idx) => ({
    file,
    ...scoreExamplePerFeature(file, featureTokenSets),
    originalIdx: idx,
  }));

  const selected = new Set<number>();
  const diverseTop: typeof scored = [];

  for (let fi = 0; fi < relevantFeatures.length; fi++) {
    let bestIdx = -1;
    let bestScore = 0;
    for (let ei = 0; ei < scored.length; ei++) {
      if (selected.has(ei)) continue;
      if (scored[ei].perFeature[fi] > bestScore) {
        bestScore = scored[ei].perFeature[fi];
        bestIdx = ei;
      }
    }
    if (bestIdx >= 0 && bestScore > 0) {
      selected.add(bestIdx);
      diverseTop.push(scored[bestIdx]);
    }
  }

  const remaining = scored
    .filter((_, idx) => !selected.has(idx))
    .sort((a, b) => (b.total !== a.total ? b.total - a.total : a.originalIdx - b.originalIdx));

  return [...diverseTop, ...remaining].map((s) => s.file);
}
