import { z } from 'zod';

/** What the agent must return (structured output). Kept flat so a 9B model can fill it. */
export const VmHealthSchema = z.object({
  id: z.number().int().describe('virtual machine id'),
  hostname: z.string(),
  state: z.string().describe('e.g. running, stopped'),
  plan: z.string(),
  ipv4: z.string().describe('first IPv4 address, or empty string'),
  cpuAvgPct: z.number().describe('average CPU usage % over the window'),
  cpuMaxPct: z.number().describe('max CPU usage % over the window'),
  ramUsedPct: z.number().describe('latest RAM used as % of the plan memory'),
  diskUsedPct: z.number().describe('latest disk used as % of the plan disk'),
  recentActions: z.array(z.string()).describe('up to 5 most recent actions as "name:state@date"'),
  lastBackupAt: z.string().nullable().describe('ISO date of newest backup, null if none'),
  anomalies: z.array(z.string()).describe('short anomaly labels; empty when healthy'),
});

export const FleetReportSchema = z.object({
  fleetStatus: z.enum(['ok', 'warning', 'critical']),
  vms: z.array(VmHealthSchema),
  summary: z.string().describe('2-3 sentence human summary'),
});

export type FleetReport = z.infer<typeof FleetReportSchema>;
export type VmHealth = z.infer<typeof VmHealthSchema>;

/** Thresholds used for anomaly detection (deterministic side). */
export const THRESHOLDS = {
  cpuAvgPct: 70,
  cpuMaxPct: 90,
  ramUsedPct: 90,
  diskUsedPct: 85,
  backupMaxAgeHours: 8 * 24, // Hostinger backups are weekly
};
