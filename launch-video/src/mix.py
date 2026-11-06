# The soundtrack: music cut to the picture, the voice on top, the sound effects, then loudness for the web.
#   mix.py [voice]    reads out/cues.json, writes out/audio.wav
import json, os, subprocess, sys
import numpy as np, soundfile as sf
from scipy.signal import butter, fftconvolve, resample_poly, sosfilt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sfx import MAKE, SR

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'out')
voice = sys.argv[1] if len(sys.argv) > 1 else 'af_heart'
cues = json.load(open(os.path.join(OUT, 'cues.json')))
LEN, BAR = cues['len'], cues['bar']
N = int(LEN * SR)
KICK = 15.57                    # first full kick in the track (src/beats.py); it lands on the 7
END = cues['end']               # where the music stops and the last hit lands


def db(x): return 10 ** (x / 20)
def stereo_at(buf, x, t, gain=1.0):
    i = int(t * SR); n = min(len(x), len(buf) - i)
    if n > 0: buf[i:i + n] += x[:n] * gain


# --- music ------------------------------------------------------------------------------------------------------
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', os.path.join(ROOT, 'music/Deep Urban.mp3'), '-ac', '2', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True).stdout
track = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).astype(np.float64)
start = KICK - cues['kickAt']               # the track starts part-way in, so its first kick hits the 7
music = track[int(start * SR):int(start * SR) + N].copy()
music[:int(.5 * SR)] *= np.linspace(0, 1, int(.5 * SR))[:, None] ** 2
# hard stop on the last bar, and a long room tail from what was playing, so the end rings instead of cutting
e = int(END * SR)
ir_t = np.arange(int(3.4 * SR)) / SR
rng = np.random.default_rng(3)
ir = rng.standard_normal((len(ir_t), 2)) * np.exp(-ir_t * 2.2)[:, None]
ir = np.stack([sosfilt(butter(2, [160, 5200], 'band', fs=SR, output='sos'), ir[:, c]) for c in (0, 1)], 1)
src = music[e - int(BAR * SR / 2):e].copy()
tail = np.stack([fftconvolve(src[:, c], ir[:, c]) for c in (0, 1)], 1)
tail = tail / np.abs(tail).max() * np.abs(src).max() * .75
music[e:] = 0
music[e - int(.03 * SR):e] *= np.linspace(1, 0, int(.03 * SR))[:, None]
stereo_at(music, tail[int(BAR * SR / 2):], END)
# Keep it moving: under Seven the music closes to a low hum, then opens wide for the final picture.
lo = np.stack([sosfilt(butter(2, 700, 'low', fs=SR, output='sos'), music[:, c]) for c in (0, 1)], 1)
a, z = (int(x * SR) for x in cues['lowpass']); r = int(.5 * SR)
mixenv = np.zeros(N); mixenv[a:z] = 1; mixenv[a - r:a] = np.linspace(0, 1, r); mixenv[z:z + int(.12 * SR)] = np.linspace(1, 0, int(.12 * SR))
music = music * (1 - mixenv)[:, None] + lo * mixenv[:, None] * db(-1)
# a little room for the voice to sit in
carve = butter(2, [900, 3200], 'band', fs=SR, output='sos')
music = music - .35 * np.stack([sosfilt(carve, music[:, c]) for c in (0, 1)], 1)

# --- voice ------------------------------------------------------------------------------------------------------
vo = np.zeros((N, 2))
env = np.zeros(N)
for k, t in cues['vo'].items():
    pcm, sr = sf.read(os.path.join(ROOT, 'voice/lines', voice, f'{k}.wav'), dtype='float64')
    pcm = resample_poly(pcm, SR, sr)
    i = int(t * SR)
    vo[i:i + len(pcm)] += np.stack([pcm, pcm], 1)[:N - i]
    env[i:i + len(pcm)] = 1
sf.write(os.path.join(OUT, 'vo.wav'), vo, SR, subtype='FLOAT')

# Duck the music under speech, easing in ahead of the first word and out after the last.
w = int(.62 * SR)
duck = np.convolve(env, np.hanning(w) / np.hanning(w).sum(), 'same')
music *= (db(-11) ** duck)[:, None] * db(-4)

# --- effects ----------------------------------------------------------------------------------------------------
fx = np.zeros((N, 2))
cache = {}
for c in cues['sfx']:
    x = MAKE[c['name']]() if c['name'] == 'key' else cache.setdefault(c['name'], MAKE[c['name']]())
    stereo_at(fx, x, c['t'], c['gain'] * db(-7))

sf.write(os.path.join(OUT, 'music.wav'), music, SR, subtype='FLOAT')
sf.write(os.path.join(OUT, 'fx.wav'), fx, SR, subtype='FLOAT')

# --- master: voice chain, sum, then -14 LUFS with a -1 dBTP ceiling (the level YouTube and the socials expect) --------
vo_chain = 'highpass=f=85,equalizer=f=220:t=q:w=1.1:g=-1.5,equalizer=f=3400:t=q:w=1.3:g=2.5,equalizer=f=9000:t=h:w=2000:g=2,acompressor=threshold=-22dB:ratio=3:attack=6:release=90:makeup=4dB'
fg = f'[0]{vo_chain},aecho=0.9:0.9:38|61:0.07|0.05[v];[v][1][2]amix=inputs=3:normalize=0:duration=longest'
tmp = os.path.join(OUT, 'sum.wav')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', f'{OUT}/vo.wav', '-i', f'{OUT}/music.wav', '-i', f'{OUT}/fx.wav', '-filter_complex', fg, '-ar', str(SR), '-c:a', 'pcm_f32le', tmp], check=True)


def loud(path):
    o = subprocess.run(['ffmpeg', '-hide_banner', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True).stderr
    s = o[o.rindex('Summary:'):]
    return float(s.split('I:')[1].split('LUFS')[0]), float(s.split('Peak:')[1].split('dBFS')[0])


# Plain gain into a limiter keeps the music's rise and fall; a normaliser would flatten it. Two passes to land on -14.
gain = 0.0
for _ in range(3):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', tmp, '-af', f'volume={gain:.2f}dB,alimiter=limit=0.76:attack=2:release=80:level=disabled', '-ar', str(SR), '-c:a', 'pcm_s24le', '-t', str(LEN), f'{OUT}/audio.wav'], check=True)
    i, peak = loud(f'{OUT}/audio.wav')
    gain += -14 - i
print(f'final {i:.1f} LUFS, peak {peak:.1f} dBTP')
