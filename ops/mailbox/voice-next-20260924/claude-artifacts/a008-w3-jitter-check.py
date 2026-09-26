import numpy as np
def kernel(src,tgt):
    cutoff=min(0.5,0.45*tgt/src); t=np.arange(63); d=t-31
    sinc=np.where(d==0,2*cutoff,np.sin(2*np.pi*cutoff*d)/(np.pi*np.where(d==0,1,d)))
    w=0.42-0.5*np.cos(2*np.pi*t/62)+0.08*np.cos(4*np.pi*t/62); k=sinc*w; return k/k.sum()
def pr_resample(x,src,tgt,frac=False):
    k=kernel(src,tgt); y=np.convolve(x,k)[:len(x)]   # causal FIR, y[n]=sum k[tap]*x[n-tap]
    n_out=int(np.floor(len(x)*tgt/src)); pos=np.arange(n_out)*src/tgt
    if not frac: return y[np.floor(pos).astype(int)], pos
    i=np.floor(pos).astype(int); f=pos-i; i2=np.minimum(i+1,len(y)-1)
    return y[i]*(1-f)+y[i2]*f, pos
for src in (44100,48000):
    for f in (1000,3000,6000):
        t=np.arange(src*2)/src; x=0.8*np.sin(2*np.pi*f*t)
        for frac in (False,True):
            out,pos=pr_resample(x,src,16000,frac)
            ideal=0.8*np.sin(2*np.pi*f*((pos-31)/src))   # ideal value at exact output instant, minus 31-sample group delay
            # passband gain of filter at f
            k=kernel(src,16000); g=abs(np.sum(k*np.exp(-2j*np.pi*f/src*np.arange(63))))
            s=slice(2000,None); err=out[s]-g*ideal[s]
            snr=10*np.log10(np.mean((g*ideal[s])**2)/np.mean(err**2))
            print(f"src={src} f={f:5d}Hz {'frac-interp' if frac else 'PR floor   '} SNR={snr:6.1f} dB (filter gain {20*np.log10(g):+.2f} dB)")
