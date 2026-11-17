// Editing commands shared by the timeline, inspector, library and keyboard shortcuts.
import { quantize, formatTC } from '../util.js';
import {
  splitClip, rippleDelete, deleteClips, duplicateClips, makeClip, overwriteRange, findFreeTrack,
  addTrack, trackKindFor, editPoints, clipEnd,
} from '../core/ops.js';
import { toast, announce } from './dom.js';

export function createActions({ store, assets, playback, glfx }) {
  const fps = () => store.project.fps;
  const snipListeners = new Set();
  const snip = (trackId, t) => snipListeners.forEach((fn) => fn(trackId, t));
  const lockedIds = () => new Set(store.project.tracks.filter((t) => t.locked).map((t) => t.id));

  const A = {
    onSnip(fn) { snipListeners.add(fn); },

    togglePlay() { playback.toggle(); },
    seek(t) { playback.seek(quantize(Math.max(0, t), fps())); },
    step(frames) {
      if (store.playing) playback.pause();
      playback.seek(quantize(Math.max(0, store.time + frames / fps()), fps()));
    },
    jumpEdit(dir) {
      const pts = editPoints(store.project);
      const t = store.time;
      const next = dir > 0 ? pts.find((p) => p > t + 1e-4) : [...pts].reverse().find((p) => p < t - 1e-4);
      if (next == null) return;
      if (store.playing) playback.pause();
      playback.seek(next);
    },

    splitAtPlayhead() {
      const project = store.project;
      const t = quantize(store.time, fps());
      const locked = lockedIds();
      const under = (c) => c.start < t - 1e-6 && clipEnd(c) > t + 1e-6 && !locked.has(c.trackId);
      let targets = store.selectedClips().filter(under);
      if (!targets.length) targets = project.clips.filter(under);
      if (!targets.length) { toast('Nothing under the playhead to split.'); return; }
      let n = 0;
      for (const c of targets) if (splitClip(project, c, t, fps())) { n++; snip(c.trackId, t); }
      if (n) { store.commit(n > 1 ? `Split ${n} clips` : 'Split'); announce(`Split at ${formatTC(t, fps())}`); }
    },

    splitClipAt(clipId, t) {
      const c = store.getClip(clipId);
      if (!c) return;
      const q = quantize(t, fps());
      if (splitClip(store.project, c, q, fps())) {
        snip(c.trackId, q);
        store.commit('Split');
        announce(`Split at ${formatTC(q, fps())}`);
      }
    },

    deleteSelected(ripple = false) {
      const locked = lockedIds();
      const ids = new Set(store.selectedClips().filter((c) => !locked.has(c.trackId)).map((c) => c.id));
      if (!ids.size) return;
      if (ripple) rippleDelete(store.project, ids); else deleteClips(store.project, ids);
      store.selection.clear();
      store.emit('selection');
      store.commit(ripple ? 'Ripple delete' : 'Delete');
      announce(`${ripple ? 'Ripple deleted' : 'Deleted'} ${ids.size} clip${ids.size > 1 ? 's' : ''}`);
    },

    duplicateSelected() {
      const locked = lockedIds();
      const ids = new Set(store.selectedClips().filter((c) => !locked.has(c.trackId)).map((c) => c.id));
      if (!ids.size) return;
      const created = duplicateClips(store.project, ids, fps());
      store.select(created);
      store.commit('Duplicate');
    },

    selectAll() {
      const locked = lockedIds();
      store.select(store.project.clips.filter((c) => !locked.has(c.trackId)).map((c) => c.id));
    },

    nudgeSelection(frames) {
      const locked = lockedIds();
      const sel = store.selectedClips().filter((c) => !locked.has(c.trackId));
      if (!sel.length) return;
      const d = frames / fps();
      const minStart = Math.min(...sel.map((c) => c.start));
      const delta = Math.max(-minStart, d);
      if (!delta) return;
      const ids = new Set(sel.map((c) => c.id));
      for (const c of sel) c.start = quantize(c.start + delta, fps());
      for (const c of sel) overwriteRange(store.project, c.trackId, c.start, clipEnd(c), ids, fps());
      store.commit('Nudge');
    },

    makeAssetClip(asset) {
      if (asset.kind === 'video') return makeClip('video', { assetId: asset.id, name: asset.name, duration: Math.floor(asset.duration * fps()) / fps() });
      if (asset.kind === 'image') return makeClip('image', { assetId: asset.id, name: asset.name, duration: 5 });
      return makeClip('audio', { assetId: asset.id, name: asset.name, duration: Math.floor(asset.duration * fps()) / fps() });
    },

    /** Place a clip. With trackId it overwrites there; otherwise it takes the first free track or a new one. */
    addClip(clip, { trackId = null, start = null, label = null } = {}) {
      const project = store.project;
      const f = 1 / fps();
      const s = quantize(Math.max(0, start ?? store.time), fps());
      clip.start = s;
      clip.duration = Math.max(f, Math.round(clip.duration * fps()) / fps());
      const kind = trackKindFor(clip.kind);
      let tid = trackId;
      const tr = tid ? store.getTrack(tid) : null;
      if (!tr || tr.kind !== kind || tr.locked) {
        tid = findFreeTrack(project, clip.kind, s, s + clip.duration) || addTrack(project, kind).id;
      }
      overwriteRange(project, tid, s, s + clip.duration, new Set(), fps());
      clip.trackId = tid;
      project.clips.push(clip);
      store.select([clip.id]);
      store.commit(label || `Add ${clip.kind}`);
      return clip;
    },

    addAsset(asset, opts = {}) {
      if (!asset || asset.status !== 'ready') return null;
      return A.addClip(A.makeAssetClip(asset), opts);
    },

    removeAsset(id) {
      const asset = assets.get(id);
      if (!asset) return;
      const project = store.project;
      const affected = project.clips.filter((c) => c.assetId === id);
      if (store.playing && affected.length) playback.pause();
      for (const c of affected) playback.release(c.id);
      store.history.scrub((c) => c.assetId !== id);
      project.clips = project.clips.filter((c) => c.assetId !== id);
      glfx?.deleteTex(`img:${id}`);
      glfx?.deleteTex(`poster:${id}`);
      assets.remove(id);
      store.pruneSelection();
      store.emit('project', { asset: true });
      store.emit('history');
      const n = affected.length;
      toast(`Removed ${asset.name}${n ? ` and ${n} clip${n > 1 ? 's' : ''}` : ''}. Its memory was released.`);
    },

    setAspect(aspect) {
      if (store.project.aspect === aspect) return;
      store.project.aspect = aspect;
      store.commit(`Aspect ${aspect}`);
    },

    addTrack(kind) {
      const tr = addTrack(store.project, kind);
      store.commit(`Add ${tr.name}`);
    },

    toggleTrack(trackId, prop) {
      const tr = store.getTrack(trackId);
      if (!tr) return;
      tr[prop] = !tr[prop];
      if (prop === 'locked' && tr.locked) {
        for (const c of store.project.clips) if (c.trackId === trackId) store.selection.delete(c.id);
        store.emit('selection');
      }
      const verb = { hidden: tr.hidden ? 'Hide' : 'Show', muted: tr.muted ? 'Mute' : 'Unmute', locked: tr.locked ? 'Lock' : 'Unlock' }[prop];
      store.commit(`${verb} ${tr.name}`);
    },

    undo() {
      const label = store.undo();
      if (label) announce(`Undid ${label}`);
    },
    redo() {
      const label = store.redo();
      if (label) announce(`Redid ${label}`);
    },
  };
  return A;
}
