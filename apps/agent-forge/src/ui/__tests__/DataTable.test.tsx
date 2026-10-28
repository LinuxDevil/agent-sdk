import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DataTable, type Column, type TableSort } from '../DataTable';
import { render, rerender } from './render';

interface Row {
  id: string;
  name: string;
  tokens: number;
}

const ROWS: Row[] = [
  { id: 'a', name: 'alpha', tokens: 10 },
  { id: 'b', name: 'beta', tokens: 20 },
  { id: 'c', name: 'gamma', tokens: 30 },
];

const COLUMNS: Column<Row>[] = [
  { key: 'name', header: 'Name', sortable: true },
  { key: 'tokens', header: 'Tokens', align: 'right', sortable: true, render: (r) => `${r.tokens} tok` },
  { key: 'id', header: <span>Id</span>, label: 'Identifier', hideBelow: 900, minWidth: 80 },
];

const STORE_KEY = 'forge.table.runs.widths';

/** In-memory Storage: jsdom's localStorage is unavailable under this Node (see HttpAgentStore.test.ts). */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { configurable: true, value: new MemoryStorage() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const click = (el: Element) => act(() => (el as HTMLElement).click());
const key = (el: Element, k: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
const pointer = (target: EventTarget, type: string, clientX: number) =>
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true }));
  });
const headers = (c: HTMLElement) => [...c.querySelectorAll('th')].map((th) => th.textContent?.trim());
const bodyRows = (c: HTMLElement) => [...c.querySelectorAll('tbody tr')] as HTMLTableRowElement[];
const sortButton = (c: HTMLElement, text: string) =>
  [...c.querySelectorAll('th button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
const separator = (c: HTMLElement, label: string) =>
  c.querySelector(`[role="separator"][aria-label="Resize ${label}"]`) as HTMLElement;

function setWidth(w: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

describe('DataTable rendering', () => {
  it('renders a semantic table with headers, default and custom cells, and alignment', () => {
    setWidth(1200);
    const c = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} empty="Nothing" />);
    expect(c.querySelector('table')).not.toBeNull();
    expect(headers(c)).toEqual(['Name', 'Tokens', 'Id']);
    const cells = [...bodyRows(c)[0].querySelectorAll('td')].map((td) => td.textContent);
    expect(cells).toEqual(['alpha', '10 tok', 'a']);
    expect(bodyRows(c)[0].querySelectorAll('td')[1].classList.contains('dt-right')).toBe(true);
  });

  it('marks the selectedKey row with aria-current and the selected class', () => {
    const c = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} selectedKey="b" empty="x" />);
    const selected = c.querySelectorAll('tbody tr[aria-current="true"]');
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain('beta');
    expect(selected[0].classList.contains('dt-row-selected')).toBe(true);
  });

  it('renders `empty` in one full-width cell when there are no rows and not loading', () => {
    setWidth(1200);
    const c = render(<DataTable columns={COLUMNS} rows={[]} rowKey={(r) => r.id} empty={<em>No runs</em>} />);
    const cell = c.querySelector('tbody td') as HTMLTableCellElement;
    expect(cell.textContent).toBe('No runs');
    expect(cell.colSpan).toBe(3);
  });

  it('keeps current rows visible and sets aria-busy while loading', () => {
    const c = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} loading empty="x" />);
    expect(c.querySelector('table')?.getAttribute('aria-busy')).toBe('true');
    expect(bodyRows(c)).toHaveLength(3);
    rerender(<DataTable columns={COLUMNS} rows={[]} rowKey={(r) => r.id} loading empty="Nothing here" />);
    expect(c.textContent).not.toContain('Nothing here');
  });

  it('applies the density class (compact default, comfortable on request)', () => {
    const c = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} empty="x" />);
    expect(c.querySelector('table')?.classList.contains('dt-compact')).toBe(true);
    rerender(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} density="comfortable" empty="x" />);
    expect(c.querySelector('table')?.classList.contains('dt-comfortable')).toBe(true);
  });

  it('fills its container width with no max-width cap', () => {
    const css = readFileSync(resolve(__dirname, '../dataTable.css'), 'utf8');
    const block = (sel: string) => css.match(new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    expect(block('.data-table')).toMatch(/width:\s*100%/);
    expect(block('.data-table-wrap')).toMatch(/width:\s*100%/);
    expect(css).not.toMatch(/max-width/);
    expect(css).toMatch(/\.dt-compact[^{]*\{[^}]*height:\s*32px/);
    expect(css).toMatch(/\.dt-comfortable[^{]*\{[^}]*height:\s*40px/);
    expect(css).toMatch(/font-size:\s*13px/);
  });
});

describe('DataTable sorting', () => {
  it('cycles desc -> asc -> none on one header and starts at desc on another', () => {
    const onSortChange = vi.fn();
    const props = { columns: COLUMNS, rows: ROWS, rowKey: (r: Row) => r.id, onSortChange, empty: 'x' };
    const c = render(<DataTable {...props} />);
    const nameTh = () => sortButton(c, 'Name').closest('th')!;
    expect(nameTh().getAttribute('aria-sort')).toBe('none');
    click(sortButton(c, 'Name'));
    expect(onSortChange).toHaveBeenLastCalledWith({ key: 'name', order: 'desc' });

    const sorted = (sort: TableSort) => rerender(<DataTable {...props} sort={sort} />);
    sorted({ key: 'name', order: 'desc' });
    expect(nameTh().getAttribute('aria-sort')).toBe('descending');
    click(sortButton(c, 'Name'));
    expect(onSortChange).toHaveBeenLastCalledWith({ key: 'name', order: 'asc' });

    sorted({ key: 'name', order: 'asc' });
    expect(nameTh().getAttribute('aria-sort')).toBe('ascending');
    click(sortButton(c, 'Name'));
    expect(onSortChange).toHaveBeenLastCalledWith(undefined);

    click(sortButton(c, 'Tokens'));
    expect(onSortChange).toHaveBeenLastCalledWith({ key: 'tokens', order: 'desc' });
    // never sorts rows itself
    expect(bodyRows(c).map((r) => r.textContent)).toEqual(['alpha10 toka', 'beta20 tokb', 'gamma30 tokc']);
  });

  it('renders non-sortable headers without a button or aria-sort', () => {
    setWidth(1200);
    const c = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} empty="x" />);
    const idTh = c.querySelectorAll('th')[2];
    expect(idTh.querySelector('button')).toBeNull();
    expect(idTh.hasAttribute('aria-sort')).toBe(false);
  });
});

