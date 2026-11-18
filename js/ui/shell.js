// Workspace chrome: the left icon rail and its collapsible drawer, the header's canvas-zoom selector and
// the sequence-format badge with its popover (aspect ratio and frame rate).
import { FPS_OPTIONS } from '../core/store.js';
import { announce } from './dom.js';

const $ = (id) => document.getElementById(id);
const KEY = 'cutroom.drawer';

function readPref() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } }
function savePref(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* storage blocked */ } }

export function installShell({ store, actions, monitor }) {
  const workspace = $('workspace');
  const tabs = [...document.querySelectorAll('#rail [role="tab"]')];
  const title = $('drawer-title');
  const closeBtn = $('drawer-close');
  const pref = readPref() || { tab: 'tab-media', open: true };

  const setOpen = (open) => {
    workspace.classList.toggle('drawer-closed', !open);
    closeBtn.setAttribute('aria-expanded', String(open));
    tabs.forEach((t) => t.setAttribute('aria-expanded', String(open && t.getAttribute('aria-selected') === 'true')));
    pref.open = open;
    savePref(pref);
    // The viewport changes size with the drawer; refit once the column transition has settled.
    setTimeout(() => monitor.layout(), 240);
  };
  const select = (tab, { focus = false, toggle = false } = {}) => {
    const wasActive = tab.getAttribute('aria-selected') === 'true';
    if (toggle && wasActive) { setOpen(workspace.classList.contains('drawer-closed')); return; }
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !on;
    }
    title.textContent = tab.querySelector('span')?.textContent || '';
    pref.tab = tab.id;
    if (workspace.classList.contains('drawer-closed')) setOpen(true);
    else savePref(pref);
    if (focus) tab.focus();
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t, { toggle: true }));
    t.addEventListener('keydown', (e) => {
      const next = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      if (next) {
        e.preventDefault();
        select(tabs[(i + next + tabs.length) % tabs.length], { focus: true });
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        select(tabs[e.key === 'Home' ? 0 : tabs.length - 1], { focus: true });
      }
    });
  });
  closeBtn.addEventListener('click', () => { setOpen(false); tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.focus(); });
  select($(pref.tab) || tabs[0]);
  if (!pref.open) setOpen(false);

  /** Open a drawer panel from elsewhere (e.g. "Add transition" in the inspector). */
  const openPanel = (tabId) => { const t = $(tabId); if (t) select(t); };

  // ---------- canvas zoom ----------
  const zoomSel = $('canvas-zoom');
  zoomSel.value = String(store.ui.zoom ?? 'fit');
  zoomSel.addEventListener('change', () => {
    store.ui.zoom = zoomSel.value === 'fit' ? 'fit' : Number(zoomSel.value);
    monitor.layout();
    announce(`Canvas zoom ${zoomSel.selectedOptions[0].textContent}`);
  });

  // ---------- sequence format badge ----------
  const res = $('format-res');
  const fpsLabel = $('format-fps');
  const note = $('format-note');
  const fpsBtns = [...document.querySelectorAll('#fps-group [data-fps]')];
  fpsBtns.forEach((b) => b.addEventListener('click', () => actions.setFps(Number(b.dataset.fps))));
  const sync = () => {
    const [W, H] = store.dims;
    const fps = store.project.fps;
    const short = Math.min(W, H);
    res.textContent = short >= 2160 ? '4K' : `${short}p`;
    fpsLabel.textContent = `${fps}fps`;
    fpsBtns.forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.fps) === fps)));
    note.textContent = `${W}×${H} · ${fps} fps · ${store.project.aspect}`;
    $('format-badge').setAttribute('aria-label', `Sequence format ${W} by ${H}, ${fps} frames per second`);
  };
  store.on('project', sync);
  sync();
  if (!FPS_OPTIONS.every((f) => fpsBtns.some((b) => Number(b.dataset.fps) === f))) console.warn('fps-group buttons out of sync with FPS_OPTIONS');

  return { openPanel };
}
