import type { ApproveToolCall } from '@lousho/build-ai-agent';

/**
 * The kit's approver (pointed at by `agent.json`'s `approve`): the agent asks
 * before every `write_file` / `edit_file`; the approver allows them all except
 * test files, so the model can fix the code but never the tests that judge it.
 */
const approve: ApproveToolCall = ({ args }) => !String(args.path ?? '').endsWith('.test.js');

export default approve;
