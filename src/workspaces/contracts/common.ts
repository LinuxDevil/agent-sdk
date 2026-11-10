import { z } from 'zod';
import { isSafeRelativePath } from '../../spec/v2/common';

export const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const workspacePathSchema = z
  .string()
  .refine(isSafeRelativePath, "must be a relative path with forward slashes that stays inside the workspace's folder");
