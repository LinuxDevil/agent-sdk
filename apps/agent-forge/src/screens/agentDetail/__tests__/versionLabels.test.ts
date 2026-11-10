import { describe, expect, it } from 'vitest';

import { SPEC_FIELD_ORDER } from '../../../../shared/specFields';
import type { SpecChange, VersionListItem } from '../../../../shared/wireTypes';
import {
  FIELD_LABELS,
  fieldLabel,
  groupChanges,
  kindLabel,
  SECTION_ORDER,
  sectionOf,
  SOURCE_LABELS,
  summaryPending,
  type DiffSection,
} from '../versionLabels';

function item(over: Partial<VersionListItem> = {}): VersionListItem {
  return {
    version: 1,
    kind: 'update',
    source: 'editor',
    changedFields: [],
    restoredFromVersion: null,
    summary: null,
    requestText: null,
    authorSessionId: null,
    specHash: 'abc',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe('FIELD_LABELS', () => {
  it('labels every spec field the version records can report', () => {
    for (const field of SPEC_FIELD_ORDER) {
      expect(FIELD_LABELS[field], field).toBeTruthy();
    }
  });

  it('fieldLabel falls back to the raw key for unmapped fields', () => {
    expect(fieldLabel('tools')).toBe('Tools');
    expect(fieldLabel('someFutureField')).toBe('someFutureField');
  });
});

describe('kindLabel', () => {
  it('names the source version for restores', () => {
    expect(kindLabel(item({ kind: 'restore', restoredFromVersion: 3 }))).toBe('Restored from v3');
  });

  it('uses the kind label otherwise', () => {
    expect(kindLabel(item({ kind: 'create' }))).toBe('Created');
    expect(kindLabel(item({ kind: 'publish' }))).toBe('Published');
    expect(kindLabel(item({ kind: 'restore', restoredFromVersion: null }))).toBe('Restored');
  });
});

describe('SOURCE_LABELS', () => {
  it('has a label for every VersionSource', () => {
    for (const source of Object.keys(SOURCE_LABELS)) {
      expect(SOURCE_LABELS[source as keyof typeof SOURCE_LABELS]).toBeTruthy();
    }
    expect(SOURCE_LABELS.author).toBe('via Author');
    expect(SOURCE_LABELS.external_file_edit).toBe('file edited outside Studio');
  });
});

function change(over: Partial<SpecChange> = {}): SpecChange {
  return { field: 'model', label: 'Model', section: 'Model', op: 'edit', ...over };
}

describe('sectionOf', () => {
  it('groups a keyed-list item under its top-level field', () => {
    expect(sectionOf('tools[web_fetch]')).toBe('Tools');
    expect(sectionOf('mcpServers.github')).toBe('Tools');
    expect(sectionOf('guardrails[gr-1]')).toBe('Safety');
  });

  it('maps one plain field per section', () => {
    const pairs: Array<[string, DiffSection]> = [
      ['name', 'Identity'],
      ['labels', 'Identity'],
      ['model', 'Model'],
      ['instructions', 'Instructions'],
      ['tools', 'Tools'],
      ['skills', 'Knowledge'],
      ['guardrails', 'Safety'],
      ['triggers', 'Triggers'],
      ['flow', 'Flow'],
    ];
    for (const [field, section] of pairs) {
      expect(sectionOf(field), field).toBe(section);
    }
  });

  it('puts unknown fields under Other', () => {
    expect(sectionOf('someFutureField')).toBe('Other');
    expect(sectionOf('someFutureField.nested')).toBe('Other');
    expect(sectionOf('someFutureField[item]')).toBe('Other');
  });
});

describe('groupChanges', () => {
  it('orders sections by SECTION_ORDER and drops empty ones', () => {
    const groups = groupChanges([
      change({ field: 'tools[web_fetch]', label: 'Tool: web_fetch' }),
      change({ field: 'name', label: 'Name', section: 'Identity' }),
      change({ field: 'someFutureField', label: 'Future' }),
      change({ field: 'model' }),
      change({ field: 'tools[calculator]', label: 'Tool: calculator' }),
    ]);
    expect(groups.map((g) => g.section)).toEqual(['Identity', 'Model', 'Tools', 'Other']);
    expect(groups.find((g) => g.section === 'Tools')?.changes.map((c) => c.field)).toEqual([
      'tools[web_fetch]',
      'tools[calculator]',
    ]);
  });

  it('keeps a section per field across the whole order', () => {
    const fields: Array<[string, DiffSection]> = [
      ['name', 'Identity'],
      ['model', 'Model'],
      ['instructions', 'Instructions'],
      ['tools', 'Tools'],
      ['skills', 'Knowledge'],
      ['guardrails', 'Safety'],
      ['triggers', 'Triggers'],
      ['flow', 'Flow'],
      ['someFutureField', 'Other'],
    ];
    const groups = groupChanges(fields.map(([field]) => change({ field })));
    expect(groups.map((g) => g.section)).toEqual([...SECTION_ORDER]);
  });

  it('returns an empty list for no changes', () => {
    expect(groupChanges([])).toEqual([]);
  });
});

describe('summaryPending', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();

  it('is true for a fresh summary-less update at 119s', () => {
    expect(summaryPending(item({ createdAt: at(119_000) }), now)).toBe(true);
  });

  it('is false at 121s', () => {
    expect(summaryPending(item({ createdAt: at(121_000) }), now)).toBe(false);
  });

  it('counts a future createdAt as now', () => {
    expect(summaryPending(item({ createdAt: new Date(now + 60_000).toISOString() }), now)).toBe(true);
  });

  it('is false once a summary arrived', () => {
    expect(summaryPending(item({ summary: 'Added tools.', createdAt: at(1_000) }), now)).toBe(false);
  });

  it('is false for kinds the summary pass does not write', () => {
    expect(summaryPending(item({ kind: 'restore', createdAt: at(1_000) }), now)).toBe(false);
    expect(summaryPending(item({ kind: 'baseline', createdAt: at(1_000) }), now)).toBe(false);
  });

  it('is true for fresh create and publish versions', () => {
    expect(summaryPending(item({ kind: 'create', createdAt: at(1_000) }), now)).toBe(true);
    expect(summaryPending(item({ kind: 'publish', createdAt: at(1_000) }), now)).toBe(true);
  });
});
