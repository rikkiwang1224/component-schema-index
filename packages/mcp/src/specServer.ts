import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  resolveComponentSource,
  listComponents,
  formatComponentSourceForAI,
} from '@csi/core';
import { libraryIdSchema } from './schemas.js';

export function createSpecMcpServer() {
  return createSdkMcpServer({
    name: 'component-spec',
    version: '2.0.0',
    tools: [
      tool(
        'get-component-source',
        'Get type definitions and usage examples for a component in a registered library',
        {
          componentName: z.string().describe('Component name, e.g. ProTable, Button, Form'),
          library: libraryIdSchema(),
          includeExamples: z
            .boolean()
            .default(false)
            .describe('Include examples (high-order components may include automatically via contextLevel)'),
          includeProps: z.boolean().default(true).describe('Include .d.ts type definitions'),
          maxLength: z.number().default(50000).describe('Max response length in characters'),
          relevantFeatures: z
            .array(z.string())
            .optional()
            .describe('Semantic feature keywords to rank examples, e.g. ["row-selection", "virtual-scroll"]'),
        },
        async (args) => {
          try {
            const {
              componentName,
              library,
              includeExamples = false,
              includeProps = true,
              maxLength = 50000,
              relevantFeatures = [],
            } = args;

            if (!componentName) {
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({ error: 'componentName is required' }, null, 2),
                }],
              };
            }

            const result = resolveComponentSource(
              library,
              componentName,
              includeExamples,
              includeProps,
              relevantFeatures,
            );

            if (!result) {
              const availableComponents = listComponents(library);
              const hint =
                availableComponents.length > 0
                  ? `Available: ${availableComponents.slice(0, 20).join(', ')}${availableComponents.length > 20 ? '...' : ''}`
                  : 'Component list empty — ensure npm package is installed';
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    error: `Component "${componentName}" not found in library "${library}". ${hint}`,
                  }, null, 2),
                }],
              };
            }

            return {
              content: [{
                type: 'text',
                text: formatComponentSourceForAI(result, maxLength),
              }],
            };
          } catch (error) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  error: `get-component-source failed: ${error instanceof Error ? error.message : String(error)}`,
                }, null, 2),
              }],
            };
          }
        },
      ),
    ],
  });
}
