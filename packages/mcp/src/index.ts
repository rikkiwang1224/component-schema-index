export type { McpServerOptions as CsiMcpOptions } from './types.js';
export { createCatalogMcpServer } from './catalogServer.js';
export { createSpecMcpServer } from './specServer.js';
export { libraryIdSchema, platformIdSchema } from './schemas.js';

import { createCatalogMcpServer } from './catalogServer.js';
import { createSpecMcpServer } from './specServer.js';
import type { McpServerOptions } from './types.js';

export function createCsiMcpServers(options: McpServerOptions = {}) {
  return {
    catalog: createCatalogMcpServer(options),
    spec: createSpecMcpServer(),
  };
}