describe('DataTable keyboard and row open', () => {
  it('uses a roving tabindex, j/k and arrows move focus, Enter opens', () => {
    const onRowOpen = vi.fn();
    const c = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} onRowOpen={onRowOpen} empty="x" />);
    const rows = bodyRows(c);
    expect(rows.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    act(() => rows[0].focus());
    key(rows[0], 'j');
    expect(document.activeElement).toBe(rows[1]);
    expect(bodyRows(c).map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    key(rows[1], 'ArrowDown');
    expect(document.activeElement).toBe(rows[2]);
    key(rows[2], 'j'); // clamps at the end
    expect(document.activeElement).toBe(rows[2]);
    key(rows[2], 'k');
    key(rows[1], 'ArrowUp');
    key(rows[0], 'k'); // clamps at the start
    expect(document.activeElement).toBe(rows[0]);
    key(rows[0], 'Enter');
    expect(onRowOpen).toHaveBeenCalledWith(ROWS[0]);
  });

  it('opens a row on click and moves the roving tabindex to it', () => {
    const onRowOpen = vi.fn();
    const c = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} onRowOpen={onRowOpen} empty="x" />);
    click(bodyRows(c)[2].querySelector('td')!);
    expect(onRowOpen).toHaveBeenCalledWith(ROWS[2]);
    expect(bodyRows(c)[2].tabIndex).toBe(0);
  });

  it('ignores keys from editable targets inside a row', () => {
    const onRowOpen = vi.fn();
    const cols: Column<Row>[] = [{ key: 'name', header: 'Name', render: (r) => <input aria-label={`edit ${r.id}`} /> }];
    const c = render(<DataTable columns={cols} rows={ROWS} rowKey={(r) => r.id} onRowOpen={onRowOpen} empty="x" />);
    const input = c.querySelector('input')!;
    act(() => input.focus());
    key(input, 'j');
    key(input, 'Enter');
    expect(document.activeElement).toBe(input);
    expect(onRowOpen).not.toHaveBeenCalled();
  });

  it('rows are not focusable or clickable without onRowOpen', () => {
    const c = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} empty="x" />);
    expect(bodyRows(c).every((r) => !r.hasAttribute('tabindex'))).toBe(true);
    key(bodyRows(c)[0], 'j');
    expect(document.activeElement).toBe(document.body);
  });
});

