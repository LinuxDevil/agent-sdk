// Scratch: drive ops-pipeline end to end and inspect whether a mock PR was created.
import { startOpsPipeline } from '../../../../examples/ops-pipeline/index';
import { createMockGithubTool } from '../../../../examples/ops-pipeline/mocks/mockGithubTool';
import { createMockSlackTool } from '../../../../examples/ops-pipeline/mocks/mockSlackTool';
import { sendSyntheticError, exampleErrorSignal } from '../../../../examples/ops-pipeline/mocks/mockGrafanaSender';
const gh = createMockGithubTool(); const sl = createMockSlackTool();
const h = await startOpsPipeline({ githubCreatePrTool: gh.tool, slackTool: sl.tool });
const r = await sendSyntheticError(`http://127.0.0.1:${h.monitor.port}/webhook`, exampleErrorSignal());
console.log('trigger', r.status);
for (let i = 0; i < 50 && sl.posts.length === 0; i++) await new Promise(r => setTimeout(r, 100));
const aid = sl.posts[0]?.approvalId;
const res = await fetch(`http://127.0.0.1:${h.slack.port}/slack/interactions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'block_actions', actions: [{ action_id: 'fix_it', value: aid }] }) });
console.log('interaction', res.status, await res.text());
console.log('PRs created:', JSON.stringify(gh.createdPullRequests.map(p => ({ title: p.title, head: p.head }))));
console.log('slack posts:', sl.posts.length);
await h.close();
