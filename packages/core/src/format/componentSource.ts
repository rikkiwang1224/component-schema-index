import type { ComponentSource, LibraryId } from '../types.js';
import { getLibraryConfig, componentNameToDir } from '../registry/loader.js';

function buildImportSection(library: LibraryId, componentName: string): string {
  const libConfig = getLibraryConfig(library);
  const pkg = libConfig?.importPrefix ?? library;
  const dirName = componentNameToDir(componentName, library);

  let typesSubPath = '';
  if (libConfig?.typesPath) {
    const patterns = Array.isArray(libConfig.typesPath) ? libConfig.typesPath : [libConfig.typesPath];
    const firstPattern = patterns[0].replace(/\{component\}/g, dirName).replace(/\.d\.ts$/, '');
    typesSubPath = `${pkg}/${firstPattern}`;
  }

  const lines = [`// Component import`, `import { ${componentName} } from '${pkg}';`];

  if (typesSubPath) {
    lines.push(`// Type import (use sub-path, not package root)`);
    lines.push(`import type { ${componentName}Props } from '${typesSubPath}';`);
    lines.push(`// See type definitions below for other exported types`);
  }

  return lines.join('\n');
}

export function formatComponentSourceForAI(source: ComponentSource, maxLength = 50000): string {
  const parts: string[] = [];
  let len = 0;

  const append = (text: string): boolean => {
    if (len + text.length > maxLength) {
      const remaining = maxLength - len;
      if (remaining > 100) {
        parts.push(`${text.substring(0, remaining)}\n... (truncated)`);
        len = maxLength;
      }
      return false;
    }
    parts.push(text);
    len += text.length;
    return true;
  };

  append(`## Component: ${source.name} (${source.library})\n`);

  if (source.subsumes && source.subsumes.length > 0) {
    append(
      `### ⚠️ Subsumed components\nThis component internalizes the following via \`fields\` config — **no separate lookup needed**: ${source.subsumes.join(', ')}\n\nUse \`fields[].type\` (e.g. \`type: 'select'\`) and \`ctrlProps\` for component props.\n`,
    );
  }

  const importText = buildImportSection(source.library, source.name);
  append(`### Import\n\`\`\`typescript\n${importText}\n\`\`\`\n`);

  const hasExamples = source.examples && source.examples.length > 0;
  const headerLen = len;
  const availableBudget = maxLength - headerLen;
  const typesMaxLen = hasExamples
    ? Math.floor(availableBudget * 0.6)
    : Math.floor(availableBudget * 0.95);

  if (source.typesContent) {
    const types =
      source.typesContent.length > typesMaxLen
        ? `${source.typesContent.substring(0, typesMaxLen)}\n// ... (types truncated)`
        : source.typesContent;
    append(`### Type definitions\n\`\`\`typescript\n${types}\n\`\`\`\n`);
  }

  if (hasExamples) {
    append(`### Examples\n`);
    for (let i = 0; i < source.examples!.length; i++) {
      if (len >= maxLength) break;
      const ex = source.examples![i];
      if (i < 3) {
        const content =
          ex.content.length > 5000
            ? `${ex.content.substring(0, 5000)}\n// ... (example truncated)`
            : ex.content;
        if (!append(`#### ${ex.name}\n\`\`\`tsx\n${content}\n\`\`\`\n`)) break;
      } else {
        append(`- ${ex.name}\n`);
      }
    }
  }

  return parts.join('\n');
}
