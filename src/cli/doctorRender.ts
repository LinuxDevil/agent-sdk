/**
 * Plain ASCII rendering of a DoctorReport. Colour is opt-in and applied only
 * to the status tag, so the text reads the same without it.
 */
import type { CheckStatus, DoctorCheck, DoctorReport } from './doctorTypes';

const TAGS: Record<CheckStatus, string> = { ok: '[ ok ]', warn: '[warn]', fail: '[FAIL]' };
const COLORS: Record<CheckStatus, string> = { ok: '32', warn: '33', fail: '31' };

export interface RenderOptions {
  color?: boolean;
}

function tag(status: CheckStatus, color: boolean): string {
  return color ? `\u001b[${COLORS[status]}m${TAGS[status]}\u001b[0m` : TAGS[status];
}

function renderCheck(check: DoctorCheck, color: boolean): string[] {
  const lines = [`${tag(check.status, color)} ${check.title}: ${check.finding}`];
  if (check.status !== 'ok' && check.fix) lines.push(`       fix: ${check.fix}`);
  return lines;
}

export function renderReport(report: DoctorReport, options: RenderOptions = {}): string {
  const color = options.color === true;
  const { ok, warn, fail } = report.summary;
  return [
    'loushy doctor',
    '',
    ...report.checks.flatMap((check) => renderCheck(check, color)),
    '',
    `${ok} ok, ${warn} warning${warn === 1 ? '' : 's'}, ${fail} failure${fail === 1 ? '' : 's'}`,
  ].join('\n');
}

export function renderJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}
