import type { ReactNode } from 'react';
import type { WorkspaceSection } from './workspacesUrl';
import { OverviewSection } from './OverviewSection';
import { PagesSection } from './PagesSection';

export interface SectionEntry {
  id: WorkspaceSection;
  label: string;
  ticket?: string;
}

export const WORKSPACE_SECTIONS: readonly SectionEntry[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'main-agent', label: 'Main agent', ticket: 'P2.7' },
  { id: 'pages', label: 'Pages' },
  { id: 'agents', label: 'Agents', ticket: 'P2.8' },
  { id: 'runs', label: 'Runs', ticket: 'P3.14' },
  { id: 'improve', label: 'Improve', ticket: 'P5.36' },
  { id: 'revisions', label: 'Revisions', ticket: 'P5.38' },
];

export const SECTION_SCREENS: Partial<Record<WorkspaceSection, () => ReactNode>> = {
  overview: OverviewSection,
  pages: PagesSection,
};

export function isWorkspaceSection(value: string): value is WorkspaceSection {
  return WORKSPACE_SECTIONS.some((section) => section.id === value);
}
