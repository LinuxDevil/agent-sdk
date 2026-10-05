import type { ApproveToolCall } from '../../../createAgentApprovals';

// Approves everything except writes to paths ending in '.test.js'.
const approve: ApproveToolCall = ({ args }) => !String(args.path ?? '').endsWith('.test.js');

export default approve;
