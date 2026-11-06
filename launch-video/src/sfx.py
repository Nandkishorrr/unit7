# Every sound effect in the film, made from nothing, so there is no licence to carry for them.
import numpy as np
from scipy.signal import butter, sosfilt, sosfilt_zi

SR = 48000
rng = np.random.default_rng(7)


def bp(x, lo, hi): return sosfilt(butter(2, [lo, hi], 'band', fs=SR, output='sos'), x)
def lp(x, f): return sosfilt(butter(2, f, 'low', fs=SR, output='sos'), x)
def hp(x, f): return sosfilt(butter(2, f, 'high', fs=SR, output='sos'), x)
def T(d): return np.arange(int(d * SR)) / SR
def sine(f, t): return np.sin(2 * np.pi * np.cumsum(f * np.ones_like(t)) / SR)


def stereo(x, pan=None):
    if pan is None: return np.stack([x, x], 1)
    a = (pan + 1) * np.pi / 4
    return np.stack([x * np.cos(a), x * np.sin(a)], 1)


def sweep_noise(d, f0, f1, env):
    n = rng.standard_normal(int(d * SR)); out = np.zeros_like(n); step = 256; zi = None
    for i in range(0, len(n), step):
        f = f0 * (f1 / f0) ** (i / len(n))
        sos = butter(2, [max(30, f * .6), min(20000, f * 1.6)], 'band', fs=SR, output='sos')
        if zi is None: zi = sosfilt_zi(sos) * 0
        out[i:i + step], zi = sosfilt(sos, n[i:i + step], zi=zi)
    return out * env


def whoosh():
    d = .85; t = T(d); e = np.sin(np.pi * np.clip(t / d, 0, 1)) ** 2.4
    x = sweep_noise(d, 240, 3600, e)
    return stereo(x / np.abs(x).max() * .5, np.linspace(-.8, .8, len(t)))


def boom():
    t = T(2.4); f = 34 + 44 * np.exp(-t * 16)
    x = sine(f, t) * np.exp(-t * 2.3) * .95
    thump = lp(rng.standard_normal(len(t)), 1800) * np.exp(-t * 60) * .5
    air = hp(rng.standard_normal(len(t)), 3000) * np.exp(-t * 9) * .035
    return stereo(x + thump + air)


def hit():
    t = T(3.6); b = boom()[:, 0]; b = np.pad(b, (0, len(t) - len(b)))
    bell = sum(np.sin(2 * np.pi * f * t) * a for f, a in [(220, .2), (329.6, .14), (440, .12), (659.3, .07), (987.8, .035)]) * np.exp(-t * 1.5)
    shim = hp(rng.standard_normal(len(t)), 5000) * np.exp(-t * 2.4) * .03
    return stereo(b * .95 + bell * .6 + shim)


def rise():
    d = 1.5; t = T(d); e = (t / d) ** 2.6
    x = sweep_noise(d, 300, 6000, e); x = x / np.abs(x).max() * .3
    return stereo(x + sine(90 + 240 * (t / d) ** 2, t) * e * .16)


def tick():
    t = T(.07); return stereo(sine(1500, t) * np.exp(-t * 95) * .34 + sine(3000, t) * np.exp(-t * 170) * .1)
def key():
    t = T(.03); return stereo(bp(rng.standard_normal(len(t)), 1800, 6000) * np.exp(-t * 240) * .32, float(rng.uniform(-.25, .25)))
def pop():
    t = T(.16); return stereo(sine(520 + 560 * (1 - np.exp(-t * 34)), t) * np.exp(-t * 34) * .42)
def click():
    t = T(.08); return stereo(bp(rng.standard_normal(len(t)), 1200, 7000) * np.exp(-t * 170) * .5 + sine(190, t) * np.exp(-t * 90) * .4)
def card():
    d = .4; t = T(d); e = np.sin(np.pi * np.clip(t / d, 0, 1)) ** 2
    x = sweep_noise(d, 500, 1800, e); x = x / np.abs(x).max() * .2
    return stereo(x + sine(150, t) * np.exp(-t * 18) * .3)
def send():
    t = T(.24); return stereo(sine(320 + 900 * (t / .24) ** 2, t) * np.sin(np.pi * t / .24) ** 2 * .28)
def scan():
    d = .7; t = T(d); e = np.sin(np.pi * np.clip(t / d, 0, 1)) ** 1.6
    x = sweep_noise(d, 1800, 7000, e); return stereo(x / np.abs(x).max() * .2, np.linspace(-.4, .4, len(t)))


MAKE = dict(whoosh=whoosh, boom=boom, hit=hit, rise=rise, tick=tick, key=key, pop=pop, click=click, card=card, send=send, scan=scan)
