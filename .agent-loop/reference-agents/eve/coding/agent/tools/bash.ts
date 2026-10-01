// The default bash/read_file/write_file tools already run in the sandbox
// (docs/concepts/built-in-tools.md). Only the approval policy is overridden.
import { defineTool } from "eve/tools";
import { bash } from "eve/tools/bash";

const DESTRUCTIVE = /\b(rm|mv|chmod|chown|git\s+(push|reset|clean|checkout))\b|>/;

export default defineTool({
  ...bash,
  approval: ({ toolInput }) =>
    DESTRUCTIVE.test(toolInput?.command ?? "") ? "user-approval" : "not-applicable",
});
