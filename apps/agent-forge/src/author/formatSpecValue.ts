/**
 * The one-line value each proposal-card config row shows for a spec field
 * (research §1.4's "full configuration" rows). Pure: it reads the stored
 * `AgentSpecV2` field values and never re-derives anything the server
 * already computed (the diff is `output.changes`, never recomputed here).
 */

/** `JSON.stringify` clip length for fields with no dedicated formatter. */
const CLIP = 120;

/** The display name of one `spec.tools` entry, one arm per ToolRef variant. */
function toolName(ref: unknown): string {
  if (typeof ref !== 'object' || ref === null) return String(ref);
  const r = ref as Record<string, unknown>;
  let name: string;
  if (typeof r['builtin'] === 'string') name = r['builtin'];
  else if (typeof r['registry'] === 'string') name = `${r['registry']} (registry)`;
  else if (typeof r['file'] === 'string') name = basename(r['file']);
  else if (typeof r['integration'] === 'string') name = `${r['integration']} integration`;
  else if (typeof r['openapi'] === 'object' && r['openapi'] !== null) name = urlHost((r['openapi'] as { url?: unknown }).url);
  else if (typeof r['hosted'] === 'string') name = `${r['hosted']} (hosted)`;
  else if (r['hub'] === true) name = 'Context hub';
  else return clip(JSON.stringify(ref));
  // `approval: 'always'` is the one option a reader must see at a glance.
  return r['approval'] === 'always' ? `${name} · approval` : name;
}

/** The last path segment of a `{ file }` ref. */
function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/** The host of an `{ openapi }` ref's URL; the raw value when it will not parse. */
function urlHost(url: unknown): string {
  if (typeof url !== 'string') return clip(JSON.stringify(url));
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The one-line summary of one `spec.triggers` entry. */
function triggerName(trigger: unknown): string {
  if (typeof trigger !== 'object' || trigger === null) return String(trigger);
  const t = trigger as Record<string, unknown>;
  switch (t['type']) {
    case 'chat':
      return 'Chat';
    case 'cron':
      return `Cron ${String(t['cron'] ?? '')}${typeof t['timezone'] === 'string' ? ` ${t['timezone']}` : ''}`.trimEnd();
    case 'webhook':
      return `Webhook ${String(t['path'] ?? '')}`;
    case 'channel':
      return `${capitalize(String(t['channel'] ?? ''))} channel`;
    case 'agent':
      return `After ${String(t['after'] ?? '')} (${String(t['on'] ?? '')})`;
    default:
      return clip(JSON.stringify(trigger));
  }
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/** A guardrail's `<name> (<on>)`; `on` defaults to the input+output sides like the schema. */
function guardrailName(entry: unknown): string {
  if (typeof entry !== 'object' || entry === null) return String(entry);
  const g = entry as { name?: unknown; on?: unknown };
  const on = g.on === undefined ? 'input, output' : Array.isArray(g.on) ? g.on.join(', ') : String(g.on);
  return `${String(g.name ?? '')} (${on})`;
}

/** A permission rule's `<action> <tool>`; `tool` may be a name or a list. */
function permissionName(entry: unknown): string {
  if (typeof entry !== 'object' || entry === null) return String(entry);
  const p = entry as { action?: unknown; tool?: unknown };
  const tool = Array.isArray(p.tool) ? p.tool.join(', ') : String(p.tool ?? '');
  return `${String(p.action ?? '')} ${tool}`.trim();
}

/** `JSON.stringify` clipped to {@link CLIP} chars with an ellipsis. */
function clip(s: string): string {
  return s.length > CLIP ? `${s.slice(0, CLIP)}…` : s;
}

/** Joined display names of a list field through `each`; objects join their keys when `each` is absent. */
function listValue(value: unknown, each?: (entry: unknown) => string): string {
  if (Array.isArray(value)) {
    return value.map((entry) => (each ? each(entry) : clip(JSON.stringify(entry)))).join(', ');
  }
  if (typeof value === 'object' && value !== null) return Object.keys(value).join(', ');
  return clip(JSON.stringify(value));
}

/**
 * The config-row text for spec field `key` holding `value`: tools as
 * display names, triggers as one-liners, keyed maps as their keys, and
 * everything else `JSON.stringify` clipped to 120 chars.
 */
export function formatSpecValue(key: string, value: unknown): string {
  switch (key) {
    case 'tools':
      return listValue(value, toolName);
    case 'triggers':
      return listValue(value, triggerName);
    case 'mcpServers':
    case 'subagents':
      return listValue(value);
    case 'handoffs':
      return listValue(value, (h) => String((h as { agent?: unknown }).agent ?? h));
    case 'guardrails':
      return listValue(value, guardrailName);
    case 'permissions':
      return listValue(value, permissionName);
    default:
      if (typeof value === 'string') return value;
      if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join(', ');
      return clip(JSON.stringify(value));
  }
}
