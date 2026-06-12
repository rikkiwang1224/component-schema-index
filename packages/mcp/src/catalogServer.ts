import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  MetadataLoader,
  getLibrariesByPlatform,
  getRegisteredLibraries,
} from '@csi/core';
import type { McpServerOptions } from './types.js';
import { libraryIdSchema, platformIdSchema } from './schemas.js';

export function createCatalogMcpServer(options: McpServerOptions = {}) {
  const metadataLoader = new MetadataLoader();

  const listComponentsTool = tool(
    'list-available-components',
    'List available components for a platform or library. Returns name, description, and key props. Provide platform OR library.',
    {
      platform: platformIdSchema().optional(),
      library: libraryIdSchema().optional(),
      includeProps: z.boolean().default(true).describe('Include keyProps in response'),
    },
    async (args) => {
      try {
        const { platform, library, includeProps = true } = args;

        if (!platform && !library) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: 'Provide platform or library' }, null, 2),
            }],
          };
        }

        let components: Array<{
          name: string;
          description: string;
          library: string;
          keyProps?: string[];
        }> = [];

        if (platform) {
          const libraries = getLibrariesByPlatform(platform);
          for (const lib of libraries) {
            const libComponents = await metadataLoader.load(lib);
            components.push(
              ...libComponents.map((comp) => ({
                name: comp.name,
                description: comp.description,
                library: lib,
                ...(includeProps && comp.keyProps ? { keyProps: comp.keyProps } : {}),
              })),
            );
          }
        } else if (library) {
          const libComponents = await metadataLoader.load(library);
          components = libComponents.map((comp) => ({
            name: comp.name,
            description: comp.description,
            library,
            ...(includeProps && comp.keyProps ? { keyProps: comp.keyProps } : {}),
          }));
        }

        const result = {
          total: components.length,
          components,
          libraries: platform
            ? getLibrariesByPlatform(platform)
            : library
              ? [library]
              : getRegisteredLibraries(),
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: `list-available-components failed: ${error instanceof Error ? error.message : String(error)}`,
            }, null, 2),
          }],
        };
      }
    },
  );

  if (!options.enableIcons || !options.iconProvider) {
    return createSdkMcpServer({
      name: 'component-catalog',
      version: '2.0.0',
      tools: [listComponentsTool],
    });
  }

  const listIconsTool = tool(
    'list-icons',
    'Get icon naming rules and summary for a platform',
    { platform: platformIdSchema() },
    async (args) => {
      try {
        const { platform } = args;
        const summary = options.iconProvider!(platform);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ platform, summary }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: `list-icons failed: ${error instanceof Error ? error.message : String(error)}`,
            }, null, 2),
          }],
        };
      }
    },
  );

  return createSdkMcpServer({
    name: 'component-catalog',
    version: '2.0.0',
    tools: [listComponentsTool, listIconsTool],
  });
}
