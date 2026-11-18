import { Emitter } from './emitter.js';
import { clamp } from '../util.js';

export const ASPECTS = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
  '4:5': [1080, 1350],
};
export const FPS_OPTIONS = [24, 25, 30, 50, 60];

const track = (id, kind, name, role) => ({ id, kind, name, role, hidden: false, locked: false, muted: false });

export function defaultProject() {
  return {
    version: 1,
    title: 'Untitled cut',
    aspect: '16:9',
    fps: 30,
    background: { mode: 'black', color: '#1c1b19' },
    tracks: [
      track('v2', 'video', 'V2', 'Overlay'),
      track('v1', 'video', 'V1', 'Main'),
      track('a1', 'audio', 'A1', 'Dialogue'),
      track('a2', 'audio', 'A2', 'Music'),
    ],
    clips: [],
  };
}

export const clone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

/** Snapshot history: every committed mutation stores a deep clone of the serializable project. */
class History {
  constructor(initial, limit = 200) {
    this.limit = limit;
    this.reset(initial);
  }
  reset(state) {
    this.stack = [{ state: clone(state), label: 'Open' }];
    this.index = 0;
  }
  push(state, label) {
    this.stack.splice(this.index + 1);
    this.stack.push({ state: clone(state), label });
    if (this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
  }
  current() { return clone(this.stack[this.index].state); }
  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.stack.length - 1; }
  get undoLabel() { return this.canUndo ? this.stack[this.index].label : ''; }
  get redoLabel() { return this.canRedo ? this.stack[this.index + 1].label : ''; }
  undo() {
    if (!this.canUndo) return null;
    const label = this.stack[this.index].label;
    this.index--;
    return { state: this.current(), label };
  }
  redo() {
    if (!this.canRedo) return null;
    this.index++;
    return { state: this.current(), label: this.stack[this.index].label };
  }
  /** Remove clips from every snapshot (used when an asset is deleted and its blob URL revoked). */
  scrub(keepClip) {
    for (const entry of this.stack) entry.state.clips = entry.state.clips.filter(keepClip);
  }
}

export class Store extends Emitter {
  constructor() {
    super();
    this.project = defaultProject();
    this.history = new History(this.project);
    this.selection = new Set();
    this.time = 0;
    this.playing = false;
    this.exporting = false;
    this.tool = 'select';
    this.snap = true;
    this.zoom = 80; // px per second
    this.ui = { guides: false, previewScale: 'auto', loop: false, snapGuides: true };
  }

  get dims() { return ASPECTS[this.project.aspect] || ASPECTS['16:9']; }
  get fps() { return this.project.fps; }
  get duration() {
    let d = 0;
    for (const c of this.project.clips) d = Math.max(d, c.start + c.duration);
    return d;
  }
  getClip(id) { return this.project.clips.find((c) => c.id === id) || null; }
  getTrack(id) { return this.project.tracks.find((t) => t.id === id) || null; }
  selectedClips() { return this.project.clips.filter((c) => this.selection.has(c.id)); }

  /** Record the current project as one undoable step. */
  commit(label = 'Edit') {
    this.history.push(this.project, label);
    this.emit('project', { label });
    this.emit('history');
  }
  /** Live (uncommitted) change, e.g. during a drag. */
  touch() { this.emit('project', { live: true }); }
  /** Throw away uncommitted changes. */
  revert() {
    this.project = this.history.current();
    this.pruneSelection();
    this.emit('project', { revert: true });
  }
  undo() {
    const r = this.history.undo();
    if (!r) return null;
    this.project = r.state;
    this.pruneSelection();
    this.emit('project', { undo: true });
    this.emit('history');
    return r.label;
  }
  redo() {
    const r = this.history.redo();
    if (!r) return null;
    this.project = r.state;
    this.pruneSelection();
    this.emit('project', { redo: true });
    this.emit('history');
    return r.label;
  }
  replaceProject(p) {
    this.project = p;
    this.history.reset(p);
    this.selection.clear();
    this.time = 0;
    this.emit('project', { replaced: true });
    this.emit('history');
    this.emit('selection');
    this.emit('time', 0);
  }
  pruneSelection() {
    const ids = new Set(this.project.clips.map((c) => c.id));
    let changed = false;
    for (const id of [...this.selection]) if (!ids.has(id)) { this.selection.delete(id); changed = true; }
    if (changed) this.emit('selection');
  }
  setTime(t) {
    const v = Math.max(0, t);
    if (v === this.time) return;
    this.time = v;
    this.emit('time', v);
  }
  select(ids, mode = 'replace') {
    if (mode === 'replace') this.selection = new Set(ids);
    else if (mode === 'add') ids.forEach((id) => this.selection.add(id));
    else if (mode === 'toggle') ids.forEach((id) => (this.selection.has(id) ? this.selection.delete(id) : this.selection.add(id)));
    this.emit('selection');
  }
  clearSelection() {
    if (!this.selection.size) return;
    this.selection.clear();
    this.emit('selection');
  }
  setTool(tool) { this.tool = tool; this.emit('tool', tool); }
  setSnap(v) { this.snap = v; this.emit('snap', v); }
  setZoom(z) { this.zoom = clamp(z, 1.5, 1800); this.emit('zoom', this.zoom); }
}
