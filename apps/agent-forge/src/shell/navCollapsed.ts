import { useCallback, useState } from 'react';

/** localStorage key for the docked nav's icon-rail state: "1" collapsed, "0" expanded. */
const NAV_COLLAPSED_KEY = 'forge.nav.collapsed';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(NAV_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Whether the docked nav is the 56px icon rail, remembered across reloads (storage failures just forget). */
export function useNavCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = useCallback(() => {
    setCollapsed((was) => {
      const next = !was;
      try {
        window.localStorage.setItem(NAV_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        // Private mode / blocked storage: the toggle still works for this page.
      }
      return next;
    });
  }, []);
  return [collapsed, toggle];
}
