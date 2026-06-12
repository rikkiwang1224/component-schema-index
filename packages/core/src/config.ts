import type { CsiConfig, CsiLogger } from './types.js';

const defaultLogger: CsiLogger = {
  debug: (message, meta) => console.debug(`[csi] ${message}`, meta ?? ''),
  info: (message, meta) => console.info(`[csi] ${message}`, meta ?? ''),
  warn: (message, meta) => console.warn(`[csi] ${message}`, meta ?? ''),
  error: (message, error, meta) => console.error(`[csi] ${message}`, error, meta ?? ''),
};

let config: CsiConfig | null = null;

export function configureCsi(next: CsiConfig): void {
  config = {
    ...next,
    logger: next.logger ?? defaultLogger,
  };
  resetCsiCaches();
}

export function getCsiConfig(): CsiConfig {
  if (!config) {
    throw new Error(
      'CSI is not configured. Call configureCsi({ dataRoot }) before using resolvers or MCP servers.',
    );
  }
  return config;
}

export function getLogger(): CsiLogger {
  return getCsiConfig().logger ?? defaultLogger;
}

export function getDataRoot(): string {
  return getCsiConfig().dataRoot;
}

export function getNodeModulesRoot(): string {
  const { nodeModulesRoot } = getCsiConfig();
  if (nodeModulesRoot) return nodeModulesRoot;
  return `${process.cwd()}/node_modules`;
}

export function getRegistryPath(): string {
  return `${getDataRoot()}/registry.json`;
}

export function getMetadataDir(): string {
  return `${getDataRoot()}/metadata`;
}

export function getExamplesDir(): string {
  return `${getDataRoot()}/examples`;
}

export function getFlattenedTypesDir(): string {
  return `${getDataRoot()}/flattened-types`;
}

/** Invalidate cached registry and metadata after config changes */
const cacheResetCallbacks: Array<() => void> = [];

export function onCsiCacheReset(callback: () => void): void {
  cacheResetCallbacks.push(callback);
}

function resetCsiCaches(): void {
  for (const cb of cacheResetCallbacks) cb();
}

export { defaultLogger };
