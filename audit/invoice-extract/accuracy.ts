import type { ExtractionT } from './schema.js';
import type { Truth } from './fixtures/groundTruth.js';

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const money = (a?: string | null, b?: string | null) => (a == null || b == null ? a == b : Math.abs(Number(a) - Number(b)) < 0.005);

export const FIELDS = ['kind', 'invoiceNumber', 'vendor', 'issueDate', 'dueDate', 'currency', 'lineItems', 'discount', 'subtotal', 'taxAmount', 'total', 'terms'] as const;
export type Field = (typeof FIELDS)[number];

/** Field-by-field comparison against ground truth. A not_invoice truth only scores `kind`. */
export function score(ex: ExtractionT | undefined, t: Truth): Partial<Record<Field, boolean>> {
  if (!ex) return t.kind === 'not_invoice' ? { kind: false } : Object.fromEntries(FIELDS.map((f) => [f, false]));
  const d = ex.document;
  if (t.kind === 'not_invoice') return { kind: d.kind === 'not_invoice' };
  if (d.kind !== 'invoice') return Object.fromEntries(FIELDS.map((f) => [f, false]));
  const due = Array.isArray(t.dueDate) ? t.dueDate : [t.dueDate ?? null];
  const v = norm(d.vendor.name), tv = norm(t.vendor!);
  return {
    kind: true,
    invoiceNumber: norm(d.invoiceNumber) === norm(t.invoiceNumber!),
    vendor: v === tv || v.includes(tv) || tv.includes(v),
    issueDate: d.issueDate === t.issueDate,
    dueDate: due.includes(d.dueDate),
    currency: d.currency === t.currency,
    lineItems: d.lineItems.length === t.lineItems,
    discount: money(d.discount && Number(d.discount) !== 0 ? String(Math.abs(Number(d.discount))) : null, t.discount ?? null),
    subtotal: money(d.subtotal, t.subtotal),
    taxAmount: money(d.taxAmount, t.taxAmount),
    total: money(d.total, t.total),
    terms: d.paymentTerms.type === t.terms,
  };
}
