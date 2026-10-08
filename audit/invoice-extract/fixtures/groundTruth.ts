/**
 * Hand-written ground truth for every fixture. Amounts as decimal strings.
 * `flags` are the business-rule problems a correct validator must raise on a
 * correct extraction; `route` is the expected routing decision.
 */
export interface Truth {
  kind: 'invoice' | 'not_invoice';
  invoiceNumber?: string;
  vendor?: string;
  issueDate?: string;
  /** null = not stated; an array = any of these is acceptable */
  dueDate?: string | null | Array<string | null>;
  currency?: 'EUR' | 'USD' | 'AED' | 'GBP';
  lineItems?: number;
  discount?: string | null;
  subtotal?: string;
  taxAmount?: string;
  total?: string;
  terms?: 'net' | 'due_on_receipt' | 'unknown';
  flags: Array<'line_items_sum' | 'tax_math' | 'total_math'>;
  route: 'auto' | 'approval' | 'rejected';
}

export const TRUTH: Record<string, Truth> = {
  'inv-01-acme-us': { kind: 'invoice', invoiceNumber: 'INV-2026-0315', vendor: 'ACME Office Supplies Inc.', issueDate: '2026-03-15', dueDate: '2026-04-14', currency: 'USD', lineItems: 3, discount: null, subtotal: '411.98', taxAmount: '33.99', total: '445.97', terms: 'net', flags: [], route: 'auto' },
  'inv-02-mueller-de': { kind: 'invoice', invoiceNumber: 'RE-2026-0042', vendor: 'Müller Industrietechnik GmbH', issueDate: '2026-03-15', dueDate: '2026-03-29', currency: 'EUR', lineItems: 3, discount: null, subtotal: '2307.00', taxAmount: '438.33', total: '2745.33', terms: 'net', flags: [], route: 'approval' },
  'inv-03-alnoor-aed': { kind: 'invoice', invoiceNumber: 'ANF/26/0789', vendor: 'Al Noor Facilities Management L.L.C.', issueDate: '2026-03-15', dueDate: '2026-04-14', currency: 'AED', lineItems: 3, discount: null, subtotal: '12000.00', taxAmount: '600.00', total: '12600.00', terms: 'net', flags: [], route: 'approval' },
  'inv-04-streamline-saas': { kind: 'invoice', invoiceNumber: 'SA-88213', vendor: 'Streamline Analytics, Inc.', issueDate: '2026-03-02', dueDate: [null, '2026-03-02'], currency: 'USD', lineItems: 2, discount: null, subtotal: '499.00', taxAmount: '0.00', total: '499.00', terms: 'due_on_receipt', flags: [], route: 'auto' },
  'inv-05-lumiere-fr': { kind: 'invoice', invoiceNumber: 'F-2026-118', vendor: 'Imprimerie Lumière SARL', issueDate: '2026-02-28', dueDate: '2026-03-30', currency: 'EUR', lineItems: 3, discount: '100.00', subtotal: '900.00', taxAmount: '180.00', total: '1080.00', terms: 'net', flags: [], route: 'approval' },
  'inv-06-pacific-ocr': { kind: 'invoice', invoiceNumber: 'PCP-7781', vendor: 'Pacific Coast Plumbing', issueDate: '2026-03-09', dueDate: '2026-03-24', currency: 'USD', lineItems: 3, discount: null, subtotal: '443.50', taxAmount: '33.26', total: '476.76', terms: 'net', flags: [], route: 'auto' },
  'inv-07-nordhavn-ocr': { kind: 'invoice', invoiceNumber: 'NS-2026-0310', vendor: 'Nordhavn Shipping ApS', issueDate: '2026-03-10', dueDate: '2026-04-09', currency: 'EUR', lineItems: 3, discount: null, subtotal: '2247.50', taxAmount: '561.88', total: '2809.38', terms: 'net', flags: [], route: 'approval' },
  'inv-08-brightline-mismatch': { kind: 'invoice', invoiceNumber: 'BL-1049', vendor: 'Brightline Electrical Contractors', issueDate: '2026-03-20', dueDate: '2026-04-19', currency: 'USD', lineItems: 3, discount: null, subtotal: '3760.00', taxAmount: '225.60', total: '3985.60', terms: 'net', flags: ['line_items_sum'], route: 'approval' },
  'inv-09-desertrose-taxwrong': { kind: 'invoice', invoiceNumber: 'DRC-2026-221', vendor: 'Desert Rose Catering LLC', issueDate: '2026-03-22', dueDate: '2026-04-06', currency: 'AED', lineItems: 2, discount: null, subtotal: '4000.00', taxAmount: '250.00', total: '4250.00', terms: 'net', flags: ['tax_math'], route: 'approval' },
  'inv-10-horizon-quote': { kind: 'not_invoice', flags: [], route: 'rejected' },
  'inv-11-thamesvalley-gbp': { kind: 'invoice', invoiceNumber: 'TVL/2026/0057', vendor: 'Thames Valley Legal LLP', issueDate: '2026-04-01', dueDate: '2026-05-01', currency: 'GBP', lineItems: 2, discount: null, subtotal: '820.00', taxAmount: '164.00', total: '984.00', terms: 'net', flags: [], route: 'approval' },
  'inv-12-alwaha-arabic': { kind: 'invoice', invoiceNumber: 'WT-2026-0091', vendor: 'Al Waha Trading Est.', issueDate: '2026-03-18', dueDate: '2026-04-17', currency: 'AED', lineItems: 3, discount: null, subtotal: '600.00', taxAmount: '30.00', total: '630.00', terms: 'net', flags: [], route: 'auto' },
  'inv-13-keystone-large': { kind: 'invoice', invoiceNumber: 'KSP-2026-014', vendor: 'Keystone Strategy Partners LLC', issueDate: '2026-03-31', dueDate: '2026-05-15', currency: 'USD', lineItems: 2, discount: null, subtotal: '18500.00', taxAmount: '0.00', total: '18500.00', terms: 'net', flags: [], route: 'approval' },
  'inv-14-vanderberg-nl': { kind: 'invoice', invoiceNumber: '2026-3307', vendor: 'Van der Berg Horeca B.V.', issueDate: '2026-03-05', dueDate: '2026-03-19', currency: 'EUR', lineItems: 8, discount: null, subtotal: '604.00', taxAmount: '54.36', total: '658.36', terms: 'net', flags: [], route: 'auto' },
  'inv-15-greenleaf-boundary': { kind: 'invoice', invoiceNumber: 'GL-3390', vendor: 'Greenleaf Landscaping Co.', issueDate: '2026-03-12', dueDate: '2026-03-26', currency: 'USD', lineItems: 2, discount: null, subtotal: '1000.00', taxAmount: '0.00', total: '1000.00', terms: 'net', flags: [], route: 'approval' },
  'inv-16-summit-pdf': { kind: 'invoice', invoiceNumber: 'SIT-5520', vendor: 'Summit IT Services', issueDate: '2026-03-25', dueDate: '2026-04-24', currency: 'USD', lineItems: 2, discount: null, subtotal: '314.00', taxAmount: '25.12', total: '339.12', terms: 'net', flags: [], route: 'auto' },
};

/** Fixed FX rates to USD for routing (a real system would use a rates service). */
export const FX_TO_USD: Record<string, number> = { USD: 1, EUR: 1.08, AED: 0.2723, GBP: 1.27 };
