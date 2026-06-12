export type {
  ContextLevel,
  LibraryId,
  PlatformId,
  ClassifiedFile,
  ComponentSource,
  ComponentConfig,
  LibraryConfig,
  Registry,
  ComponentSummary,
  ComponentMetadata,
  ComponentMetadataFile,
  ResolveOptions,
  CsiConfig,
  CsiLogger,
} from './types.js';

export {
  configureCsi,
  getCsiConfig,
  getLogger,
  getDataRoot,
  getNodeModulesRoot,
  getRegistryPath,
  getMetadataDir,
  getExamplesDir,
  getFlattenedTypesDir,
  onCsiCacheReset,
  defaultLogger,
} from './config.js';

export {
  loadRegistry,
  getLibraryConfig,
  getComponentConfig,
  getContextLevel,
  getRegisteredLibraries,
  isRegisteredLibrary,
  componentNameToDir,
  getLibrariesByPlatform,
  getAvailablePlatforms,
} from './registry/loader.js';

export {
  resolveTypes,
  resolveExamples,
  hasExamples,
  rankExamplesByRelevance,
  listComponents,
} from './resolvers/index.js';

export { resolveComponentSource } from './resolvers/componentSource.js';
export { formatComponentSourceForAI } from './format/componentSource.js';
export { MetadataLoader, getComponentSummariesForLibrary } from './catalog/metadataLoader.js';
