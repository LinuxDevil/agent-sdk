import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Reads the Hostinger API token from ~/.claude.json at runtime.
 * The value is never printed, logged or written anywhere by this project.
 */
export function readHostingerToken(): string {
  const cfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
  const token: unknown = cfg?.mcpServers?.['hostinger-vps']?.env?.HOSTINGER_API_TOKEN;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('HOSTINGER_API_TOKEN not found in ~/.claude.json mcpServers["hostinger-vps"].env');
  }
  return token;
}

/** Replace every occurrence of the token in a string (defence in depth for logs). */
export function scrub(text: string, token: string): string {
  return token ? text.split(token).join('[REDACTED]') : text;
}
