# Sizes up a music track without ears: tempo, the loudness arc, and how much sits in the voice's band.
import subprocess, sys, numpy as np
from scipy.signal import stft
SR = 22050
def load(p):
    b = subprocess.run(['ffmpeg','-v','error','-i',p,'-ac','1','-ar',str(SR),'-f','f32le','-'],capture_output=True).stdout
    return np.frombuffer(b,dtype=np.float32)
for p in sys.argv[1:]:
    x = load(p); dur = len(x)/SR
    f,t,Z = stft(x,SR,nperseg=2048,noverlap=1536); M = np.abs(Z)
    flux = np.maximum(np.diff(M,axis=1),0).sum(0); flux -= flux.mean()
    ac = np.correlate(flux[:6000],flux[:6000],'full')[len(flux[:6000])-1:]
    hop = (2048-1536)/SR
    lags = np.arange(len(ac))*hop
    best=[]
    for bpm in np.arange(70,180,.5):
        l=60/bpm; idx=[int(round(k*l/hop)) for k in (1,2,4) if k*l/hop<len(ac)]
        best.append((ac[idx].sum(),bpm))
    bpm=max(best)[1]
    win=int(2/hop); e=M[:, :].sum(0)
    arc=[e[i:i+win].mean() for i in range(0,len(e),win)]; arc=np.array(arc)/max(arc)
    bar=''.join(' .:-=+*#%@'[min(9,int(v*9.99))] for v in arc)
    P=M**2; tot=P.sum(); low=P[f<200].sum()/tot; mid=P[(f>=300)&(f<3000)].sum()/tot; hi=P[f>=3000].sum()/tot
    print(f"{p.split('/')[-1]:24s} {dur:5.0f}s  ~{bpm:.1f}bpm  low {low:.2f} voiceband {mid:.2f} high {hi:.3f}\n  {bar}")
