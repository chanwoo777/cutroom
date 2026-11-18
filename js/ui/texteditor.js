// Inline text editing on the program monitor. A transparent <textarea> is laid exactly over the text as
// the canvas draws it (same font string, line-box height, padding, rotation and scale; the renderer uses
// CSS-matched baselines), so you type straight onto the styled text: the canvas keeps rendering the real
// fill, outline, box and shadow underneath while the textarea supplies the caret and selection.
// Enter adds a line, Ctrl/⌘+Enter or clicking away commits (one undo step), Esc cancels.
import { toast } from './dom.js';

export class InlineTextEditor {
  constructor({ store, renderer, monitor, playback }) {
    this.store = store;
    this.renderer = renderer;
    this.monitor = monitor;
    this.playback = playback;
    this.frameEl = document.getElementById('frame');
    this.ta = null;
    this.clipId = null;
    this.original = '';
    store.on('edit-text', (p) => this.open(typeof p === 'string' ? p : p?.id, typeof p === 'object' ? p : {}));
    store.on('exporting', (on) => { if (on) this.close(true); });
    store.on('project', (e) => { if (this.ta && (e?.undo || e?.redo || e?.replaced) ) this.close(false); });
  }

  get active() { return !!this.ta; }

  open(id, { selectAll = false } = {}) {
    const { store } = this;
    const c = store.getClip(id);
    if (!c || c.kind !== 'text' || store.exporting) return false;
    const tr = store.getTrack(c.trackId);
    if (tr?.locked) { toast(`Track ${tr.name} is locked.`); return false; }
    if (this.ta) this.close(true);
    if (store.playing) this.playback.pause();
    // The text must be on screen: park the playhead inside the clip if it is elsewhere.
    if (store.time < c.start || store.time >= c.start + c.duration) this.playback.seek(c.start + Math.min(0.5, c.duration / 2));
    if (tr?.hidden) toast(`Track ${tr.name} is hidden, so the text is not drawn while you type.`);
    store.select([id]);
    this.clipId = id;
    this.original = c.text.content;
    this.renderer.editingId = id; // draw without entrance/exit animation so the caret lines up
    const ta = document.createElement('textarea');
    ta.className = 'inline-text';
    ta.spellcheck = true;
    ta.setAttribute('aria-label', 'Edit text. Ctrl+Enter to finish, Escape to cancel.');
    ta.value = c.text.content;
    ta.addEventListener('input', () => {
      const clip = store.getClip(this.clipId);
      if (!clip) return;
      clip.text.content = ta.value.slice(0, 2000);
      store.touch();
      this.position();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(false, true); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.close(true, true); }
      else if (e.key === 'Tab') { e.preventDefault(); this.close(true, true); }
    });
    ta.addEventListener('blur', () => this.close(true));
    // Clicking anywhere else commits, even where focus does not move (e.g. the canvas).
    this.outside = (e) => { if (e.target !== ta) this.close(true); };
    document.addEventListener('pointerdown', this.outside, true);
    this.ta = ta;
    this.frameEl.append(ta);
    this.position();
    ta.focus({ preventScroll: true });
    if (selectAll) ta.select();
    else ta.setSelectionRange(ta.value.length, ta.value.length);
    this.monitor.dirty = true;
    return true;
  }

  /** Keep the textarea glued to the canvas text (layout, zoom of the monitor, rotation, scale). */
  position() {
    const ta = this.ta;
    if (!ta) return;
    const c = this.store.getClip(this.clipId);
    if (!c) { this.close(false); return; }
    const { renderer } = this;
    const L = renderer.layout(c, renderer.canvas.width, renderer.canvas.height);
    const m = L.metrics;
    const k = this.monitor.k;
    const s = c.transform.scale ?? 1;
    const st = ta.style;
    st.font = m.font;
    st.lineHeight = `${m.lineH}px`;
    st.padding = `${m.padY}px ${m.padX}px`;
    st.width = `${Math.ceil(m.w) + 2}px`;
    st.height = `${Math.ceil(m.h) + 1}px`;
    st.textAlign = c.text.align || 'center';
    st.caretColor = c.text.color || '#ffffff';
    st.left = `${L.cx * k - (Math.ceil(m.w) + 2) / 2}px`;
    st.top = `${L.cy * k - (Math.ceil(m.h) + 1) / 2}px`;
    st.transform = `rotate(${L.rot}rad) scale(${k * s})`;
  }

  frame() { if (this.ta) this.position(); }

  close(commit, refocus = false) {
    const ta = this.ta;
    if (!ta) return;
    this.ta = null;
    this.renderer.editingId = null;
    document.removeEventListener('pointerdown', this.outside, true);
    const { store } = this;
    const c = store.getClip(this.clipId);
    ta.remove();
    if (c) {
      if (!commit) {
        c.text.content = this.original;
        store.touch();
      } else if (!String(c.text.content).trim()) {
        c.text.content = this.original;
        store.touch();
        toast('Text cannot be empty, so the previous words were kept. Delete the clip to remove it.');
      } else if (c.text.content !== this.original) {
        store.commit('Edit text');
      } else {
        store.touch();
      }
    }
    this.clipId = null;
    this.monitor.dirty = true;
    if (refocus) this.monitor.overlay.focus({ preventScroll: true }); // keyboard exits return to the canvas
  }
}
