# Cutroom

A multi-track video editor that runs entirely in your browser. Files open from your disk as local Blob URLs and never leave the tab: no uploads, no accounts, no API keys. The page ships a Content-Security-Policy with `connect-src 'none'`, so it cannot make network requests even if it wanted to.

**Live:** https://chanwoo777.github.io/cutroom/

## What it does

- **Timeline:** video, overlay and audio tracks; razor split (`S`), duplicate (`Ctrl+D`), delete, ripple delete (`Shift+Del`), edge trimming, drag between tracks with overwrite, magnetic snapping (`N`), zoom, `HH:MM:SS:FF` ruler, waveforms and filmstrips.
- **Program monitor:** 16:9, 9:16, 1:1 and 4:5; drag, scale and rotate layers on the canvas; safe-zone guides (`G`); optional blurred fill behind footage that doesn't match the frame.
- **Colour:** WebGL2 grading with 3D LUT presets (Teal & Orange, Vintage, Noir, Cyberpunk, Arctic, Bleach Bypass, Golden Hour), `.cube` import, and brightness, contrast, saturation, blur, sepia and vignette.
- **Text and stickers:** title presets with pop, slide, zoom and typewriter animations; vector cut-paper stickers and emoji.
- **Audio:** decoded waveforms, per-clip volume and fades, and a procedural Web Audio synth for royalty-free beats and sound effects.
- **Playback:** the AudioContext clock is the master; video is drift-corrected to stay within about 30 ms.
- **Export:** the composited canvas plus the audio mix, recorded in real time with `MediaRecorder` (MP4 or WebM, 480p to 4K) and saved locally.
- **Undo/redo:** every edit is a deep-cloned snapshot.

## Run locally

No build step and no dependencies. ES modules need to be served over HTTP:

```bash
python serve.py 8797
```

Then open http://127.0.0.1:8797.

## Notes

- Export runs in real time and only while the tab is visible.
- Chrome cannot decode HEVC or ProRes `.mov` files; use MP4 (H.264) or WebM.
- Text overlays use fonts installed on your machine, since the page loads nothing from the network.
- Projects are not saved between sessions; media cannot be reopened after a reload.
