/**
 * The `<forge-chat>` widget bundle entry (X04b): importing this file
 * registers the custom element. `vite.widget.config.ts` builds it into
 * `dist/widget/forge-chat.js`, which Studio serves at
 * `GET /serve/:id/widget.js`.
 */
import { defineForgeChat } from './forgeChat';

defineForgeChat();
