/** Studio must import the SDK through its package exports, never its files (PLAN §19.7). */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The published names the rule guards: `@linuxdevil/lousho` now, `@linuxdevil/lousho`/`@lousho/build-ai-agent` for older layouts. */
const SDK_DEEP_IMPORT = /^(?:@linuxdevil\/lousho|@lousho\/build-ai-agent|lousho)\/(?:src|dist)(?:\/|$)/;

function isOutsideAppRoot(filename, specifier) {
  if (!specifier.startsWith('.')) return false;
  const resolved = path.resolve(path.dirname(filename), specifier);
  return path.relative(APP_ROOT, resolved).startsWith('..');
}

export const noSdkSource = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid importing SDK source files; use package exports only.' },
    messages: { deep: "Import the SDK as '@linuxdevil/lousho' or a public subpath, not '{{source}}'." },
    schema: [],
  },
  create(context) {
    const filename = context.filename;
    const check = (node, specifier) => {
      if (typeof specifier !== 'string') return;
      if (SDK_DEEP_IMPORT.test(specifier) || isOutsideAppRoot(filename, specifier)) {
        context.report({ node, messageId: 'deep', data: { source: specifier } });
      }
    };
    const sourceOf = (node) => (typeof node?.source?.value === 'string' ? node.source.value : undefined);
    return {
      ImportDeclaration: (node) => check(node, sourceOf(node)),
      ExportNamedDeclaration: (node) => check(node, sourceOf(node)),
      ExportAllDeclaration: (node) => check(node, sourceOf(node)),
      ImportExpression(node) {
        if (node.source?.type === 'Literal' && typeof node.source.value === 'string') check(node.source, node.source.value);
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee?.type !== 'MemberExpression' || callee.object?.type !== 'Identifier' || callee.object.name !== 'vi') return;
        if (callee.property?.type !== 'Identifier' || !['mock', 'importActual', 'importMock'].includes(callee.property.name)) return;
        const first = node.arguments[0];
        if (first?.type === 'Literal' && typeof first.value === 'string') check(first, first.value);
      },
    };
  },
};
