/**
 * Shared path configuration for CSI CLI scripts.
 *
 * Override with CSI_DATA_ROOT env var pointing to your component-data directory.
 */
import { join } from 'path';

export const PROJECT_ROOT = process.cwd();
export const DATA_ROOT = process.env.CSI_DATA_ROOT ?? join(PROJECT_ROOT, 'data');

export const CSI_DIR = join(DATA_ROOT, 'csi');
export const REGISTRY_PATH = join(DATA_ROOT, 'registry.json');
export const METADATA_DIR = join(DATA_ROOT, 'metadata');
export const EXAMPLES_DIR = join(DATA_ROOT, 'examples');
export const FLATTENED_TYPES_DIR = join(DATA_ROOT, 'flattened-types');
