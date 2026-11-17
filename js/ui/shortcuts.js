import { isTypingTarget } from '../util.js';
import { announce } from './dom.js';

export function installShortcuts({ store, actions, playback, timeline, monitor, exporter, shortcutsDialog, onVoice }) {
  // Space on a focused button should play/pause, not click the button.
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ' && e.target instanceof HTMLButtonElement && !e.target.closest('dialog')) e.preventDefault();
  }, true);

  window.addEventListener('keydown', (e) => {
    if (store.exporting || document.querySelector('dialog[open]')) return;
    const t = e.target;
    if (isTypingTarget(t)) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    const k = e.key;
    const arrows = k.startsWith('Arrow') || k === 'Home' || k === 'End' || k === 'PageUp' || k === 'PageDown';
    if (arrows && (t?.type === 'range' || t?.closest?.('[role="tablist"],[role="radiogroup"],select'))) return;
    if ((k === ' ' || k === 'Enter') && t?.closest?.('[role="tablist"]')) return;
    if (k === 'Enter' && (t instanceof HTMLButtonElement || t?.getAttribute?.('role') === 'listitem')) return;

    const mod = e.ctrlKey || e.metaKey;
    const overlay = monitor.overlayFocused;
    let handled = true;
    if (mod) {
      switch (k.toLowerCase()) {
        case 'z': if (e.shiftKey) actions.redo(); else actions.undo(); break;
        case 'y': actions.redo(); break;
        case 'd': actions.duplicateSelected(); break;
        case 'a': actions.selectAll(); break;
        case 'e': exporter.open(); break;
        default: handled = false;
      }
    } else {
      switch (k) {
        case ' ': case 'Spacebar': actions.togglePlay(); break;
        case 'k': case 'K': playback.pause(); break;
        case 'l': case 'L': playback.play(); break;
        case 'j': case 'J': actions.step(-store.fps); break;
        case 'ArrowLeft':
          if (e.altKey) actions.nudgeSelection(-1);
          else if (!(overlay && monitor.nudge(e.shiftKey ? -10 : -1, 0))) actions.step(e.shiftKey ? -store.fps : -1);
          break;
        case 'ArrowRight':
          if (e.altKey) actions.nudgeSelection(1);
          else if (!(overlay && monitor.nudge(e.shiftKey ? 10 : 1, 0))) actions.step(e.shiftKey ? store.fps : 1);
          break;
        case 'ArrowUp': if (!(overlay && monitor.nudge(0, e.shiftKey ? -10 : -1))) actions.jumpEdit(-1); break;
        case 'ArrowDown': if (!(overlay && monitor.nudge(0, e.shiftKey ? 10 : 1))) actions.jumpEdit(1); break;
        case 'Home': actions.seek(0); break;
        case 'End': actions.seek(store.duration); break;
        case 's': case 'S': actions.splitAtPlayhead(); break;
        case 'c': case 'C': store.setTool('razor'); announce('Razor tool'); break;
        case 'v': case 'V': store.setTool('select'); announce('Select tool'); break;
        case 'Delete': case 'Backspace': actions.deleteSelected(e.shiftKey); break;
        case 'n': case 'N': store.setSnap(!store.snap); break;
        case '=': case '+': timeline.zoomBy(1.4); break;
        case '-': case '_': timeline.zoomBy(1 / 1.4); break;
        case 'z': case 'Z': if (e.shiftKey) timeline.zoomFit(); else handled = false; break;
        case 'g': case 'G': monitor.toggleGuides(); break;
        case 't': case 'T': onVoice?.(); break;
        case '?': shortcutsDialog.showModal(); break;
        case 'Escape':
          if (!timeline.cancelDrag() && !monitor.cancelDrag()) {
            if (store.tool === 'razor') store.setTool('select'); else store.clearSelection();
          }
          break;
        default: handled = false;
      }
    }
    if (handled) e.preventDefault();
  });
}
