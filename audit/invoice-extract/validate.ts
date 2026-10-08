import type { InvoiceT } from './schema.js';
import { FX_TO_USD } from './fixtures/groundTruth.js';

export type Flag = 'line_items_sum' | 'line_math' | 'tax_math' | 'total_math' | 'due_before_issue';

export interface Validation {
  kind: 'invoice' | 'not_invoice' | 'failed';
  /** Total converted to USD with fixed rates (0 when not an invoice). */
  amountUsd: number;
  flags: Flag[];
  /** Kept separate so flow conditions can use a number (`validation.flagCount === 0`). */
  flagCount: number;
  details: string[];
}

/** cents from a decimal string ("1234.5" -> 123450). */
export const cents = (s: string | null | undefined) => (s == null ? 0 : Math.round(Number(s) * 100));

/** Business rules an AP clerk checks before paying. Tolerances: 1 cent per rounding step. */
export function validateInvoice(inv: InvoiceT): Validation {
  const flags = new Set<Flag>();
  const details: string[] = [];

  for (const li of inv.lineItems) {
    const expect = Math.round(li.quantity * cents(li.unitPrice));
    if (Math.abs(expect - cents(li.amount)) > 1) {
      flags.add('line_math');
      details.push(`line "${li.description}": ${li.quantity} x ${li.unitPrice} != ${li.amount}`);
    }
  }
  const sum = inv.lineItems.reduce((a, li) => a + cents(li.amount), 0);
  const afterDiscount = sum - Math.abs(cents(inv.discount));
  if (Math.abs(afterDiscount - cents(inv.subtotal)) > 1) {
    flags.add('line_items_sum');
    details.push(`line items ${(sum / 100).toFixed(2)} - discount ${inv.discount ?? '0'} != subtotal ${inv.subtotal}`);
  }
  if (inv.taxRate != null) {
    const expectTax = Math.round((cents(inv.subtotal) * inv.taxRate) / 100);
    if (Math.abs(expectTax - cents(inv.taxAmount)) > 1) {
      flags.add('tax_math');
      details.push(`tax ${inv.taxRate}% of ${inv.subtotal} = ${(expectTax / 100).toFixed(2)}, invoice says ${inv.taxAmount}`);
    }
  }
  if (Math.abs(cents(inv.subtotal) + cents(inv.taxAmount) - cents(inv.total)) > 1) {
    flags.add('total_math');
    details.push(`subtotal ${inv.subtotal} + tax ${inv.taxAmount} != total ${inv.total}`);
  }
  if (inv.dueDate && inv.dueDate < inv.issueDate) {
    flags.add('due_before_issue');
    details.push(`due ${inv.dueDate} before issue ${inv.issueDate}`);
  }
  const amountUsd = Math.round(Number(inv.total) * (FX_TO_USD[inv.currency] ?? NaN) * 100) / 100;
  return { kind: 'invoice', amountUsd, flags: [...flags], flagCount: flags.size, details };
}
