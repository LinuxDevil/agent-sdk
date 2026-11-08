import { promptInjectionSignals } from '../execution/guardrailStarterSet';
import type { CaseCount, CaseVerdict, ImproveChange, ImproveResult, ImproveStage } from './types';

const CASES_HEADER = '| Case | Role | Base | Result | pass^3 base | pass^3 result | Why |\n| --- | --- | --- | --- | --- | --- | --- |';

function addedLines(diff: string): string[] {
  return diff
    .split('\n')
    .filter((line) => line.startsWith('+ '))
    .map((line) => line.slice(2));
}

function quotedChecks(added: readonly string[], checks: readonly string[]): string[] {
  const text = added.join('\n').toLowerCase();
  return checks.filter((check) => check.trim() !== '' && text.includes(check.toLowerCase())).map((check) => `Quotes a failed check word for word: "${check}".`);
}

function injectionFlags(added: readonly string[]): string[] {
  const signals = promptInjectionSignals(added.join('\n'));
  return signals.length > 0 ? [`Adds text that looks like prompt injection (${signals.join(', ')}).`] : [];
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const namesWord = (text: string, name: string) => new RegExp(`(^|[^\\w-])${escaped(name)}($|[^\\w-])`, 'i').test(text);

function unnamedSkills(result: ImproveResult, added: readonly string[]): string[] {
  const harness = result.harness;
  if (!harness) return [];
  return Object.keys(harness.skills)
    .filter((name) => added.includes(`name: ${name}`) && !namesWord(harness.instructions, name))
    .map((name) => `Adds skill '${name}', but the instructions never name it.`);
}

function flags(result: ImproveResult): string {
  const added = addedLines(result.diff ?? '');
  const found = [...quotedChecks(added, result.failedChecks ?? []), ...injectionFlags(added), ...unnamedSkills(result, added)];
  return found.length > 0 ? found.map((flag) => `- ${flag}`).join('\n') : 'None.';
}

function fenced(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

function choose(n: number, k: number): number {
  let value = 1;
  for (let i = 0; i < k; i += 1) value = (value * (n - i)) / (i + 1);
  return value;
}

function passHat3({ passed, scored }: CaseCount): string {
  return scored < 3 ? '–' : (choose(passed, 3) / choose(scored, 3)).toFixed(2);
}

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const count = ({ passed, scored }: CaseCount) => `${passed}/${scored}`;

function caseRow(verdict: CaseVerdict): string {
  const cells = [cell(verdict.caseId), verdict.role, count(verdict.base), count(verdict.final), passHat3(verdict.base), passHat3(verdict.final), cell(verdict.reasons.join(' '))];
  return `| ${cells.join(' | ')} |`;
}

function cases(verdicts: readonly CaseVerdict[] | undefined): string {
  if (!verdicts || verdicts.length === 0) return 'No case was gated.';
  return [CASES_HEADER, ...verdicts.map(caseRow)].join('\n');
}

const quoted = (text: string) =>
  text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

const marked = (prefix: string, text: string | undefined) => (text === undefined ? [] : text.split('\n').map((line) => `${prefix} ${line}`));

function change(item: ImproveChange, index: number): string {
  const target = item.target.replace(/[`\n]/g, '');
  const lines = [...marked('-', item.before), ...marked('+', item.after)];
  return `${index + 1}. ${item.kind} \`${target}\`\n\n${fenced(lines.join('\n'))}\n\n${quoted(`Reason: ${item.reason ?? 'no reason given.'}`)}`;
}

function changes(items: readonly ImproveChange[] | undefined): string {
  return items && items.length > 0 ? items.map(change).join('\n\n') : 'No change proposed.';
}

function editor(stage: ImproveStage): string {
  const parts = [`### ${stage.label} (${stage.status})`, quoted(stage.notes || 'No notes.')];
  if (stage.error) parts.push(quoted(`Error: ${stage.error}`));
  return parts.join('\n\n');
}

/** Turns a result into Markdown for a person to review: each change with its reason, the diff, each case before and after, the editors' notes, and flags. */
export function formatImproveResult(result: ImproveResult): string {
  const sections = [
    `# Improve result: ${result.outcome}\n\n${result.reason}`,
    `## Flags\n\n${flags(result)}`,
    `## Changes\n\n${changes(result.changes)}`,
    `## Diff\n\n${result.diff ? fenced(result.diff) : 'No change proposed.'}`,
    `## Cases\n\n${cases(result.cases)}`,
  ];
  if (result.gate && result.gate.length > 0) sections.push(`## Gate\n\n${result.gate.map((verdict) => `- ${verdict.label}: ${verdict.passed ? 'passed' : 'failed'}. ${verdict.reason}`).join('\n')}`);
  sections.push(`## Editors\n\n${result.stages.length > 0 ? result.stages.map(editor).join('\n\n') : 'No editor ran.'}`, `## Spend\n\n${result.spend.tokens} tokens.`);
  return `${sections.join('\n\n')}\n`;
}
