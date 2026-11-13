import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveProvider } from 'lousho';
import { createWorkspaceRuntime, memorySource, type PageResult } from 'lousho/workspaces';
import { marketingHost, PAGES, readWorkspaceFiles, type PageId } from './host';

const TOPIC = 'why the sky is blue';

function pagesOf(page: string | undefined): readonly PageId[] {
  if (page === undefined) return PAGES;
  const found = PAGES.find((id) => id === page || id === `${page}-videos`);
  if (!found) throw new Error(`unknown page '${page}'; use one of ${PAGES.join(', ')}`);
  return [found];
}

export interface RunOptions {
  page?: string;
  mock: boolean;
  model?: string;
  storageDir?: string;
}

export async function runMarketing(options: RunOptions): Promise<Record<string, PageResult>> {
  if (!options.mock && options.model === undefined) throw new Error('pass --mock to run offline, or --model <provider/model> to use a live model');
  const storageDir = options.storageDir ?? mkdtempSync(join(tmpdir(), 'workspace-marketing-'));
  const live = options.model;
  const host = marketingHost({ storageDir, ...(!options.mock && live !== undefined && { providers: () => resolveProvider(live) }) });
  const runtime = createWorkspaceRuntime(memorySource(readWorkspaceFiles()), host);
  const results: Record<string, PageResult> = {};
  for (const pageId of pagesOf(options.page)) {
    results[pageId] = await runtime.runPage(pageId, { task: `Make a short video about ${TOPIC}.`, inputs: { topic: TOPIC } });
  }
  await runtime.close();
  console.log(`artifacts are under ${join(storageDir, 'artifacts')}`);
  return results;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { page: { type: 'string' }, mock: { type: 'boolean', default: false }, model: { type: 'string' } } });
  const results = await runMarketing({ mock: values.mock, ...(values.page !== undefined && { page: values.page }), ...(values.model !== undefined && { model: values.model }) });
  for (const [pageId, result] of Object.entries(results)) {
    console.log(`${pageId}: ${result.status} ${JSON.stringify(result.output)} artifacts=${result.artifacts.map((ref) => ref.uri).join(', ')}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