describe('DataTable column resize', () => {
  it('drags a header separator, clamps to minWidth, and remembers widths per table id', () => {
    setWidth(1200);
    const c = render(<DataTable id="runs" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} empty="x" />);
    const sep = separator(c, 'Name');
    expect(sep.getAttribute('aria-orientation')).toBe('vertical');
    pointer(sep, 'pointerdown', 100);
    pointer(document, 'pointermove', 250);
    expect(sep.getAttribute('aria-valuenow')).toBe('210'); // 60 (min, jsdom has no layout) + 150
    pointer(document, 'pointerup', 250);
    expect(JSON.parse(window.localStorage.getItem(STORE_KEY)!)).toEqual({ name: 210 });
    expect((c.querySelectorAll('col')[0] as HTMLElement).style.width).toBe('210px');

    const idSep = separator(c, 'Identifier'); // non-string header uses `label`
    pointer(idSep, 'pointerdown', 500);
    pointer(document, 'pointermove', 0);
    pointer(document, 'pointerup', 0);
    expect(idSep.getAttribute('aria-valuenow')).toBe('80'); // minWidth

    rerender(<></>);
    const again = render(<DataTable id="runs" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} empty="x" />);
    expect(separator(again, 'Name').getAttribute('aria-valuenow')).toBe('210');
  });

  it('adjusts width by 16 px with ArrowLeft/ArrowRight on the separator', () => {
    const cols: Column<Row>[] = [{ key: 'name', header: 'Name', width: 200 }];
    const c = render(<DataTable id="runs" columns={cols} rows={ROWS} rowKey={(r) => r.id} empty="x" />);
    const sep = separator(c, 'Name');
    expect(sep.getAttribute('aria-valuenow')).toBe('200');
    key(sep, 'ArrowRight');
    expect(sep.getAttribute('aria-valuenow')).toBe('216');
    key(sep, 'ArrowLeft');
    key(sep, 'ArrowLeft');
    expect(sep.getAttribute('aria-valuenow')).toBe('184');
    expect(JSON.parse(window.localStorage.getItem(STORE_KEY)!)).toEqual({ name: 184 });
  });

  it('does not persist without an id and survives corrupt or throwing storage', () => {
    const cols: Column<Row>[] = [{ key: 'name', header: 'Name', width: 200 }];
    const c = render(<DataTable columns={cols} rows={ROWS} rowKey={(r) => r.id} empty="x" />);
    key(separator(c, 'Name'), 'ArrowRight');
    expect(window.localStorage.length).toBe(0);

    window.localStorage.setItem(STORE_KEY, '{not json');
    const c2 = render(<DataTable id="runs" columns={cols} rows={ROWS} rowKey={(r) => r.id} empty="x" />);
    expect(separator(c2, 'Name').getAttribute('aria-valuenow')).toBe('200');

    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const c3 = render(<DataTable id="runs" columns={cols} rows={ROWS} rowKey={(r) => r.id} empty="x" />);
    key(separator(c3, 'Name'), 'ArrowRight');
    expect(separator(c3, 'Name').getAttribute('aria-valuenow')).toBe('216');
  });
});

describe('DataTable resize fixes', () => {
  it('starts keyboard resize from the measured header width of a width-less column', () => {
    vi.spyOn(HTMLTableCellElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300 } as DOMRect);
    const cols: Column<Row>[] = [{ key: 'name', header: 'Name' }];
    const c = render(<DataTable id="runs" columns={cols} rows={ROWS} rowKey={(r) => r.id} empty="x" />);
    const sep = separator(c, 'Name');
    expect(sep.getAttribute('aria-valuenow')).toBe('300');
    key(sep, 'ArrowRight');
    expect(sep.getAttribute('aria-valuenow')).toBe('316');
    expect(JSON.parse(window.localStorage.getItem(STORE_KEY)!)).toEqual({ name: 316 });
  });

  it('ends a drag on pointercancel and persists what was dragged', () => {
    const cols: Column<Row>[] = [{ key: 'name', header: 'Name', width: 100 }];
    const c = render(<DataTable id="runs" columns={cols} rows={ROWS} rowKey={(r) => r.id} empty="x" />);
    const sep = separator(c, 'Name');
    pointer(sep, 'pointerdown', 0);
    pointer(document, 'pointermove', 40);
    pointer(document, 'pointercancel', 40);
    expect(JSON.parse(window.localStorage.getItem(STORE_KEY)!)).toEqual({ name: 140 });
    pointer(document, 'pointermove', 200);
    expect(sep.getAttribute('aria-valuenow')).toBe('140');
  });

  it('removes the document drag listeners when unmounted mid-drag', () => {
    const cols: Column<Row>[] = [{ key: 'name', header: 'Name', width: 100 }];
    const c = render(<DataTable columns={cols} rows={ROWS} rowKey={(r) => r.id} empty="x" />);
    pointer(separator(c, 'Name'), 'pointerdown', 0);
    const remove = vi.spyOn(document, 'removeEventListener');
    rerender(<></>);
    const removed = remove.mock.calls.map((call) => call[0]);
    expect(removed).toEqual(expect.arrayContaining(['pointermove', 'pointerup', 'pointercancel']));
  });
});

