import { readFileSync } from 'fs';
import type { ComponentConfig, ContextLevel, LibraryConfig, LibraryId, Registry } from '../types.js';
import { getRegistryPath, onCsiCacheReset } from '../config.js';

let registryCache: Registry | null = null;

onCsiCacheReset(() => {
  registryCache = null;
});

export function loadRegistry(): Registry {
  if (!registryCache) {
    const content = readFileSync(getRegistryPath(), 'utf-8');
    registryCache = JSON.parse(content) as Registry;
  }
  return registryCache;
}

export function getLibraryConfig(library: LibraryId): LibraryConfig | null {
  const registry = loadRegistry();
  return registry.libraries[library] ?? null;
}

export function getComponentConfig(
  library: LibraryId,
  componentName: string,
): ComponentConfig & { contextLevel: ContextLevel } {
  const libConfig = getLibraryConfig(library);
  if (!libConfig) {
    return { contextLevel: 'types-only' };
  }

  const compConfig = libConfig.components?.[componentName] ?? {};
  return {
    ...compConfig,
    contextLevel: compConfig.contextLevel ?? libConfig.defaultContextLevel,
  };
}

export function getContextLevel(library: LibraryId, componentName: string): ContextLevel {
  return getComponentConfig(library, componentName).contextLevel;
}

export function getRegisteredLibraries(): LibraryId[] {
  return Object.keys(loadRegistry().libraries);
}

export function isRegisteredLibrary(library: string): library is LibraryId {
  return library in loadRegistry().libraries;
}

export function componentNameToDir(componentName: string, library?: LibraryId): string {
  if (library) {
    const libConfig = getLibraryConfig(library);
    const compConfig = libConfig?.components?.[componentName];
    if (compConfig?.dirName) {
      return compConfig.dirName;
    }
  }

  if (componentName.includes('.')) {
    const parent = componentName.split('.')[0];
    return parent
      .replace(/([A-Z])/g, '-$1')
      .toLowerCase()
      .replace(/^-/, '');
  }

  return componentName
    .replace(/([A-Z])/g, '-$1')
    .toLowerCase()
    .replace(/^-/, '');
}

export function getLibrariesByPlatform(platform: string): LibraryId[] {
  const registry = loadRegistry();
  return Object.entries(registry.libraries)
    .filter(([, cfg]) => cfg.platform.includes(platform))
    .map(([id]) => id);
}

export function getAvailablePlatforms(): string[] {
  const registry = loadRegistry();
  const platforms = new Set<string>();
  for (const cfg of Object.values(registry.libraries)) {
    for (const p of cfg.platform) platforms.add(p);
  }
  return [...platforms];
}
