import { defineSchedule } from '@lousho/build-ai-agent';

/**
 * The kit's batch intake: every 15 minutes the agent sweeps the inbox for
 * anything that arrived out-of-band (the channel triages webhooks live; this
 * catches mail dropped into inbox.json by a sync job, an importer, a human).
 */
export default defineSchedule({
  name: 'poll-inbox',
  cron: '*/15 * * * *',
  prompt: [
    'Check the inbox for new messages with list_messages (status "new").',
    'For each one: read_message, then classify_message as urgent / reply-needed / fyi / spam.',
    'Before drafting for a sender, recall_senders for what you know about them.',
    'For urgent and reply-needed messages, draft_reply in my voice, then call send_reply once - it pauses for my review.',
    'For fyi and spam, just classify and mark_processed.',
    'remember_senders anything durable you learned about a sender, then summarise what you did.',
  ].join(' '),
});
