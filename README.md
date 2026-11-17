# Cutroom

A multi-track video editor that runs entirely in your browser. Files open from your disk as local Blob URLs and never leave the tab: no uploads, no accounts, no API keys. The page's Content-Security-Policy only allows connections to its own origin and to Hugging Face, which is used solely to download the on-device voice model once.

**Live:** https://chanwoo777.github.io/cutroom/

## What it does

- **Timeline:** video, overlay and audio tracks; razor split (`S`), duplicate (`Ctrl+D`), delete, ripple delete (`Shift+Del`), edge trimming, drag between tracks with overwrite, magnetic snapping (`N`), zoom, `HH:MM:SS:FF` ruler, waveforms and filmstrips.
- **Program monitor:** 16:9, 9:16, 1:1 and 4:5; drag, scale and rotate layers on the canvas; safe-zone guides (`G`); optional blurred fill behind footage that doesn't match the frame.
- **Colour:** WebGL2 grading with 3D LUT presets (Teal & Orange, Vintage, Noir, Cyberpunk, Arctic, Bleach Bypass, Golden Hour), `.cube` import, and brightness, contrast, saturation, blur, sepia and vignette.
- **Text and stickers:** title presets with pop, slide, zoom and typewriter animations; vector cut-paper stickers and emoji.
- **AI voice-over (on-device):** select a text clip and press **Voice-over** (or `T`) to have an AI voice read it; the voice lands on an audio track under the text, the text is fitted to the speech, and the two move together. **Audio → AI voice-over** narrates a whole script and adds a caption per sentence, timed to the voice. 10 voices, 31 languages including Korean and English, detected from the text.
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

## AI voice

The voice is [Supertonic 3](https://huggingface.co/Supertone/supertonic-3) by Supertone, run with [ONNX Runtime Web](https://onnxruntime.ai) 1.31.1 (vendored in `vendor/`, unmodified) inside a Web Worker.

- **Runs on your device.** On first use the browser downloads the four model files (398 MB) from a pinned Hugging Face revision, checks each against its published SHA-256, and keeps them in Cache Storage for offline use. The text you voice is never sent anywhere.
- **Speed.** With WebGPU a sentence takes 2–3 s once the engine is warm; the first preparation in each session compiles GPU kernels and takes about a minute. Without WebGPU it falls back to the CPU (WebAssembly), which works but is several times slower.
- **License.** The model is under BigScience OpenRAIL-M (`js/voice/SUPERTONIC-LICENSE.txt`). Its use restrictions pass on to you: do not use it to impersonate a real person without consent, and disclose AI-generated speech. The inference pipeline follows Supertone's MIT-licensed browser example.

## Notes

- Export runs in real time and only while the tab is visible.
- Chrome cannot decode HEVC or ProRes `.mov` files; use MP4 (H.264) or WebM.
- Text overlays use fonts installed on your machine; the page loads no web fonts.
- Projects are not saved between sessions; media cannot be reopened after a reload.
