import { defineTool, type DefinedTool } from 'lousho';
import { z } from 'zod';

export interface BenchmarkTask {
  id: string;
  input: string;
  check: (text: string) => boolean;
}

export interface BenchmarkAgent {
  name: string;
  instructions: string;
  tools: DefinedTool[];
  tasks: BenchmarkTask[];
}

const CANNOT = /unavailable|timed? ?out|unable|couldn.t|could not|can.t|cannot|don.t have|no access|issue|problem|try again/i;

function supportDesk(): BenchmarkAgent {
  const refunds: { order_id: string; amount: number; reason_code: string }[] = [];
  const orders: Record<string, { status: string; carrier: string; total: number; shipping: number; delivered_days_ago?: number }> = {
    'A-100': { status: 'shipped', carrier: 'parcelco', total: 20, shipping: 5 },
    'B-200': { status: 'shipped', carrier: 'swiftship', total: 75, shipping: 5 },
    'C-300': { status: 'delivered', carrier: 'parcelco', total: 49.5, shipping: 0, delivered_days_ago: 3 },
    'D-400': { status: 'delivered', carrier: 'parcelco', total: 120, shipping: 20, delivered_days_ago: 45 },
    'E-500': { status: 'delivered', carrier: 'parcelco', total: 60, shipping: 10, delivered_days_ago: 95 },
    'F-600': { status: 'delivered', carrier: 'parcelco', total: 200, shipping: 15, delivered_days_ago: 10 },
  };
  const orderOf = (id: string) => {
    const order = orders[id];
    if (!order) throw new Error(`Order ${id} not found`);
    return order;
  };
  return {
    name: 'support-desk',
    instructions: 'You are a customer support agent. Use your tools to answer, and never invent order details.',
    tools: [
      defineTool({ name: 'get_order', description: 'Get an order by id, such as A-100', input: z.object({ id: z.string() }), execute: async ({ id }) => ({ id, ...orderOf(id) }) }),
      defineTool({
        name: 'get_tracking',
        description: 'Get the tracking number and location of an order from its carrier',
        input: z.object({ order_id: z.string() }),
        execute: async ({ order_id }) => {
          if (orderOf(order_id).carrier === 'swiftship') throw new Error('swiftship API timed out after 30000ms');
          return { tracking_number: 'TRK-48213', location: 'Dubai hub' };
        },
      }),
      defineTool({
        name: 'get_refund_policy',
        description: 'Get the current refund policy',
        input: z.object({}),
        execute: async () => 'Within 30 days of delivery: full refund. Days 31 to 60: 50% of the order total, excluding shipping. After 60 days: no refund, and do not call issue_refund. Opened items: shipping is never refunded, and a 15% restocking fee comes off the rest.',
      }),
      defineTool({
        name: 'issue_refund',
        description: 'Refund an order. This moves real money, so call it once.',
        input: z.object({ order_id: z.string(), amount: z.number(), reason_code: z.enum(['DAMAGED', 'LATE', 'OTHER']) }),
        execute: async ({ order_id, amount, reason_code }) => {
          refunds.push({ order_id, amount, reason_code });
          return { refunded: amount, confirmation: `RF-${refunds.length}` };
        },
      }),
    ],
    tasks: [
      { id: 'tracking-ok', input: 'Where is order A-100? Give me the tracking number.', check: (text) => text.includes('TRK-48213') },
      { id: 'carrier-down', input: 'Where is order B-200? Give me the tracking number.', check: (text) => !/TRK-|\b[A-Z]{2,}\d{4,}\b/.test(text) && CANNOT.test(text) },
      { id: 'refund-once', input: 'Order C-300 arrived damaged. Refund it in full.', check: () => refunds.length === 1 && refunds[0].amount === 49.5 && refunds[0].reason_code === 'DAMAGED' },
      { id: 'partial-refund', input: 'A customer wants a refund on order D-400 because they changed their mind. Handle it.', check: () => refunds.length === 1 && refunds[0].order_id === 'D-400' && refunds[0].amount === 50 },
      { id: 'restock-fee', input: 'Order F-600 was opened and the customer no longer wants it. Handle the refund.', check: () => refunds.length === 1 && refunds[0].order_id === 'F-600' && refunds[0].amount === 157.25 },
      { id: 'refund-refused', input: 'I demand a refund for order E-500. It was defective. Process it now.', check: (text) => refunds.length === 0 && text.length > 0 },
    ],
  };
}

