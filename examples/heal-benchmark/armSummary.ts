import type { Arm, ArmRow } from './gates';
import type { ProbeCounts } from './probeCache';
import type { ReplayLine } from './replayRows';

export interface Confirmation {
  attempt: number;
  caseId: string;
  passed: number;
  scored: number;
}

export interface SummaryInput {
  rows: readonly ArmRow[];
  trueFixes: ReadonlySet<number>;
  confirmations: readonly Confirmation[];
  healthy: readonly { outcome: string }[];
  arms: readonly Arm[];
}

export interface Bar {
  name: string;
  passed: number;
  total: number;
  met: boolean;
}

const GATED: readonly Arm[] = ['A', 'B', 'C', 'D'];

export function trueFixAttempts(lines: readonly ReplayLine[]): Set<number> {
  return new Set(lines.filter((line) => line.containsFix).map((line) => line.attempt));
}

const ofArm = (rows: readonly ArmRow[], arm: Arm) => rows.filter((row) => row.arm === arm);
const accepted = (rows: readonly ArmRow[]) => rows.filter((row) => row.accepted).length;

function fixBar(input: SummaryInput): Bar {
  const fixes = ofArm(input.rows, 'D').filter((row) => input.trueFixes.has(row.attempt));
  const passed = accepted(fixes);
  return { name: 'Arm D accepts at least 3/5 recorded true fixes', passed, total: fixes.length, met: fixes.length >= 5 && passed * 5 >= fixes.length * 3 };
}

function noOpBar(input: SummaryInput): Bar {
  const rows = ofArm(input.rows, 'N');
  const passed = accepted(rows);
  return { name: 'No-op accepted at most 1/10', passed, total: rows.length, met: rows.length >= 10 && passed * 10 <= rows.length };
}

function plantedBar(input: SummaryInput): Bar {
  const rows = ofArm(input.rows, 'P');
  const passed = rows.length - accepted(rows);
  return { name: 'Planted regression rejected at least 9/10', passed, total: rows.length, met: rows.length >= 10 && passed * 10 >= rows.length * 9 };
}

function confirmBar(input: SummaryInput): Bar {
  const held = input.confirmations.filter((count) => count.scored > 0 && count.passed * 6 >= count.scored * 5).length;
  return { name: 'Every held-out case 5/6 or better on confirmation, for every proposal', passed: held, total: input.confirmations.length, met: held === input.confirmations.length };
}

function healthyBar(input: SummaryInput): Bar {
  const quiet = input.healthy.filter((row) => row.outcome !== 'proposal').length;
  const total = input.healthy.length;
  return { name: 'At least 4/5 healthy attempts propose nothing', passed: quiet, total, met: total >= 5 && quiet * 5 >= total * 4 };
}

function reportedBar(input: SummaryInput): Bar {
  const reported = input.arms.filter((arm) => ofArm(input.rows, arm).length > 0).length;
  return { name: 'pass^3 and excluded runs reported for every arm', passed: reported, total: input.arms.length, met: reported === input.arms.length };
}

export function bars(input: SummaryInput): Bar[] {
  return [fixBar(input), noOpBar(input), plantedBar(input), confirmBar(input), healthyBar(input), reportedBar(input)];
}

const table = (head: readonly string[], body: readonly (readonly string[])[]) => [head, head.map(() => '---'), ...body].map((cells) => `| ${cells.join(' | ')} |`).join('\n');

function armLine(input: SummaryInput, arm: Arm): string[] {
  const rows = ofArm(input.rows, arm);
  const fixes = rows.filter((row) => input.trueFixes.has(row.attempt));
  return [arm, `${accepted(rows)}/${rows.length}`, GATED.includes(arm) ? `${accepted(fixes)}/${fixes.length}` : 'n/a'];
}

function meanPassK(rows: readonly ArmRow[], caseId: string): string {
  const values = rows.map((row) => row.passK[caseId]).filter((value): value is number => typeof value === 'number');
  return values.length === 0 ? 'n/a' : (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2);
}

function passKTable(input: SummaryInput): string {
  const cases = [...new Set(input.rows.flatMap((row) => Object.keys(row.passK)))].sort();
  return table(['Arm', ...cases], input.arms.map((arm) => [arm, ...cases.map((caseId) => meanPassK(ofArm(input.rows, arm), caseId))]));
}

export function renderReport(input: SummaryInput, counts: Readonly<Record<string, ProbeCounts>>): string {
  const arms = table(['Arm', 'Accepted', 'Accepted true fixes'], input.arms.map((arm) => armLine(input, arm)));
  const barTable = table(['Bar', 'Result', 'Met'], bars(input).map((bar) => [bar.name, `${bar.passed}/${bar.total}`, bar.met ? 'met' : 'missed']));
  const probes = table(['Probes', 'Planned', 'Run', 'Cached', 'Excluded'], Object.entries(counts).map(([name, count]) => [name, String(count.planned), String(count.run), String(count.cached), String(count.excluded)]));
  return [arms, barTable, 'Mean pass^3 per case, on the harness each arm would ship:', passKTable(input), probes].join('\n\n');
}
