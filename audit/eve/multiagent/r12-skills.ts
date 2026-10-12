/* Eve multiagent repro 12: loadSkills() on an Anthropic-style skills folder.
 *  A) a README.md at the skills root (as in anthropics/skills and most repos) fails the whole load.
 *  B) without the README: SKILL.md loads, but its bundled files (FORMS.md, scripts/) are unreachable:
 *     load_skill returns the body only, with no base path and no way to read referenced files.
 * Run: npx tsx eve/multiagent/r12-skills.ts */
import { loadSkills, createAgent } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const src = path.join(import.meta.dirname, 'fixtures', 'skills-anthropic');
try { await loadSkills(src); console.log('[A] loaded'); } catch (e: any) { console.log('[A] loadSkills threw:', e.code ?? '', e.message.split('\n')[0]); }
const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-skills-'));
fs.cpSync(src, copy, { recursive: true }); fs.rmSync(path.join(copy, 'README.md'));
const skills = await loadSkills(copy);
const m = mockModel([{ toolCalls: [{ name: 'load_skill', args: { name: 'pdf' } }] }, 'ok']);
const r = await createAgent({ provider: m, instructions: 'x', skills }).send('read my.pdf');
const loaded = String(r.messages.find((x: any) => x.role === 'tool')?.content);
console.log('[B] load_skill result:', JSON.stringify(loaded));
console.log('[B] tools offered:', (m.calls[0].tools ?? []).map((t: any) => t.name ?? t.function?.name));
