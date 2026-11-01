/**
 * The Author's byte-stable system prompt (PLAN 8.1): sixteen fixed section
 * files joined with '\n\n' into {@link AUTHOR_STATIC_PROMPT}, plus the
 * deterministic `# Preloaded catalogs` block from catalogPreamble.ts.
 * Built once at server start and handed to the turn runner as
 * `systemPrompt: () => prompt`; per-turn context (focus, spec summary,
 * open cards) travels on the user message instead, so these bytes never
 * change while Studio runs. The snapshot test is the tripwire for edits.
 */
import { PREAMBLE_SECTION } from './sections/preamble';
import { INTENT_SECTION } from './sections/intent';
import { TURN_CONTEXT_SECTION } from './sections/turnContext';
import { GROUNDING_SECTION } from './sections/grounding';
import { CREATE_WORKFLOW_SECTION } from './sections/createWorkflow';
import { EDIT_WORKFLOW_SECTION } from './sections/editWorkflow';
import { PATCH_CONTRACT_SECTION } from './sections/patchContract';
import { SPEC_FIELDS_SECTION } from './sections/specFields';
import { BUILDING_BLOCKS_SECTION } from './sections/buildingBlocks';
import { WRITING_INSTRUCTIONS_SECTION } from './sections/writingInstructions';
import { SECRETS_SECTION } from './sections/secrets';
import { TRYING_DRAFTS_SECTION } from './sections/tryingDrafts';
import { UI_EVENTS_SECTION } from './sections/uiEvents';
import { HONESTY_SECTION } from './sections/honesty';
import { REPLY_STYLE_SECTION } from './sections/replyStyle';
import { RULES_SECTION } from './sections/rules';
import { renderCatalogPreamble, type AuthorPromptCatalogs } from './catalogPreamble';

export type { AuthorPromptCatalogs } from './catalogPreamble';

/** The sixteen sections in assembly order. Joined with '\n\n'. */
export const AUTHOR_PROMPT_SECTIONS: readonly string[] = [
  PREAMBLE_SECTION,
  INTENT_SECTION,
  TURN_CONTEXT_SECTION,
  GROUNDING_SECTION,
  CREATE_WORKFLOW_SECTION,
  EDIT_WORKFLOW_SECTION,
  PATCH_CONTRACT_SECTION,
  SPEC_FIELDS_SECTION,
  BUILDING_BLOCKS_SECTION,
  WRITING_INSTRUCTIONS_SECTION,
  SECRETS_SECTION,
  TRYING_DRAFTS_SECTION,
  UI_EVENTS_SECTION,
  HONESTY_SECTION,
  REPLY_STYLE_SECTION,
  RULES_SECTION,
];

/** The prompt's fixed part: every section, no catalogs. Snapshot-tested. */
export const AUTHOR_STATIC_PROMPT: string = AUTHOR_PROMPT_SECTIONS.join('\n\n');

/**
 * AUTHOR_STATIC_PROMPT + '\n\n' + renderCatalogPreamble(catalogs). Computed
 * once at server start from the D09 catalog functions.
 */
export function buildAuthorSystemPrompt(catalogs: AuthorPromptCatalogs): string {
  return AUTHOR_STATIC_PROMPT + '\n\n' + renderCatalogPreamble(catalogs);
}
