import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { ComponentMetadata, ComponentMetadataFile, ComponentSummary, LibraryId } from '../types.js';
import { getMetadataDir, getLogger, onCsiCacheReset } from '../config.js';

export class MetadataLoader {
  private cache = new Map<LibraryId, ComponentMetadata[]>();
  private metadataDir: string;

  constructor(metadataDir?: string) {
    this.metadataDir = metadataDir ?? getMetadataDir();
    onCsiCacheReset(() => this.cache.clear());
  }

  async load(library: LibraryId): Promise<ComponentMetadata[]> {
    if (this.cache.has(library)) {
      return this.cache.get(library)!;
    }
    const metadata = await this.loadFromFile(library);
    this.cache.set(library, metadata);
    return metadata;
  }

  async preload(libraries: LibraryId[]): Promise<void> {
    await Promise.all(
      libraries.map((library) =>
        this.load(library).catch((error) => {
          getLogger().warn('Failed to preload library metadata', { library, error: String(error) });
          return [] as ComponentMetadata[];
        }),
      ),
    );
  }

  private async loadFromFile(library: LibraryId): Promise<ComponentMetadata[]> {
    const filePath = join(this.metadataDir, `${library}.json`);

    if (!existsSync(filePath)) {
      getLogger().warn('Metadata file not found', { library, filePath });
      return [];
    }

    const content = readFileSync(filePath, 'utf-8');
    const data: ComponentMetadataFile = JSON.parse(content);

    if (!data.components || !Array.isArray(data.components)) {
      throw new Error(`Invalid metadata format for ${library}: components is not an array`);
    }

    return data.components;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export async function getComponentSummariesForLibrary(
  loader: MetadataLoader,
  library: LibraryId,
): Promise<ComponentSummary[]> {
  return loader.load(library);
}

export type { ComponentMetadata, ComponentMetadataFile };
