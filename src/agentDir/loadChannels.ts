import { defineChannel, type Channel } from '../channels/defineChannel';
import { loadDefaultExports } from './loadDefaultExports';

/** A channel: an object with `parse` and `reply` functions (`name` may be left to the file name). */
function isChannelLike(value: unknown): value is Omit<Channel, 'name'> & { name?: string } {
  const channel = value as Partial<Channel> | null;
  return typeof channel === 'object' && channel !== null && typeof channel.parse === 'function' && typeof channel.reply === 'function';
}

/**
 * Loads every `channels/*.{ts,js,mjs,cjs,mts}` file under `dir` (sorted by
 * file name). Each file default-exports a channel from `defineChannel()` or a
 * built-in factory (`httpChannel()`, `webhookChannel()`, ...); its name is the
 * `name` it set, else the file name without extension.
 */
export function loadChannels(dir: string): Promise<Channel[]> {
  return loadDefaultExports(
    dir,
    'channels',
    'LOUSHO_CHANNEL_INVALID',
    'a channel from defineChannel(), httpChannel(), webhookChannel() or slackChannel().',
    isChannelLike,
    (channel, stem) => defineChannel({ ...channel, name: channel.name ?? stem } as Channel)
  );
}
