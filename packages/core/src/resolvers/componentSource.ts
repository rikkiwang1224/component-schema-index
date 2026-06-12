import type { ComponentSource, LibraryId } from '../types.js';
import {
  getComponentConfig,
  getLibraryConfig,
  componentNameToDir,
  isRegisteredLibrary,
} from '../registry/loader.js';
import {
  resolveTypes,
  resolveExamples,
  rankExamplesByRelevance,
  listComponents,
} from '../resolvers/index.js';
import { getLogger } from '../config.js';

const logger = () => getLogger();

export function resolveComponentSource(
  library: LibraryId,
  componentName: string,
  includeExamples = false,
  includeProps = true,
  relevantFeatures: string[] = [],
): ComponentSource | null {
  if (!isRegisteredLibrary(library)) {
    logger().warn('Library not registered', { library });
    return null;
  }

  const compConfig = getComponentConfig(library, componentName);
  const contextLevel = compConfig.contextLevel;
  logger().info('Resolving component', { library, componentName, contextLevel, relevantFeatures });

  const result: ComponentSource = {
    name: componentName,
    library,
    subsumes: compConfig.subsumes,
  };

  if (includeProps) {
    const typesContent = resolveTypes(library, componentName);
    if (typesContent) result.typesContent = typesContent;
  }

  const shouldIncludeExamples = includeExamples || contextLevel !== 'types-only';

  if (shouldIncludeExamples) {
    let examples = resolveExamples(library, componentName);

    if (examples.length > 0 && relevantFeatures.length > 0) {
      examples = rankExamplesByRelevance(examples, relevantFeatures);
    }

    if (examples.length > 0) {
      result.examples =
        contextLevel === 'types-with-brief-example' && !includeExamples
          ? examples.slice(0, 2)
          : examples;
    }
  }

  if (!result.typesContent && (!result.examples || result.examples.length === 0)) {
    logger().warn('No data resolved', { library, componentName });
    return null;
  }

  return result;
}

export { listComponents };

export {
  loadRegistry,
  getLibraryConfig,
  getContextLevel,
  isRegisteredLibrary,
  componentNameToDir,
  getRegisteredLibraries,
  getLibrariesByPlatform,
  getAvailablePlatforms,
} from '../registry/loader.js';
