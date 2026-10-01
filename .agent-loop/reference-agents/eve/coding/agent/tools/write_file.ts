import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { writeFile } from "eve/tools/write_file";

export default defineTool({ ...writeFile, approval: always() });
