import { z } from 'zod';
import {
  getRegisteredLibraries,
  getAvailablePlatforms,
} from '@csi/core';

export function libraryIdSchema() {
  const ids = getRegisteredLibraries();
  if (ids.length === 0) {
    return z.string().describe('Component library id from registry.json');
  }
  return z.enum(ids as [string, ...string[]]).describe('Component library id');
}

export function platformIdSchema() {
  const platforms = getAvailablePlatforms();
  if (platforms.length === 0) {
    return z.string().describe('Platform id from registry.json library.platform');
  }
  return z.enum(platforms as [string, ...string[]]).describe('Platform id');
}
