# Do the scene cuts really land on the music? Compares each cut with the nearest kick in the track as used.
import json, os, subprocess, sys
import numpy as np
from scipy.signal import butter, find_peaks, sosfilt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
c = json.load(open(os.path.join(ROOT, 'out/cues.json')))
sr = 8000
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', os.path.join(ROOT, 'music/Deep Urban.mp3'), '-ac', '1', '-ar', str(sr), '-f', 'f32le', '-'], capture_output=True).stdout
x = np.frombuffer(raw, dtype=np.float32)
KICK = 15.57
start = KICK - c['kickAt']
low = sosfilt(butter(4, 110, 'low', fs=sr, output='sos'), x)
env = np.convolve(np.abs(low), np.ones(40) / 40, 'same')
onset = np.maximum(np.diff(env, prepend=0), 0)
peaks, _ = find_peaks(onset, distance=int(.3 * sr), height=onset.max() * .15)
kicks = peaks / sr - start
bar = c['bar']
for n in (4, 7, 12.5, 16.5, 19, 21.5, 23.5, 26, 28.5, 29.75):
    t = n * bar
    print(f'bar {n:>4}  cut {t:6.2f}s  nearest kick off by {1000 * (kicks[np.argmin(np.abs(kicks - t))] - t):+6.0f} ms')
