import sys, wave, numpy as np
from fractions import Fraction
from scipy.signal import resample_poly
def load(p):
    b=open(p,'rb').read()
    # tolerate espeak placeholder lengths: parse fmt and take data to EOF
    import struct
    off=12; sr=None
    while off+8<=len(b):
        cid=b[off:off+4]; sz=struct.unpack('<I',b[off+4:off+8])[0]
        if cid==b'fmt ': ch=struct.unpack('<H',b[off+10:off+12])[0]; sr=struct.unpack('<I',b[off+12:off+16])[0]
        if cid==b'data':
            data=b[off+8:] if sz in (0,0xffffffff) or off+8+sz>len(b) else b[off+8:off+8+sz]
            x=np.frombuffer(data[:len(data)//2*2],dtype='<i2').astype(np.float64)/32768.0
            return sr, x
        off+=8+sz+(sz&1)
    raise SystemExit('no data')
def app_decimate(x, src, dst=16000):  # exact port of pcm16Base64FromFloat32 index rule
    ratio=src/dst; n=max(1,int(np.floor(len(x)/ratio)))
    idx=np.minimum(len(x)-1,np.floor(np.arange(n)*ratio).astype(int)); return x[idx]
def band_energy(x, sr, lo, hi):
    X=np.abs(np.fft.rfft(x))**2; f=np.fft.rfftfreq(len(x),1/sr); return X[(f>=lo)&(f<hi)].sum()
def db(a,b): return 10*np.log10(max(a,1e-30)/max(b,1e-30))
for p in sys.argv[1:]:
    sr,x=load(p); x=np.concatenate([x,np.zeros(int(1.5*sr))]) if 'espeak' in p else x
    tot=band_energy(x,sr,0,sr/2); hi=band_energy(x,sr,8000,sr/2)
    print(f"{p.split('/')[-1]}: sr={sr} dur={len(x)/sr:.3f}s energy>8kHz = {db(hi,tot):.1f} dB rel total")
    for ctx in (48000,44100):
        fr=Fraction(ctx,sr).limit_denominator(1000)
        y=resample_poly(x,fr.numerator,fr.denominator)          # browser decodeAudioData (band-limited)
        naive=app_decimate(y,ctx)                                # app path today
        fr2=Fraction(16000,ctx).limit_denominator(1000)
        ref=resample_poly(y,fr2.numerator,fr2.denominator)[:len(naive)]  # band-limited reference
        n=min(len(ref),len(naive)); err=naive[:n]-ref[:n]
        print(f"   ctx {ctx}: out {n/16000:.3f}s bytes={2*n}  distortion(naive-ref) = {db((err**2).sum(),(ref[:n]**2).sum()):.1f} dB rel signal;  5-8kHz band naive vs ref: {db(band_energy(naive[:n],16000,5000,8000),band_energy(ref[:n],16000,5000,8000)):+.1f} dB")
