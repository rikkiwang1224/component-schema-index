export type ContextLevel = 'types-only' | 'types-with-brief-example' | 'full-example';

/** Library identifier — any string key from registry.json */
export type LibraryId = string;

/** Platform tag used for grouping libraries (e.g. pc, h5, mobile) */
export type PlatformId = string;

export interface ClassifiedFile {
  path: string;
  name: string;
  content: string;
}

export interface ComponentSource {
  name: string;
  library: LibraryId;
  typesContent?: string;
  examples?: ClassifiedFile[];
  /** Base components internalized via fields config — no separate lookup needed */
  subsumes?: string[];
}

export interface ComponentConfig {
  contextLevel?: ContextLevel;
  dirName?: string;
  typesPath?: string;
  aliases?: string[];
  flattenTypes?: boolean;
  subsumes?: string[];
}

export interface LibraryConfig {
  displayName: string;
  platform: PlatformId[];
  importPrefix: string;
  npmPackage: string;
  typesPath: string | string[];
  examplesDir?: string;
  defaultContextLevel: ContextLevel;
  skill?: string;
  components?: Record<string, ComponentConfig>;
}

export interface Registry {
  version: string;
  libraries: Record<LibraryId, LibraryConfig>;
}

export interface ComponentSummary {
  name: string;
  description: string;
  keyProps?: string[];
  detailedProps?: Array<{ name: string; type: string; description?: string; required?: boolean }>;
}

export interface ComponentMetadataFile {
  library: LibraryId;
  version: string;
  generatedAt: string;
  generator: string;
  components: ComponentMetadata[];
}

export interface ComponentMetadata extends ComponentSummary {
  category?: string;
  importPath?: string;
  exportName?: string;
  subComponents?: string[];
  tags?: string[];
  examples?: string[];
  deprecated?: boolean;
  deprecationMessage?: string;
}

export interface ResolveOptions {
  includeExamples?: boolean;
  includeProps?: boolean;
  relevantFeatures?: string[];
}

export interface CsiLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: unknown, meta?: Record<string, unknown>): void;
}

export interface CsiConfig {
  /** Root of component-data: registry.json, metadata/, examples/, flattened-types/ */
  dataRoot: string;
  /** node_modules directory for reading npm package .d.ts (default: cwd/node_modules) */
  nodeModulesRoot?: string;
  logger?: CsiLogger;
}
