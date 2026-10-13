/**
 * seed.ts — deterministic B2B SaaS warehouse for the data-analyst harness.
 *
 * Four JOINable tables in an in-memory SQLite database (`node:sqlite`):
 *
 *   accounts 1--n subscriptions 1--n invoices
 *   accounts 1--n usage_daily
 *
 * The data is small and hand-verifiable, and the interesting shape is
 * deliberate:
 *
 *   - 9 subscription rows carry status='churned', but 6 of those accounts
 *     later resubscribed — a naive `WHERE status='churned'` over-counts
 *     churn ($2,071 across 9 subs).
 *   - The corrected churn definition (ended AND no newer active
 *     subscription for the account) leaves exactly Delta Foods ($49),
 *     Fernwell Clinics ($49) and Juno Health ($299) = $397 MRR at churn.
 *   - Active MRR right now totals $4,673 across 9 subscriptions, dominated
 *     by the enterprise plan ($3,599).
 *
 * Everything is hard-coded or derived by closed formulas — no randomness.
 */
import { DatabaseSync } from 'node:sqlite';

/** One-line table descriptions served by list_tables / describe_table. */
export const TABLE_DESCRIPTIONS: Record<string, string> = {
  accounts: 'B2B customer accounts: id, name, plan tier, industry, region, created_at',
  subscriptions:
    "One row per subscription period: account_id, plan, mrr (USD/mo), status ('active'|'churned'), started_at, ended_at",
  invoices: 'Invoices billed against a subscription: subscription_id, amount, issued_at, paid (0|1)',
  usage_daily: 'Per-account daily product usage: account_id, day, active_users, events',
};

/**
 * Business-metric definitions served by get_metric. `churn_rate` is
 * deliberately the NAIVE definition (status='churned' only) — Q4's saved
 * correction refines it, which is what makes the correction observable in
 * the re-asked answer.
 */
export const METRICS: Record<string, { title: string; description: string; sql: string }> = {
  mrr: {
    title: 'Monthly recurring revenue',
    description: "Sum of subscriptions.mrr over rows with status='active'. mrr is USD per month; subscriptions.plan is the billed plan.",
    sql: "SELECT SUM(mrr) AS mrr FROM subscriptions WHERE status = 'active'",
  },
  arr: {
    title: 'Annual recurring revenue',
    description: 'Current MRR x 12.',
    sql: "SELECT SUM(mrr) * 12 AS arr FROM subscriptions WHERE status = 'active'",
  },
  churn_rate: {
    title: 'Logo churn rate',
    description:
      "Churned subscriptions / all subscriptions ever sold. Default definition: a subscription with status='churned' counts — NOTE this can over-count accounts that churned and later resubscribed; check get_corrections for user-saved definitions before answering.",
    sql: "SELECT COUNT(*) AS churned_subscriptions FROM subscriptions WHERE status = 'churned'",
  },
  active_subscriptions: {
    title: 'Active subscription count',
    description: "Subscriptions with status='active' right now.",
    sql: "SELECT COUNT(*) AS active_subscriptions FROM subscriptions WHERE status = 'active'",
  },
};

// id, name, plan, industry, region, created_at
const ACCOUNTS: Array<[number, string, string, string, string, string]> = [
  [1, 'Acme Corp', 'enterprise', 'manufacturing', 'NA', '2024-01-10'],
  [2, 'Brightside Retail', 'pro', 'retail', 'EU', '2023-11-02'],
  [3, 'Cobalt Labs', 'pro', 'technology', 'NA', '2023-09-15'],
  [4, 'Delta Foods', 'starter', 'food & beverage', 'NA', '2024-01-05'],
  [5, 'Everest Analytics', 'enterprise', 'finance', 'EU', '2023-10-01'],
  [6, 'Fernwell Clinics', 'starter', 'healthcare', 'APAC', '2024-02-08'],
  [7, 'Glacier Media', 'pro', 'media', 'NA', '2024-01-20'],
  [8, 'Harbor Logistics', 'enterprise', 'logistics', 'EU', '2024-02-12'],
  [9, 'Ironpeak Builders', 'starter', 'construction', 'NA', '2024-03-28'],
  [10, 'Juno Health', 'pro', 'healthcare', 'EU', '2024-02-25'],
  [11, 'Kettle & Co', 'pro', 'retail', 'NA', '2024-02-18'],
  [12, 'Lighthouse Edu', 'pro', 'education', 'APAC', '2023-12-01'],
];

