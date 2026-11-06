# Finds a track's real tempo and first beat from its kicks, so the cut sits on them.
import subprocess, sys
import numpy as np
from scipy.signal import butter, find_peaks, sosfilt
sr = 8000
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', sys.argv[1], '-ac', '1', '-ar', str(sr), '-f', 'f32le', '-'], capture_output=True).stdout
x = np.frombuffer(raw, dtype=np.float32)
low = sosfilt(butter(4, 110, 'low', fs=sr, output='sos'), x)
env = np.convolve(np.abs(low), np.ones(40) / 40, 'same')
onset = np.maximum(np.diff(env, prepend=0), 0)
peaks, h = find_peaks(onset, distance=int(.3 * sr), height=onset.max() * .12)
t = peaks / sr
d = np.diff(t); beat = np.median(d[(d > .3) & (d < .75)])
# refine on the whole track: fit a line through kicks that sit on the grid
n = np.round((t - t[0]) / beat); fit = np.polyfit(n, t, 1)
for _ in range(3):
    n = np.round((t - fit[1]) / fit[0]); r = t - np.polyval(fit, n); ok = np.abs(r) < .05; fit = np.polyfit(n[ok], t[ok], 1)
print(f'beat {fit[0]:.5f}s = {60 / fit[0]:.2f} BPM, grid start {fit[1]:.3f}s, {ok.sum()}/{len(t)} kicks on grid, rms error {1000 * r[ok].std():.1f} ms')
rms = [float(np.sqrt((x[i * sr:(i + 4) * sr] ** 2).mean())) for i in range(0, 120, 4)]
print('rms every 4s:', ' '.join(f'{v:.2f}' for v in rms))
print('first kicks:', ' '.join(f'{v:.2f}' for v in t[:24]))
