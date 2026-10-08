/**
 * Deterministic collector: calls the GUARDED `hostinger__execute` descriptor
 * directly (no model) so the report has trustworthy numbers to compare the
 * agent's structured output against.
 */
import { EXECUTE_TOOL } from './guard.js';
import { THRESHOLDS, type VmHealth } from './schema.js';

type Exec = (args: { operation: string; params?: Record<string, unknown> }, ctx?: unknown) => Promise<any>;

function parse(result: any): any {
  const text = typeof result?.text === 'string' ? result.text : JSON.stringify(result);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const series = (m: any, key: string): number[] => Object.values(m?.[key]?.usage ?? {}).map(Number).filter(Number.isFinite);
const round = (n: number) => Math.round(n * 10) / 10;

export interface CollectedVm extends VmHealth {
  netInMB: number;
  netOutMB: number;
  backupAgeHours: number | null;
  samples: number;
}

export async function collectFleet(tools: Record<string, any>, hours: number, now = new Date()): Promise<CollectedVm[]> {
  const apiErrors: string[] = [];
  const exec: Exec = async (args) => {
    // The Hostinger API intermittently answers 500 ([VPS:9999]); retry once, then degrade instead of aborting the report.
    for (let i = 0; ; i++) {
      try {
        return await tools[EXECUTE_TOOL].execute(args, {});
      } catch (e: any) {
        if (i >= 1 || args.operation === 'vps_virtual-machines_list') throw e;
        await new Promise((r) => setTimeout(r, 3000));
        if (i === 0) apiErrors.push(`${args.operation}: ${String(e?.message).slice(0, 80)}`);
      }
    }
  };
  const safe = async (args: Parameters<Exec>[0]) => { try { return await exec(args); } catch (e: any) { apiErrors.push(`${args.operation} failed: ${String(e?.message).slice(0, 80)}`); return { text: '{}' }; } };
  const list = parse(await exec({ operation: 'vps_virtual-machines_list' }));
  const vms: any[] = Array.isArray(list) ? list : list?.data ?? [];
  const from = new Date(now.getTime() - hours * 3600e3).toISOString();
  const out: CollectedVm[] = [];
  for (const vm of vms) {
    const metrics = parse(await safe({ operation: 'vps_virtual-machines_metrics', params: { virtualMachineId: vm.id, date_from: from, date_to: now.toISOString() } }));
    const actions = parse(await safe({ operation: 'vps_actions_list', params: { virtualMachineId: vm.id } }));
    const backups = parse(await safe({ operation: 'vps_backups_list', params: { virtualMachineId: vm.id } }));
    const cpu = series(metrics, 'cpu_usage');
    const ram = series(metrics, 'ram_usage');
    const disk = series(metrics, 'disk_space');
    const netIn = series(metrics, 'incoming_traffic');
    const netOut = series(metrics, 'outgoing_traffic');
    const memBytes = Number(vm.memory) * 1024 * 1024; // plan memory is MB
    const diskBytes = Number(vm.disk) * 1024 * 1024; // plan disk is MB
    const backupList: any[] = backups?.data ?? [];
    const newest = backupList.map((b) => b.created_at).sort().at(-1) ?? null;
    const backupAgeHours = newest ? round((now.getTime() - Date.parse(newest)) / 3600e3) : null;
    const actionList: any[] = (actions?.data ?? []).slice(0, 5);
    const health: CollectedVm = {
      id: vm.id,
      hostname: vm.hostname,
      state: vm.state,
      plan: vm.plan,
      ipv4: vm.ipv4?.[0]?.address ?? '',
      cpuAvgPct: cpu.length ? round(cpu.reduce((a, b) => a + b, 0) / cpu.length) : 0,
      cpuMaxPct: cpu.length ? round(Math.max(...cpu)) : 0,
      ramUsedPct: ram.length ? round((ram.at(-1)! / memBytes) * 100) : 0,
      diskUsedPct: disk.length ? round((disk.at(-1)! / diskBytes) * 100) : 0,
      netInMB: round(netIn.reduce((a, b) => a + b, 0) / 1e6),
      netOutMB: round(netOut.reduce((a, b) => a + b, 0) / 1e6),
      recentActions: actionList.map((a) => `${a.name}:${a.state}@${a.created_at}`),
      lastBackupAt: newest,
      backupAgeHours,
      samples: cpu.length,
      anomalies: [],
    };
    health.anomalies = detectAnomalies(health, actionList);
    health.anomalies.push(...apiErrors.splice(0).map((e) => `api-error(${e})`));
    out.push(health);
  }
  return out;
}

export function detectAnomalies(vm: CollectedVm, actions: any[] = []): string[] {
  const a: string[] = [];
  if (vm.state !== 'running') a.push(`vm-${vm.state}`);
  if (vm.cpuAvgPct > THRESHOLDS.cpuAvgPct) a.push(`cpu-avg-high(${vm.cpuAvgPct}%)`);
  if (vm.cpuMaxPct > THRESHOLDS.cpuMaxPct) a.push(`cpu-spike(${vm.cpuMaxPct}%)`);
  if (vm.ramUsedPct > THRESHOLDS.ramUsedPct) a.push(`ram-high(${vm.ramUsedPct}%)`);
  if (vm.diskUsedPct > THRESHOLDS.diskUsedPct) a.push(`disk-nearly-full(${vm.diskUsedPct}%)`);
  if (vm.backupAgeHours === null) a.push('no-backup');
  else if (vm.backupAgeHours > THRESHOLDS.backupMaxAgeHours) a.push(`backup-stale(${Math.round(vm.backupAgeHours / 24)}d)`);
  if (vm.samples === 0) a.push('no-metrics');
  for (const act of actions) if (act.state && act.state !== 'success') a.push(`action-${act.name}-${act.state}`);
  return a;
}
