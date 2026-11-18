# Cutroom

A multi-track video editor that runs entirely in your browser. Files open from your disk as local Blob URLs and never leave the tab: no uploads, no accounts, no API keys. The page's Content-Security-Policy only allows connections to its own origin and to Hugging Face, which is used solely to download the on-device voice model once.

**Live:** https://chanwoo777.github.io/cutroom/

## What it does

- **Workspace:** a dark four-zone layout. The header holds undo/redo, canvas zoom (Fit, 50%, 100%, 200%), the sequence format badge (`1080p • 60fps`, click to change aspect or frame rate) and Export. A left icon rail opens a collapsible drawer (Media, Text, Transitions, Effects, Stickers, Audio). The centre viewport has a checkerboard backdrop and the transport bar, the right inspector follows the selection, and the timeline sits below. Sliders are hairline; every number field is a scrubber (drag sideways, Shift for ×10, Alt for ×0.1, click to type).
- **Timeline:** video, overlay and audio tracks; split at the playhead (`Ctrl+B` or `S`), duplicate (`Ctrl+D`), delete, ripple delete (`Shift+Del`), edge trimming, drag between tracks with overwrite, magnetic snapping (`N`), zoom, `HH:MM:SS:FF` ruler, waveforms and filmstrips. Clips are colour-coded (video blue, audio green, overlays violet).
- **Transitions:** cross dissolve, fade through black, wipe left/right, slide left/up and zoom, placed at the head of a clip that butts against the previous one (the outgoing clip keeps playing underneath). Pick one from the Transitions drawer or the inspector, or put the same one on every cut at once.
- **Program monitor:** 16:9, 9:16, 1:1 and 4:5; drag, scale and rotate layers on the canvas; safe-zone guides (`G`); optional blurred fill behind footage that doesn't match the frame. The canvas renders at the full sequence resolution (1920×1080, or Half/Quarter on slow machines) and the browser scales it to fit, so the preview is the exported picture.
- **Alignment:** align left / centre / right / top / middle / bottom to the frame or the title-safe area, measured on the rotated, scaled bounds (glyph ink for text without a box). Dragging snaps edges and centres to the frame, its centre lines, the safe area (when guides are on) and other layers, with guide lines; hold Alt to drag freely.
- **Colour:** WebGL2 grading with 3D LUT presets (Teal & Orange, Vintage, Noir, Cyberpunk, Arctic, Bleach Bypass, Golden Hour), `.cube` import, and brightness, contrast, saturation, blur, sepia and vignette. The Effects drawer adds one-click grades (Cinematic, Mono, Warm film, Cool, Faded, Punchy, Dreamy) with live previews.
- **Text and stickers:** double-click text on the canvas (or press Enter) to type straight onto it; the text panel puts content, font, size, weight, colour, alignment, box, outline and shadow first, all live. Vector cut-paper stickers and emoji.
- **Animation:** separate Beginning (in) and Ending (out) effects, each with its own duration; together they never exceed the clip, and the timeline shows both ramps.
- **AI voice-over (on-device):** select a text clip and press **Voice-over** (or `T`) to have an AI voice read it; the voice lands on an audio track under the text, the text is fitted to the speech, and the two move together. **Audio → AI voice-over** narrates a whole script and adds a caption per sentence, timed to the voice. 10 voices, 31 languages including Korean and English, detected from the text.
- **Audio:** decoded waveforms, per-clip volume and fades, and a procedural Web Audio synth for royalty-free beats and sound effects.
- **Rendering:** the program canvas is a single WebGL2 context. Each layer is one textured quad with its transform in the vertex shader; grading runs in the same pass; blur is a separable Gaussian at reduced resolution. Video frames are uploaded only when the decoder has a new one (`requestVideoFrameCallback`), and text and stickers are rasterised once and cached as textures. Canvas 2D remains as a fallback.
- **Playback:** the AudioContext clock is the master; video is drift-corrected to stay within about 30 ms. Waveforms come from a peak pyramid computed in slices off the critical path, and filmstrips and waveforms are cached as OffscreenCanvas strips, so scrolling and dragging only blit. The status bar shows the live frame rate and compositing time.
- **Export:** frame-accurate by default: every frame is rendered offline at the export resolution and encoded with WebCodecs (H.264 High, quality-tuned variable bitrate: about 20 Mbps Standard / 31 Mbps High at 1080p30, 35 / 52 Mbps at 1080p60), audio mixed offline at 48 kHz (AAC), muxed to MP4 with mp4-muxer. The first footage you add sets the sequence frame rate (read from the MP4 container, so 59.94 fps footage gives a 60 fps sequence), and exports default to the largest source resolution. No dropped frames and the tab can be in the background. A real-time `MediaRecorder` engine remains as a fallback.
- **Undo/redo:** every edit is a deep-cloned snapshot.

## Performance

Measured in Chrome on the development machine, at 1080p with three 1080p60 video layers (one graded picture-in-picture), a text overlay and a cross dissolve, timed with a GPU sync after each frame:

| | Before (Canvas 2D + separate WebGL grade) | Now (single WebGL2 compositor) |
|---|---|---|
| Compositing, 1080p, new frame on every video | 28.9 ms (about 35 fps) | 6.2 ms |
| Same, 4K canvas | not tested | 9.5 ms |
| Playback (5 s at 60 Hz) | — | 300 of 300 frames, p95 9.3 ms, A/V drift median 17 ms |
| Timeline redraw while dragging a clip | 4.3 ms average, 21.6 ms spikes (waveform pass alone) | 0.1 ms |

## Run locally

The site has no build step and no runtime dependencies. ES modules need to be served over HTTP:

```bash
python serve.py 8797
```

Then open http://127.0.0.1:8797.

The interface CSS is written with Tailwind CSS v4 (`tools/tailwind.css`) and compiled into the committed `css/app.css`. To change it:

```bash
npm install
npm run build:css
```

## AI voice

The voice is [Supertonic 3](https://huggingface.co/Supertone/supertonic-3) by Supertone, run with [ONNX Runtime Web](https://onnxruntime.ai) 1.31.1 (vendored in `vendor/`, unmodified) inside a Web Worker.

- **Runs on your device.** On first use the browser downloads the four model files (398 MB) from a pinned Hugging Face revision, checks each against its published SHA-256, and keeps them in Cache Storage for offline use. The text you voice is never sent anywhere.
- **Speed.** With WebGPU a sentence takes 2–3 s once the engine is warm; the first preparation in each session compiles GPU kernels and takes about a minute. Without WebGPU it falls back to the CPU (WebAssembly), which works but is several times slower.
- **License.** The model is under BigScience OpenRAIL-M (`js/voice/SUPERTONIC-LICENSE.txt`). Its use restrictions pass on to you: do not use it to impersonate a real person without consent, and disclose AI-generated speech. The inference pipeline follows Supertone's MIT-licensed browser example.

## Notes

- The real-time export engine needs the tab to stay visible; the default frame-accurate engine does not.
- Chrome cannot decode HEVC or ProRes `.mov` files; use MP4 (H.264) or WebM.
- The interface uses two self-hosted fonts (Hanken Grotesk and JetBrains Mono, both SIL Open Font License, in `fonts/`); text overlays in your video use fonts installed on your machine.
- Projects are not saved between sessions; media cannot be reopened after a reload.
- Vendored libraries, unmodified and integrity-checked against npm: ONNX Runtime Web 1.31.1 and mp4-muxer 5.2.2 (both MIT), in `vendor/`.
