# Checks the mix without ears: how far the voice stands above the music, and whether speech still reads through it.
import json, os, subprocess, sys
import numpy as np, soundfile as sf
from faster_whisper import WhisperModel
from scipy.signal import butter, resample_poly, sosfilt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'out')
c = json.load(open(os.path.join(OUT, 'cues.json')))
vo, sr = sf.read(os.path.join(OUT, 'vo.wav')); mu, _ = sf.read(os.path.join(OUT, 'music.wav'))
fx, _ = sf.read(os.path.join(OUT, 'fx.wav'))
# voice-band energy is what decides whether words read over music
band = butter(4, [300, 4000], 'band', fs=sr, output='sos')
def lvl(x): return 10 * np.log10(np.mean(sosfilt(band, x.mean(1)) ** 2) + 1e-12)
lines = {k: t for k, t in c['vo'].items()}
for k, t in lines.items():
    d = sf.info(os.path.join(ROOT, 'voice/lines/af_heart', f'{k}.wav')).duration
    a, z = int(t * sr), int((t + d) * sr)
    # +4 dB is the voice chain's makeup, applied after this stem
    print(f"{k:6s} voice over music {lvl(vo[a:z]) + 4 - lvl(mu[a:z]):5.1f} dB   over fx {lvl(vo[a:z]) + 4 - lvl(fx[a:z]):5.1f} dB")

pcm, sr2 = sf.read(os.path.join(OUT, 'audio.wav'), dtype='float32')
m = WhisperModel(os.path.join(ROOT, 'voice/whisper'), device='cpu', compute_type='int8')
segs, _ = m.transcribe(resample_poly(pcm.mean(1), 16000, sr2).astype(np.float32), beam_size=5)
print('\nheard in the final mix:')
for s in segs: print(f'{s.start:5.1f}  {s.text.strip()}')
