/** Tiny HTTP/SSE client used by the scenario driver (plain fetch, no SDK). */
export const BASE = process.env.SUPPORT_URL ?? 'http://localhost:4321/api/support';

export interface SseResult { status: number; events: any[]; raw: string; doneFrame: boolean; json?: any }

export async function sse(path: string, body: unknown, token: string, opts: { abortAfter?: (e: any) => boolean } = {}): Promise<SseResult> {
  const controller = new AbortController();
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', signal: controller.signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, events: [], raw: text, doneFrame: false, json };
  }
  const events: any[] = [];
  let raw = '';
  let doneFrame = false;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      raw += chunk; buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
        if (frame.startsWith('event: done')) { doneFrame = true; continue; }
        const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        if (!data) continue;
        const event = JSON.parse(data);
        events.push(event);
        if (opts.abortAfter?.(event)) { controller.abort(); return { status: res.status, events, raw, doneFrame }; }
      }
    }
  } catch (error) {
    if ((error as Error).name !== 'AbortError') throw error;
  }
  return { status: res.status, events, raw, doneFrame };
}

export async function getJson(path: string, token: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: text }; }
}

export const summarize = (events: any[]) =>
  events.filter((e) => !['text.delta', 'reasoning.delta'].includes(e.type)).map((e) => {
    switch (e.type) {
      case 'tool.start': case 'tool.resume': return `${e.type}(${e.toolName} ${JSON.stringify(e.args)})`;
      case 'tool.done': return `tool.done(${e.toolName} -> ${JSON.stringify(e.result).slice(0, 120)})`;
      case 'tool.error': return `tool.error(${e.toolName}: ${e.error.message.slice(0, 100)})`;
      case 'handoff': return `handoff(${e.from}->${e.to})`;
      case 'approval.requested': return `approval.requested(${e.toolName} ${JSON.stringify(e.args)} id=${e.approvalId})`;
      case 'run.done': return `run.done(${e.finishReason}) text=${JSON.stringify(e.text.slice(0, 200))}`;
      case 'error': return `error(${e.error.name}: ${e.error.message.slice(0, 160)})`;
      case 'step.done': return `step.done(${e.step},${e.finishReason})`;
      default: return e.type;
    }
  }).join('\n  ');