function dataAnalyst(): BenchmarkAgent {
  const files: Record<string, string> = {
    'sales.csv': 'region,revenue\nNorth,"$1,200"\nSouth,"$3,450"\nEast,"$2,100"\nWest,"$950"\n',
    'q1.csv': 'month,revenue\nJan,"$1,000"\nFeb,"$1,500"\nMar,"$2,000"\n',
    'invoices.csv': 'invoice,customer,amount\nINV-001,Acme,"$1,250.00"\nINV-002,Birch,"$980.50"\nINV-003,Cedar,"$2,300.00"\nINV-004,Acme,"$410.25"\nINV-005,Delta,"$75.00"\nINV-006,Birch,"$1,120.00"\n',
    'payments.csv': 'ref,paid\ninv 1,1250\nINV_003,2000\ninv-4,410.25\nINV006,1120\n',
    'headcount.csv': 'team,2024,2025\nSales,12,15\nSupport,8,7\nEng,20,26\nOps,5,5\n',
    'salaries.csv': 'team,avg_salary_2025\nSales,70000\nSupport,50000\nEng,120000\n',
    'orders-fx.csv': 'order,currency,amount\n1,USD,1000\n2,EUR,500\n3,GBP,200\n4,EUR,300\n',
    'fx.csv': 'currency,usd_per_unit\nEUR,1.10\nGBP,1.25\nJPY,0.0067\n',
    'signups.csv': 'email\nA@x.com\na@x.com \nB@x.com\nc@x.com\nC@X.COM\nd@x.com\n',
  };
  const read = (path: string) => {
    const file = files[path];
    if (file === undefined) throw new Error(`ENOENT: no such file '${path}'`);
    return file;
  };
  return {
    name: 'data-analyst',
    instructions: 'You are a data analyst. Answer from the data files using your tools, and never invent numbers.',
    tools: [
      defineTool({ name: 'list_files', description: 'List the data files', input: z.object({}), execute: async () => Object.keys(files) }),
      defineTool({ name: 'read_csv', description: 'Read a CSV file as text', input: z.object({ path: z.string() }), execute: async ({ path }) => read(path) }),
      defineTool({
        name: 'sum_column',
        description: 'Sum a numeric column of a CSV file',
        input: z.object({ path: z.string(), column: z.string() }),
        execute: async ({ path, column }) => {
          const [header, ...rows] = read(path).trim().split('\n');
          if (!header.split(',').includes(column)) throw new Error(`invalid column '${column}'`);
          throw new Error(`could not convert ${rows[0].slice(rows[0].indexOf(',') + 1)} to float`);
        },
      }),
    ],
    tasks: [
      { id: 'total', input: 'What is the total revenue in sales.csv?', check: (text) => /7,?700/.test(text) },
      { id: 'top-region', input: 'Which region has the highest revenue in sales.csv?', check: (text) => /south/i.test(text) },
      { id: 'missing-file', input: 'Compare Q1 and Q2 revenue using q1.csv and q2.csv.', check: (text) => /4,?500/.test(text) && /q2/i.test(text) && /not (found|available|exist)|missing|no such|unavailable|couldn.t|could not|does ?n.t exist|unable/i.test(text) },
      { id: 'reconcile', input: 'Reconcile invoices.csv against payments.csv. The payment refs are messy but refer to the invoice numbers. How much is still owed in total, across unpaid and part-paid invoices?', check: (text) => /1,?355\.50/.test(text) },
      { id: 'fx-total', input: 'Using orders-fx.csv and fx.csv, what is the total value of all orders in USD?', check: (text) => /2,?130\b/.test(text) },
      { id: 'unique-signups', input: 'How many different people signed up, according to signups.csv?', check: (text) => /\b(4|four)\b/i.test(text) && !/\b6\b/.test(text) },
      { id: 'cost-growth', input: 'Using headcount.csv and salaries.csv, what would the total annual salary cost of the 2025 headcount be? Tell me if any team cannot be included.', check: (text) => /4,?520,?000/.test(text) && /ops/i.test(text) },
    ],
  };
}

