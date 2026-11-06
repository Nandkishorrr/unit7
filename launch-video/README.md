# Unit 7 launch film

60 seconds, 1080p, 60 fps. Everything here is made from code, so any line, word or sound can change and the film re-renders.

## Change something

| To change | Edit | Then run |
|---|---|---|
| What's said | `voice/script.json` | steps 1 to 5 |
| The voice | pass another name to `voice/gen.py` and `src/mix.py` (`am_michael`, `bm_george`, `bf_emma`) | steps 1, 2, 4, 5 |
| A picture | `src/index.html`, `src/style.css`, `src/scenes.js` | step 5 |
| Timing or a sound | `src/scenes.js` (`VO`, `sfx(...)`) | steps 3 to 5 |
| Music level | the `duck` lines in `src/mix.py` | step 4, 5 |

## Build it

```bash
.venv/bin/python voice/gen.py af_heart 1.0     # 1. speak each line
.venv/bin/python voice/words.py                # 2. word timings, so pictures land on words
python3 -c "import json;print('window.WORDS='+json.dumps(json.load(open('voice/words.json')))+';')" > src/words.js
node render.mjs cues                           # 3. when each line and sound plays
.venv/bin/python -I src/mix.py                 # 4. out/audio.wav
node render.mjs video 4 1 8                    # 5. out/picture.mp4, with motion blur (about 11 minutes)
```

Then join them:

```bash
ffmpeg -i out/picture.mp4 -i out/audio.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 320k -movflags +faststart -shortest out/unit7-launch-v2.mp4
```

`render.mjs` needs Google Chrome installed. It plays `src/index.html` one frame at a time, so a frame depends only on its time.
`node render.mjs still 8.2 21` writes single frames to `out/stills`. `src/qa_audio.py` measures the voice against the music and transcribes the mix.

## Credits

- Music: "Deep Urban" by Eugenio Mininni, from Mixkit, under the Mixkit Stock Music Free License (mixkit.co/license). It's free for commercial use on the web, social media and ads, and needs no credit. It isn't allowed on TV, radio, DVDs or in games, and it can't be claimed as your own or registered on a rights service. If a platform raises a claim, forward it to team@mixkit.co.
- To change the music: put the file in `music/`, run `src/beats.py` on it, set `BAR` in `src/scenes.js` and `KICK` in `src/mix.py`, then run `src/grid.py` to confirm the cuts land on kicks.
- Voice: Kokoro-82M (Apache 2.0), voice `af_heart`, run through `kokoro-onnx`.
- Sound effects: made in `src/sfx.py`.
- Fonts: Archivo, Geist and JetBrains Mono (SIL Open Font License), from the website.
- Motion: GSAP. The shader is the website's own.
