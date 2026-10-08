import { z } from 'zod';

/** Decimal money amount as a string ("1234.50"): keeps exact cents, no float drift. */
export const Money = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, 'money must look like 1234.50')
  .describe('decimal string, e.g. "1234.50"');

/** ISO date. Not z.iso.date(): its JSON-Schema pattern is ~280 chars and lands twice in the prompt (see FINDINGS). */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const Currency = z.enum(['EUR', 'USD', 'AED', 'GBP']);

export const LineItem = z.object({
  description: z.string().min(1),
  quantity: z.number().positive(),
  unitPrice: Money,
  amount: Money.describe('line total before tax'),
  sku: z.string().nullable(),
});

export const PaymentTerms = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('net'), days: z.number().int().positive() }),
    z.object({ type: z.literal('due_on_receipt') }),
    z.object({ type: z.literal('unknown') }),
  ]);

export const InvoiceDoc = z.object({
  kind: z.literal('invoice'),
  invoiceNumber: z.string().min(1),
  vendor: z.object({
    name: z.string().min(1),
    taxId: z.string().nullable().describe('VAT/TRN/EIN'),
    country: z.string().length(2).nullable().describe('ISO alpha-2'),
  }),
  issueDate: IsoDate,
  dueDate: IsoDate.nullable(),
  currency: Currency,
  lineItems: z.array(LineItem).min(1),
  discount: Money.nullable().describe('discount before tax'),
  subtotal: Money.describe('net, after discount, before tax'),
  taxRate: z.number().min(0).max(100).nullable().describe('percent'),
  taxAmount: Money,
  total: Money.describe('grand total incl. tax'),
  paymentTerms: PaymentTerms,
  notes: z.string().optional(),
});

export const NotInvoiceDoc = z.object({
  kind: z.literal('not_invoice'),
  documentType: z.enum(['receipt', 'quote', 'purchase_order', 'letter', 'statement', 'other']),
  reason: z.string(),
});

/** What the extractor returns for one document. Wrapped in an object: some strict endpoints require an object root. */
export const Extraction = z.object({
  document: z.discriminatedUnion('kind', [InvoiceDoc, NotInvoiceDoc]),
});

export type ExtractionT = z.output<typeof Extraction>;
export type InvoiceT = z.output<typeof InvoiceDoc>;