// id, account_id, plan, mrr, status, started_at, ended_at
const SUBSCRIPTIONS: Array<[number, number, string, number, string, string, string | null]> = [
  // Churned-then-resubscribed: ended rows that must NOT count as churn once
  // the corrected definition ("no newer active subscription") is applied.
  [1, 2, 'pro', 179, 'churned', '2023-11-01', '2024-01-15'], // Brightside v1 -> sub 11
  [2, 3, 'pro', 199, 'churned', '2023-09-01', '2024-02-28'], // Cobalt v1 -> sub 12
  [3, 5, 'enterprise', 999, 'churned', '2023-10-01', '2024-01-10'], // Everest v1 -> sub 13
  [4, 12, 'starter', 49, 'churned', '2023-12-01', '2024-02-29'], // Lighthouse v1 -> sub 18
  [7, 7, 'pro', 199, 'churned', '2024-01-25', '2024-08-31'], // Glacier v1 -> sub 14
  [9, 11, 'starter', 49, 'churned', '2024-02-20', '2024-04-30'], // Kettle v1 -> sub 17
  // Churned for good — the corrected-definition answer set ($397 combined).
  [5, 4, 'starter', 49, 'churned', '2024-01-05', '2024-06-30'], // Delta Foods
  [6, 6, 'starter', 49, 'churned', '2024-02-10', '2024-05-15'], // Fernwell Clinics
  [8, 10, 'pro', 299, 'churned', '2024-03-01', '2024-09-30'], // Juno Health
  // Currently active — total MRR $4,673 (enterprise $3,599 / pro $995 / starter $79).
  [10, 1, 'enterprise', 899, 'active', '2024-01-15', null],
  [11, 2, 'pro', 199, 'active', '2024-02-01', null],
  [12, 3, 'pro', 249, 'active', '2024-03-10', null],
  [13, 5, 'enterprise', 1200, 'active', '2024-01-20', null],
  [14, 7, 'pro', 199, 'active', '2024-10-01', null],
  [15, 8, 'enterprise', 1500, 'active', '2024-02-15', null],
  [16, 9, 'starter', 79, 'active', '2024-04-01', null],
  [17, 11, 'pro', 149, 'active', '2024-07-01', null],
  [18, 12, 'pro', 199, 'active', '2024-05-10', null],
];

/** 'YYYY-MM-DD' + n months, day clamped to 28 so the result is always valid. */
function addMonths(isoDate: string, months: number): string {
  const [y, m] = isoDate.split('-').map(Number);
  const total = (y * 12 + (m - 1)) + months;
  const yy = Math.floor(total / 12);
  const mm = (total % 12) + 1;
  return `${yy}-${String(mm).padStart(2, '0')}-28`;
}

/** Deterministic usage figures — closed formulas, easy to eyeball in dumps. */
function usageFor(accountId: number, dayIndex: number): { active_users: number; events: number } {
  const active_users = 3 + ((accountId * 13 + dayIndex * 7) % 45);
  const events = active_users * (20 + ((accountId * 5 + dayIndex * 3) % 30));
  return { active_users, events };
}

/**
 * Build the warehouse in `:memory:` and return the open handle. The same
 * handle backs the run_query tool and the harness's own truth queries —
 * what the agent sees is exactly what the checks compute against.
 */
export function seedDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      plan TEXT NOT NULL,
      industry TEXT NOT NULL,
      region TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE subscriptions (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      plan TEXT NOT NULL,
      mrr INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE TABLE invoices (
      id INTEGER PRIMARY KEY,
      subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
      amount INTEGER NOT NULL,
      issued_at TEXT NOT NULL,
      paid INTEGER NOT NULL
    );
    CREATE TABLE usage_daily (
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      day TEXT NOT NULL,
      active_users INTEGER NOT NULL,
      events INTEGER NOT NULL
    );
  `);

  const insAccount = db.prepare('INSERT INTO accounts (id, name, plan, industry, region, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const row of ACCOUNTS) insAccount.run(...row);

  const insSub = db.prepare('INSERT INTO subscriptions (id, account_id, plan, mrr, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const row of SUBSCRIPTIONS) insSub.run(...row);

  // ~27 invoices: active subs bill twice (signup + month 2), churned subs
  // left a single final invoice. Every 9th invoice is unpaid.
  const insInvoice = db.prepare('INSERT INTO invoices (id, subscription_id, amount, issued_at, paid) VALUES (?, ?, ?, ?, ?)');
  let invoiceId = 1;
  for (const sub of SUBSCRIPTIONS) {
    const [subId, , , mrr, status, startedAt] = sub;
    const count = status === 'active' ? 2 : 1;
    for (let i = 0; i < count; i++) {
      insInvoice.run(invoiceId, subId, mrr, addMonths(startedAt, i), invoiceId % 9 === 0 ? 0 : 1);
      invoiceId++;
    }
  }

  // 40 usage rows: every account on days 0/2, accounts 1-8 also on days 1/3.
  const DAYS = ['2025-01-06', '2025-01-20', '2025-02-03', '2025-02-17'];
  const insUsage = db.prepare('INSERT INTO usage_daily (account_id, day, active_users, events) VALUES (?, ?, ?, ?)');
  for (const [accountId] of ACCOUNTS) {
    for (let d = 0; d < DAYS.length; d++) {
      if (d % 2 === 1 && accountId > 8) continue;
      const { active_users, events } = usageFor(accountId, d);
      insUsage.run(accountId, DAYS[d], active_users, events);
    }
  }

  return db;
}