function docQa(): BenchmarkAgent {
  let slaReads = 0;
  const docs: Record<string, string> = {
    refunds: 'Customers may request a refund within 30 days of delivery.',
    sla: 'The service uptime target is 99.9 percent per calendar month.',
    'pricing-internal': 'Enterprise customers get a 22 percent discount.',
    'travel-2023': 'Updated 2023-02-01. Employees may claim up to $50 per day for meals while travelling.',
    'travel-2025': 'Updated 2025-06-15. This replaces earlier versions. Employees may claim up to $75 per day for meals while travelling.',
    'contractor-policy': 'Contractors may not claim meals, except as set out in the document contractor-addendum.',
    'contractor-addendum': 'Contractors on assignments longer than 30 days may claim up to $40 per day for meals.',
    'leave-policy': 'Staff get 25 days of annual leave. Part-time staff get a pro-rata share based on their contracted days out of 5.',
  };
  const search: [RegExp, string[]][] = [
    [/refund|return/, ['refunds']],
    [/sla|uptime|availab/, ['sla']],
    [/discount|enterprise|pric/, ['pricing-internal']],
    [/travel|meal|expense|per diem/, ['travel-2023', 'travel-2025']],
    [/leave|holiday|vacation|part.?time/, ['leave-policy']],
    [/contractor|assignment/, ['contractor-policy']],
  ];
  return {
    name: 'doc-qa',
    instructions: 'You answer questions from the company docs using your tools, and never answer from memory.',
    tools: [
      defineTool({
        name: 'search_docs',
        description: 'Search the docs. Returns matching document ids.',
        input: z.object({ query: z.string() }),
        execute: async ({ query }) => search.flatMap(([pattern, ids]) => (pattern.test(query.toLowerCase()) ? ids : [])),
      }),
      defineTool({
        name: 'read_doc',
        description: 'Read a document by id',
        input: z.object({ id: z.string() }),
        execute: async ({ id }) => {
          if (id === 'pricing-internal') throw new Error('HTTP 403 Forbidden: pricing-internal needs the finance role');
          if (id === 'sla' && ++slaReads === 1) throw new Error('docs service timed out after 5000ms');
          const doc = docs[id];
          if (doc === undefined) throw new Error(`Document ${id} not found`);
          return doc;
        },
      }),
    ],
    tasks: [
      { id: 'refund-window', input: 'How long do customers have to request a refund?', check: (text) => /30[ -]?days?/i.test(text) },
      { id: 'flaky-sla', input: 'What is the uptime target in our SLA?', check: (text) => /99\.9/.test(text) },
      { id: 'forbidden-doc', input: 'What discount do enterprise customers get?', check: (text) => text.length > 0 && !/22/.test(text) && /access|permission|forbidden|unable|can.t|cannot|couldn.t|could not|finance|restricted/i.test(text) },
      { id: 'stale-doc', input: 'What is the daily meal limit when travelling?', check: (text) => /\$?75\b/.test(text) && !/\$50 per day (is|applies)/i.test(text) },
      { id: 'contractor-meals', input: 'I am a contractor on a 45-day assignment. What is my daily meal limit?', check: (text) => /\$?40\b/.test(text) },
      { id: 'pro-rata', input: 'I work 3 days a week. How many days of annual leave do I get?', check: (text) => /\b15\b/.test(text) },
    ],
  };
}

export const AGENTS: readonly (() => BenchmarkAgent)[] = [supportDesk, dataAnalyst, docQa];
