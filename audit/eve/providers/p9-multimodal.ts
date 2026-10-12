// P9 (live, ~4 calls): image input via OpenRouter - URL, bytes with/without mimeType.
// Run: npx tsx eve/providers/p9-multimodal.ts
import { deflateSync } from 'node:zlib';
import { createAgent } from '@lousho/build-ai-agent';
import { hasLiveKey, LIVE_MODEL } from '../../_shared/env.ts';
if (!hasLiveKey) throw new Error('needs OPENROUTER_API_KEY');

/** A solid-colour 16x16 PNG. */
function png(r: number, g: number, b: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(16, 0); ihdr.writeUInt32BE(16, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(16 * (1 + 16 * 3));
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) raw.set([r, g, b], y * 49 + 1 + x * 3);
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

const agent = createAgent({ model: LIVE_MODEL, instructions: 'Answer with one lowercase colour word.', retry: false, modelSettings: { maxTokens: 10 } });
const cases: Array<[string, any]> = [
  ['bytes + mimeType', { type: 'image', image: png(255, 0, 0), mimeType: 'image/png' }],
  ['bytes, no mimeType', { type: 'image', image: png(0, 0, 255) }],
  ['data: URL', { type: 'image', image: `data:image/png;base64,${Buffer.from(png(0, 255, 0)).toString('base64')}` }],
];
for (const [label, part] of cases) {
  try {
    const r = await agent.send([{ type: 'text', text: 'What colour is this image?' }, part]);
    console.log(JSON.stringify({ label, text: r.text, in: r.usage.inputTokens, estimated: r.usage.estimated }));
  } catch (e: any) {
    console.log(JSON.stringify({ label, THREW: e.code ?? e.name, msg: String(e.message).slice(0, 250) }));
  }
}
