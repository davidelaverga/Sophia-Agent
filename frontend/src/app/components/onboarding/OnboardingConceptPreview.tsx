'use client';

import { Mic, Sparkles, Brain, Check, X } from 'lucide-react';

function PreviewFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-[20px] border border-sophia-surface-border/80 bg-sophia-surface/70 p-4 shadow-[0_16px_40px_rgba(0,0,0,0.28)]"
      style={{
        backgroundImage: 'linear-gradient(180deg, rgba(124,92,170,0.08), rgba(15,10,25,0.1))',
      }}
    >
      {children}
    </div>
  );
}

export function SessionConceptPreview() {
  return (
    <PreviewFrame>
      <div className="space-y-4">
        <div className="flex items-center justify-between rounded-2xl border border-sophia-surface-border/70 bg-sophia-bg/70 px-4 py-3">
          <div>
            <p className="text-[10px] uppercase tracking-[0.24em] text-sophia-text2/60">Live Session</p>
            <p className="mt-1 text-sm font-medium text-sophia-text">Sophia is listening</p>
          </div>
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-sophia-purple text-white shadow-lg shadow-sophia-purple/25">
            <Mic className="h-4 w-4" />
          </div>
        </div>

        <div className="rounded-2xl border border-sophia-surface-border/70 bg-sophia-user/40 px-4 py-3 text-sm text-sophia-text">
          I need to clear my head before I go back in.
        </div>

        <div className="rounded-2xl border border-sophia-purple/20 bg-sophia-purple/8 px-4 py-3">
          <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-sophia-purple/90">
            <Sparkles className="h-3.5 w-3.5" />
            Artifact
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-2">
              <div className="flex items-end gap-1.5">
                <span className="h-2 w-1.5 rounded-full bg-sophia-purple/60" />
                <span className="h-4 w-1.5 rounded-full bg-sophia-purple/80" />
                <span className="h-6 w-1.5 rounded-full bg-sophia-purple" />
                <span className="h-3 w-1.5 rounded-full bg-sophia-purple/70" />
                <span className="h-5 w-1.5 rounded-full bg-sophia-purple/90" />
              </div>
              <p className="text-sm text-sophia-text2">You usually get clearer once you name the pressure directly.</p>
            </div>
            <div className="w-20 rounded-xl border border-sophia-surface-border/70 bg-sophia-surface/60 p-2 text-[11px] text-sophia-text2">
              Insight panel
            </div>
          </div>
        </div>
      </div>
    </PreviewFrame>
  );
}

export function ArtifactsConceptPreview() {
  return (
    <PreviewFrame>
      <div className="grid gap-3 sm:grid-cols-[1.3fr_0.9fr]">
        <div className="rounded-2xl border border-sophia-purple/20 bg-sophia-purple/8 p-4">
          <div className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-sophia-purple/90">
            <Sparkles className="h-3.5 w-3.5" />
            Takeaway
          </div>
          <p className="text-sm leading-6 text-sophia-text">
            You tend to underestimate how much preparation helps.
          </p>
        </div>

        <div className="space-y-3">
          <div className="rounded-2xl border border-sophia-surface-border/70 bg-sophia-surface/65 p-3">
            <p className="text-[10px] uppercase tracking-[0.2em] text-sophia-text2/60">Memory Candidate</p>
            <p className="mt-2 text-xs leading-5 text-sophia-text2">Preparation reduces your stress more than pushing through does.</p>
          </div>
          <div className="rounded-2xl border border-sophia-surface-border/70 bg-sophia-surface/65 p-3">
            <p className="text-[10px] uppercase tracking-[0.2em] text-sophia-text2/60">Reflection Prompt</p>
            <p className="mt-2 text-xs leading-5 text-sophia-text2">What helped you feel more grounded this time?</p>
          </div>
        </div>
      </div>
    </PreviewFrame>
  );
}

export function MemoryConceptPreview() {
  return (
    <PreviewFrame>
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-sophia-purple/90">
          <Brain className="h-3.5 w-3.5" />
          Sophia remembers...
        </div>

        <div className="rounded-[22px] border border-sophia-purple/20 bg-sophia-purple/8 p-4">
          <p className="text-sm leading-6 text-sophia-text">
            You focus better when you decide the next step out loud before starting.
          </p>
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1 rounded-full bg-sophia-purple px-3 text-xs font-medium text-white"
            >
              <Check className="h-3.5 w-3.5" />
              Approve
            </button>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1 rounded-full border border-sophia-surface-border px-3 text-xs text-sophia-text2"
            >
              <X className="h-3.5 w-3.5" />
              Not now
            </button>
          </div>
        </div>
      </div>
    </PreviewFrame>
  );
}