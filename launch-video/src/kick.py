# Where the music's first kick lands, and how the track ends: the edit is built on these two numbers.
import os, subprocess, sys
import numpy as np
from scipy.signal import butter, sosfilt

sr = 8000
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', sys.argv[1], '-ac', '1', '-ar', str(sr), '-f', 'f32le', '-'], capture_output=True).stdout
x = np.frombuffer(raw, dtype=np.float32)
low = sosfilt(butter(4, 120, 'low', fs=sr, output='sos'), x)
env = np.convolve(np.abs(low), np.ones(160) / 160, 'same')
seg = env[13 * sr:19 * sr]
t0 = 13 + np.argmax(seg > seg.max() * .5) / sr
print('first kick near', round(float(t0), 3))
print('rms per second, last 10s', [round(float(np.sqrt((x[-(k + 1) * sr:(-k * sr or None)] ** 2).mean())), 3) for k in range(9, -1, -1)])
print('duration', round(len(x) / sr, 2))
