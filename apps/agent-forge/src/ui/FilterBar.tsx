import { useEffect, useId, useRef, useState } from 'react';
import { TimeRangePicker, type TimeRange } from './TimeRangePicker';
import './filterBar.css';

/** Debounce applied to the search box before `onChange` fires. */
const SEARCH_DEBOUNCE_MS = 250;

/** One facet: a labelled multi-select over `options`, with `value` the selected option values. */
export interface FacetDef {
  key: string;
  label: string;
  options: { value: string; label: string; count?: number }[];
  value: string[];
  onChange: (next: string[]) => void;
}

/** Props for {@link FilterBar}. Everything is controlled; nothing here touches the URL. */
interface FilterBarProps {
  search?: { value: string; onChange: (next: string) => void; placeholder?: string };
  facets: FacetDef[];
  range?: { value: TimeRange; onChange: (next: TimeRange) => void };
}

function SearchBox({ value, onChange, placeholder }: NonNullable<FilterBarProps['search']>) {
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => setText(value), [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <input
      type="search"
      className="filter-search"
      aria-label={placeholder ?? 'Search'}
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => latest.current(next), SEARCH_DEBOUNCE_MS);
      }}
    />
  );
}

function Facet({ facet }: { facet: FacetDef }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const selected = facet.value.length;
  const toggle = (v: string) =>
    facet.onChange(facet.value.includes(v) ? facet.value.filter((x) => x !== v) : [...facet.value, v]);
  return (
    <div
      className="facet"
      ref={wrap}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="facet-btn"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {facet.label}
        {selected > 0 && <span className="facet-count">{selected}</span>}
      </button>
      {open && (
        <div className="facet-pop" id={id} role="group" aria-label={facet.label}>
          {facet.options.map((o) => (
            <label key={o.value} className="facet-opt">
              <input type="checkbox" checked={facet.value.includes(o.value)} onChange={() => toggle(o.value)} />
              <span>{o.label}</span>
              {o.count != null && <span className="facet-opt-count">{o.count}</span>}
            </label>
          ))}
          <button type="button" className="facet-clear" onClick={() => facet.onChange([])}>
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

/** Search box, facet dropdowns and time range in one wrapping row; fully controlled by its props. */
export function FilterBar({ search, facets, range }: FilterBarProps) {
  return (
    <div className="filter-bar" role="search">
      {search && <SearchBox {...search} />}
      {facets.map((f) => (
        <Facet key={f.key} facet={f} />
      ))}
      {range && <TimeRangePicker value={range.value} onChange={range.onChange} />}
    </div>
  );
}
