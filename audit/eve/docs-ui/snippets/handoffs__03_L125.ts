// handoffs.md:125
import { handoffFilters, type HandoffInputData } from '@lousho/build-ai-agent';

// The last four messages, without tool traffic.
const recent = (data: HandoffInputData) => handoffFilters.removeToolCalls(data).slice(-4);
export {};
