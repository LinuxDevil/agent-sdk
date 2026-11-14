import type { ApplyOpsBody, HarnessView, MainHarnessView, PageDetail, WorkspaceDetail } from '@linuxdevil/lousho/workspaces/client';

export type AuthoringOp = ApplyOpsBody['ops'][number];
export type WorkspaceManifest = WorkspaceDetail['manifest'];
// fallow-ignore-next-line unused-type -- contract surface: the page tabs (P2.9+) type page.json through it.
export type PageManifest = PageDetail['manifest'];
export type MainHarness = NonNullable<MainHarnessView['harness']>;
// fallow-ignore-next-line unused-type -- contract surface: the harness viewers (P2.10+) type harness layers through it.
export type Harness = HarnessView['layers'][number]['harness'];