describe('DataTable roving reset', () => {
  it('falls back to the first row when the active row leaves `rows`, keeps it when it stays', () => {
    const onRowOpen = vi.fn();
    const ui = (rows: Row[]) => <DataTable columns={COLUMNS} rows={rows} rowKey={(r) => r.id} onRowOpen={onRowOpen} empty="x" />;
    const c = render(ui(ROWS));
    click(bodyRows(c)[2].querySelector('td')!);
    expect(bodyRows(c).map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
    rerender(ui(ROWS.map((r) => ({ ...r })))); // same keys, new identity (refetch)
    expect(bodyRows(c).map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
    rerender(ui([{ id: 'd', name: 'delta', tokens: 1 }, { id: 'e', name: 'eps', tokens: 2 }, { id: 'f', name: 'phi', tokens: 3 }]));
    expect(bodyRows(c).map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });
});

describe('DataTable responsive columns', () => {
  it('drops hideBelow columns when the container is narrower than the threshold', () => {
    setWidth(1200);
    const c = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} empty="x" />);
    expect(headers(c)).toEqual(['Name', 'Tokens', 'Id']);
    setWidth(600);
    expect(headers(c)).toEqual(['Name', 'Tokens']);
    expect(bodyRows(c)[0].querySelectorAll('td')).toHaveLength(2);
    setWidth(1000);
    expect(headers(c)).toEqual(['Name', 'Tokens', 'Id']);
  });

  it('measures the wrapper with ResizeObserver when available', () => {
    let fire: ((width: number) => void) | undefined;
    const disconnect = vi.fn();
    class FakeRO {
      constructor(cb: ResizeObserverCallback) {
        fire = (width) => cb([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      observe() {}
      disconnect = disconnect;
    }
    vi.stubGlobal('ResizeObserver', FakeRO);
    try {
      setWidth(1200);
      const c = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} empty="x" />);
      act(() => fire!(500));
      expect(headers(c)).toEqual(['Name', 'Tokens']);
      act(() => fire!(950));
      expect(headers(c)).toEqual(['Name', 'Tokens', 'Id']);
      rerender(<></>);
      expect(disconnect).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('DataTable paging', () => {
  it('renders the range footer and pages with Previous/Next, disabled at the ends', () => {
    const onChange = vi.fn();
    const page = (offset: number) => ({ offset, limit: 50, total: 1234, onChange });
    const c = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} page={page(0)} empty="x" />);
    const btn = (name: string) =>
      [...c.querySelectorAll('button')].find((b) => b.textContent === name) as HTMLButtonElement;
    expect(c.querySelector('.dt-pager-range')?.textContent).toBe('1–50 of 1,234');
    expect(btn('Previous').disabled).toBe(true);
    click(btn('Next'));
    expect(onChange).toHaveBeenLastCalledWith(50);

    rerender(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} page={page(1200)} empty="x" />);
    expect(c.querySelector('.dt-pager-range')?.textContent).toBe('1,201–1,234 of 1,234');
    expect(btn('Next').disabled).toBe(true);
    click(btn('Previous'));
    expect(onChange).toHaveBeenLastCalledWith(1150);

    rerender(
      <DataTable columns={COLUMNS} rows={[]} rowKey={(r) => r.id} page={{ offset: 0, limit: 50, total: 0, onChange }} empty="x" />,
    );
    expect(c.querySelector('.dt-pager-range')?.textContent).toBe('0 of 0');

    // total shrank below the offset: the range start is clamped
    rerender(<DataTable columns={COLUMNS} rows={[]} rowKey={(r) => r.id} page={page(1250)} empty="x" />);
    expect(c.querySelector('.dt-pager-range')?.textContent).toBe('1,234–1,234 of 1,234');
    expect(btn('Previous').disabled).toBe(false);
  });
});
