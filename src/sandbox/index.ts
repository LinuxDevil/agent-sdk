/**
 * The code-sandbox seam: `sandbox()` builds a box around a driver that runs
 * a function's source isolated, and `defineTool({ sandbox })` routes a
 * tool's `execute` through one. See docs/specs/0001-observability-platform/
 * 0001-sandboxing.md.
 */
export { sandbox } from './sandbox';
export { SandboxError, sandboxErrorKind } from './errors';
export {
  sandboxDriverName,
  type Sandbox,
  type SandboxCallOptions,
  type SandboxDriver,
  type SandboxDriverName,
  type SandboxDriverRef,
  type SandboxErrorKind,
  type SandboxOptions,
  type ToolSandboxOptions,
} from './types';
