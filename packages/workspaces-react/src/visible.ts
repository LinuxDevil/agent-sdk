import { evaluateSafeExpression } from '@linuxdevil/lousho/workspaces/client';

export interface VisibleScope {
  inputs: unknown;
  outputs: unknown;
  status: string;
}

export function isVisible(expression: string | undefined, scope: VisibleScope): boolean {
  if (expression === undefined) return true;
  try {
    return Boolean(evaluateSafeExpression(expression, { inputs: scope.inputs, outputs: scope.outputs, status: scope.status }));
  } catch {
    return false;
  }
}
