#!/usr/bin/env node
/**
 * deploy.mjs — build the vps-ops agent and deploy it to a Hostinger VPS.
 *
 *   HOSTINGER_API_TOKEN=... OPENROUTER_API_KEY=... LOUSHO_API_TOKEN=... \
 *     node examples/hostinger-deploy/deploy.mjs --vm <id|hostname|ip>
 *
 * Steps: verify the VM via the Hostinger API (the same API the hostinger-vps
 * MCP server wraps) → `lousho build --target=docker` → ship the build context
 * over SSH → remote `docker build` + `docker run` → `/health` + one `/chat`
 * round-trip.
 *
 * The deploy is additive: it builds and (re)starts one `lousho-agent`
 * container. `--recreate` and other destructive VM ops are intentionally NOT
 * here — provisioning belongs to the Hostinger API/console.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const API = 'https://developers.hostinger.com';
const CONTAINER = 'lousho-agent';
const PORT = 3000;

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

const required = ['HOSTINGER_API_TOKEN', 'OPENROUTER_API_KEY', 'LOUSHO_API_TOKEN'];
const missing = required.filter((k) => !process.env[k]);
const vmRef = arg('--vm');
if (missing.length || !vmRef) {
  console.error(
    `usage: ${required.join('=... ')}=... node deploy.mjs --vm <id|hostname|ip>` +
      (missing.length ? `\nmissing env: ${missing.join(', ')}` : '') +
      (vmRef ? '' : '\nmissing --vm'),
  );
  process.exit(1);
}

const SECRET_ENVS = required.map((k) => process.env[k]).filter(Boolean);
const redact = (s) => SECRET_ENVS.reduce((out, v) => out.split(v).join('***'), s);
// No shell: cmd.exe would split the remote ssh command on && / || / >.
const sh = (cmd, args, opts = {}) => {
  console.log(`+ ${cmd} ${redact(args.join(' '))}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    console.error(`${cmd} failed (${r.status})`);
    process.exit(1);
  }
};

const api = async (p) => {
  const res = await fetch(`${API}${p}`, {
    headers: { Authorization: `Bearer ${process.env.HOSTINGER_API_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Hostinger API ${p}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
};

// 1. Find and verify the VM.
const vms = await api('/api/vps/v1/virtual-machines');
const list = Array.isArray(vms) ? vms : vms.data ?? [];
const vm = list.find(
  (v) => String(v.id) === vmRef || v.hostname === vmRef || v.ipv4?.some((a) => a.address === vmRef),
);
if (!vm) {
  console.error(`no VM matching '${vmRef}'. Known: ${list.map((v) => `${v.id}:${v.hostname}`).join(', ')}`);
  process.exit(1);
}
if (vm.state !== 'running') {
  console.error(`VM ${vm.id} (${vm.hostname}) is ${vm.state} — start it first`);
  process.exit(1);
}
const ip = vm.ipv4?.[0]?.address;
if (!ip) {
  console.error(`VM ${vm.id} has no IPv4 address`);
  process.exit(1);
}
console.log(`vm: ${vm.id} ${vm.hostname} ${ip} (${vm.template?.name ?? 'unknown template'})`);

// 2. Build the docker target.
const buildDir = mkdtempSync(path.join(tmpdir(), 'lousho-deploy-'));
try {
  sh(process.execPath, [path.join(REPO, 'bin', 'lousho.js'), 'build', path.join(HERE, 'agent'), '--target=docker', `--out=${path.join(buildDir, 'docker')}`], { cwd: REPO });

  // 3. Ship the build context and build + run the container on the VM.
  const remote = `root@${ip}`;
  const archive = path.join(buildDir, 'context.tgz');
  sh('tar', [...(process.platform === 'win32' ? ['--force-local'] : []), '-czf', archive, '-C', path.join(buildDir, 'docker'), '.']);
  sh('ssh', [remote, 'mkdir -p /opt/lousho-agent']);
  sh('scp', [archive, `${remote}:/opt/lousho-agent/context.tgz`]);
  sh('ssh', [
    remote,
    `cd /opt/lousho-agent && tar -xzf context.tgz` +
      ` && docker build -q -t ${CONTAINER} .` +
      ` && (docker rm -f ${CONTAINER} >/dev/null 2>&1 || true)` +
      ` && docker run -d --name ${CONTAINER} --restart unless-stopped` +
      ` -p ${PORT}:${PORT}` +
      ` -e OPENROUTER_API_KEY='${process.env.OPENROUTER_API_KEY}'` +
      ` -e LOUSHO_API_TOKEN='${process.env.LOUSHO_API_TOKEN}'` +
      ` -e LOUSHO_STORE=sqlite:/data/lousho.db` +
      ` -v lousho-data:/data` +
      ` ${CONTAINER}`,
  ]);

  // 4. Health check + one /chat round-trip.
  let healthy = false;
  for (let i = 0; i < 20 && !healthy; i++) {
    try {
      healthy = (await fetch(`http://${ip}:${PORT}/health`)).ok;
    } catch {}
    if (!healthy) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!healthy) {
    console.error(`no /health on http://${ip}:${PORT} — check 'ssh ${remote} docker logs ${CONTAINER}'`);
    process.exit(1);
  }
  console.log(`healthy: http://${ip}:${PORT}/health`);

  const chat = await fetch(`http://${ip}:${PORT}/chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.LOUSHO_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sessionId: 'deploy-smoke',
      input: 'Report host_status, then reply in one line.',
    }),
  });
  if (!chat.ok) throw new Error(`/chat: HTTP ${chat.status} ${await chat.text()}`);
  process.stdout.write(await chat.text());
  console.log(`\ndeployed: http://${ip}:${PORT}/chat (Bearer LOUSHO_API_TOKEN)`);
} finally {
  if (existsSync(buildDir)) rmSync(buildDir, { recursive: true, force: true });
}
