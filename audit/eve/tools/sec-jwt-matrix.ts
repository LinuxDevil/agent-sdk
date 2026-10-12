/** sec-jwt-matrix: classic JWT attacks against jwt({ publicKey }) and jwt({ secret }). */
import { generateKeyPairSync, createSign, createHmac } from 'node:crypto';
import { jwt, basic, routeAuth } from '@lousho/build-ai-agent/auth';
const b64 = (o: unknown) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const now = Math.floor(Date.now() / 1000);
const good = { sub: 'u1', aud: 'api', iss: 'https://iss', exp: now + 600 };
const rs = (h: object, p: object) => { const d = `${b64(h)}.${b64(p)}`; return `${d}.${createSign('RSA-SHA256').update(d).sign(privateKey).toString('base64url')}`; };
const hs = (h: object, p: object, key: string | Buffer) => { const d = `${b64(h)}.${b64(p)}`; return `${d}.${createHmac('sha256', key).update(d).digest('base64url')}`; };
const auth = jwt({ publicKey: pem, audience: 'api', issuer: 'https://iss' });
const cases: Record<string, string> = {
  valid: rs({ alg: 'RS256' }, good),
  algNone: `${b64({ alg: 'none' })}.${b64(good)}.`,
  algNONEsig: `${b64({ alg: 'NoNe' })}.${b64(good)}.${b64('x')}`,
  hs256WithPublicPem: hs({ alg: 'HS256' }, good, pem),
  missingExp: rs({ alg: 'RS256' }, { ...good, exp: undefined }),
  expired70s: rs({ alg: 'RS256' }, { ...good, exp: now - 70 }),
  nbfFuture: rs({ alg: 'RS256' }, { ...good, nbf: now + 120 }),
  wrongAud: rs({ alg: 'RS256' }, { ...good, aud: 'other' }),
  audArrayOk: rs({ alg: 'RS256' }, { ...good, aud: ['x', 'api'] }),
  wrongIss: rs({ alg: 'RS256' }, { ...good, iss: 'https://evil' }),
  critHeader: rs({ alg: 'RS256', crit: ['b64'], b64: false }, good),
  jkuHeader: rs({ alg: 'RS256', jku: 'https://evil/jwks' }, good),
  expString: rs({ alg: 'RS256' }, { ...good, exp: String(now + 600) }),
  tamperedPayload: (() => { const t = rs({ alg: 'RS256' }, good).split('.'); return `${t[0]}.${b64({ ...good, sub: 'admin' })}.${t[2]}`; })(),
};
for (const [name, token] of Object.entries(cases)) {
  const out = await routeAuth(new Request('https://x/', { headers: { authorization: `Bearer ${token}` } }), auth);
  console.log(name.padEnd(20), out.ok ? `ACCEPT ${out.principal.id}` : `reject ${out.response.status}`);
}
// basic(): wrong user vs wrong password timing shape is constant-time by design; check behaviour only
const b = basic({ users: { ops: 'correct horse battery' } });
for (const [u, p] of [['ops', 'correct horse battery'], ['ops', 'x'], ['nobody', 'correct horse battery'], ['ops', 'correct horse battery:extra']]) {
  const out = await routeAuth(new Request('https://x/', { headers: { authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') } }), b);
  console.log(`basic ${u}:${p}`.padEnd(40), out.ok ? 'ACCEPT' : 'reject');
}
