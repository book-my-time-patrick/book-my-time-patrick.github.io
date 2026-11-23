// Visual preferences for the invitation page: skin (compact / apple) and colour scheme.
// Stored only in this browser. Storage may be unavailable, so every access is guarded.

export type Skin = 'compact' | 'apple';
export type Scheme = 'auto' | 'light' | 'dark';
export interface Look { skin: Skin; scheme: Scheme }

const skinKey = 'booking-skin';
const schemeKey = 'booking-scheme';
const darkQuery = '(prefers-color-scheme: dark)';

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* The preference simply is not remembered. */ }
}

function load(): Look {
  const skin = read(skinKey), scheme = read(schemeKey);
  return {
    skin: skin === 'apple' || skin === 'compact' ? skin : 'compact',
    scheme: scheme === 'light' || scheme === 'dark' ? scheme : 'auto',
  };
}

let current: Look | undefined;
const pages = new Set<HTMLElement>();

export function getLook(): Look {
  current ??= load();
  return { ...current };
}

export function effectiveScheme(scheme: Scheme = getLook().scheme): 'light' | 'dark' {
  return scheme === 'auto' ? (window.matchMedia(darkQuery).matches ? 'dark' : 'light') : scheme;
}

function paint(page: HTMLElement) {
  const look = getLook();
  page.dataset.skin = look.skin;
  page.dataset.scheme = effectiveScheme(look.scheme);
}

/** Change the look, remember it, and repaint every registered page. */
export function setLook(change: Partial<Look>) {
  current = { ...getLook(), ...change };
  write(skinKey, current.skin);
  write(schemeKey, current.scheme);
  pages.forEach(paint);
}

/** Start applying the look to an invitation page element. Returns a disposer. */
export function registerLookTarget(page: HTMLElement): () => void {
  pages.add(page);
  paint(page);
  const query = window.matchMedia(darkQuery);
  const follow = () => { if (getLook().scheme === 'auto') paint(page); };
  query.addEventListener('change', follow);
  return () => { pages.delete(page); query.removeEventListener('change', follow); };
}
