/**
 * Recap Page
 * Sprint 1 - Week 1
 * 
 * Session completion view with placeholder for artifacts
 * Week 3 will add real artifacts from backend
 * 
 * Auth flow: Discord Login → Consent Gate → Recap (protected)
 */

'use client';

import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle, Home, Share2, Sparkles, Clock, Target, Heart } from 'lucide-react';
import { useSessionStore, selectSession, selectArtifacts } from '../stores/session-store';
import { cn } from '../lib/utils';
import { logger } from '../lib/error-logger';
import { haptic } from '../hooks/useHaptics';
import { getClosingMessage } from '../lib/time-greetings';
import { SharedHeader } from '../components/SharedHeader';
import { SessionFeedback } from '../components/session/SessionFeedback';
import { ProtectedRoute } from '../components/ProtectedRoute';

// Hook: respect prefers-reduced-motion
function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return reduced;
}

// Celebration particle component
function CelebrationParticles() {
  const reducedMotion = useReducedMotion();
  const [particles] = useState(() => 
    Array.from({ length: 20 }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 2,
      duration: 2 + Math.random() * 2,
      size: 4 + Math.random() * 8,
      color: ['#8b5cf6', '#a78bfa', '#c4b5fd', '#ddd6fe'][Math.floor(Math.random() * 4)],
    }))
  );

  // Skip animation entirely when user prefers reduced motion
  if (reducedMotion) return null;
  
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
      {particles.map((p) => (
        <div
          key={p.id}
          className="absolute animate-[confettiFall_linear_forwards]"
          style={{
            left: `${p.left}%`,
            top: '-10%',
            width: p.size,
            height: p.size,
            backgroundColor: p.color,
            borderRadius: '50%',
            animationDuration: `${p.duration}s`,
            animationDelay: `${p.delay}s`,
            opacity: 0.7,
          }}
        />
      ))}
    </div>
  );
}

// Animated stat card
function StatCard({ 
  icon: Icon, 
  label, 
  value, 
  delay 
}: { 
  icon: typeof Clock; 
  label: string; 
  value: string;
  delay: number;
}) {
  const [isVisible, setIsVisible] = useState(false);
  
  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), delay);
    return () => clearTimeout(timer);
  }, [delay]);
  
  return (
    <div className={cn(
      'bg-sophia-surface/50 rounded-xl p-4 border border-sophia-surface-border transition-all duration-500',
      isVisible ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-4 scale-95'
    )}>
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-sophia-purple/10 flex items-center justify-center">
          <Icon className="w-5 h-5 text-sophia-purple" />
        </div>
        <div>
          <p className="text-xs text-sophia-text2 uppercase tracking-wide">{label}</p>
          <p className="text-lg font-semibold text-sophia-text">{value}</p>
        </div>
      </div>
    </div>
  );
}

export default function RecapPage() {
  return (
    <ProtectedRoute>
      <RecapPageContent />
    </ProtectedRoute>
  );
}

function RecapPageContent() {
  const router = useRouter();
  const session = useSessionStore(selectSession);
  const artifacts = useSessionStore(selectArtifacts);
  const clearSession = useSessionStore((state) => state.clearSession);
  
  const [showContent, setShowContent] = useState(false);
  const [showCelebration, setShowCelebration] = useState(true);
  
  // Dynamic closing message based on preset type
  const closingMessage = useMemo(() => {
    return getClosingMessage(session?.presetType);
  }, [session?.presetType]);
  
  // Trigger entrance animations
  useEffect(() => {
    haptic('success');
    const timer = setTimeout(() => setShowContent(true), 300);
    
    // Hide celebration after a while
    const celebrationTimer = setTimeout(() => setShowCelebration(false), 5000);
    
    return () => {
      clearTimeout(timer);
      clearTimeout(celebrationTimer);
    };
  }, []);
  
  // If no session at all, redirect to home
  useEffect(() => {
    if (!session) {
      router.push('/');
    }
  }, [session, router]);
  
  const handleReturnHome = () => {
    haptic('light');
    clearSession();
    router.push('/');
  };
  
  // Calculate session duration
  const getDuration = () => {
    if (!session?.startedAt) return '—';
    const start = new Date(session.startedAt).getTime();
    const end = session.endedAt ? new Date(session.endedAt).getTime() : Date.now();
    const minutes = Math.round((end - start) / 60000);
    return minutes < 1 ? '< 1 min' : `${minutes} min`;
  };
  
  if (!session) {
    return (
      <div className="flex items-center justify-center h-screen bg-sophia-bg">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-2 border-sophia-purple/30 border-t-sophia-purple rounded-full animate-spin" />
          <span className="text-sophia-text2 animate-pulse">Loading...</span>
        </div>
      </div>
    );
  }
  
  return (
    <div className="min-h-screen bg-sophia-bg relative overflow-hidden">
      {/* Shared Header */}
      <SharedHeader variant="recap" />
      
      <div className="py-12 px-4">
        {/* Celebration particles */}
        {showCelebration && <CelebrationParticles />}
      
      <div className="max-w-2xl mx-auto space-y-8 relative z-10">
        {/* Success Header with animation */}
        <div className={cn(
          'text-center transition-all duration-700',
          showContent ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-8'
        )}>
          {/* Animated success icon */}
          <div className="relative inline-flex items-center justify-center w-20 h-20 mb-6">
            {/* Outer pulse ring */}
            <span className="absolute inset-0 rounded-full bg-sophia-accent/20 animate-ping" />
            {/* Inner glow */}
            <span className="absolute inset-2 rounded-full bg-sophia-accent/10 animate-pulse" />
            {/* Icon container */}
            <div className="relative w-16 h-16 rounded-full bg-gradient-to-br from-sophia-accent/70 to-sophia-accent flex items-center justify-center shadow-lg">
              <CheckCircle className="w-8 h-8 text-sophia-bg" />
            </div>
          </div>
          
          <h1 className="text-3xl font-bold mb-3 text-sophia-text">
            Session Complete! 🎉
          </h1>
          <p className="text-sophia-text2 text-lg">
            {session.summary || closingMessage}
          </p>
        </div>
        
        {/* Stats Row */}
        <div className={cn(
          'grid grid-cols-3 gap-4 transition-all duration-500',
          showContent ? 'opacity-100' : 'opacity-0'
        )}>
          <StatCard 
            icon={Clock} 
            label="Duration" 
            value={getDuration()} 
            delay={400}
          />
          <StatCard 
            icon={Target} 
            label="Type" 
            value={session.presetType.charAt(0).toUpperCase() + session.presetType.slice(1)} 
            delay={500}
          />
          <StatCard 
            icon={Heart} 
            label="Context" 
            value={session.contextMode.charAt(0).toUpperCase() + session.contextMode.slice(1)} 
            delay={600}
          />
        </div>
        
        {/* Placeholder Content (Week 1) */}
        {!artifacts ? (
          <div className={cn(
            'bg-sophia-surface rounded-2xl p-8 text-center border border-sophia-surface-border transition-all duration-500 delay-300',
            showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
          )}>
            <Sparkles className="w-8 h-8 text-sophia-purple/50 mx-auto mb-4" />
            <p className="text-sophia-text2 mb-4">
              Your personalized insights will appear here.
            </p>
            <p className="text-sm text-sophia-text2/60">
              Coming in Week 3: Takeaways, reflections, and memory highlights
            </p>
          </div>
        ) : (
          // Week 3: Full artifacts display will go here
          <div className="space-y-6">
            {/* Takeaway */}
            {artifacts.takeaway && (
              <section className={cn(
                'bg-sophia-surface rounded-2xl p-6 border border-sophia-surface-border transition-all duration-500',
                showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              )}>
                <h2 className="text-lg font-semibold mb-3 flex items-center gap-2 text-sophia-text">
                  <span className="text-2xl">📝</span> Key Takeaway
                </h2>
                <p className="text-sophia-text2 leading-relaxed">{artifacts.takeaway}</p>
              </section>
            )}
            
            {/* Reflection */}
            {artifacts.reflection_candidate && (
              <section className={cn(
                'bg-sophia-surface rounded-2xl p-6 border border-sophia-surface-border transition-all duration-500 delay-100',
                showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              )}>
                <h2 className="text-lg font-semibold mb-3 flex items-center gap-2 text-sophia-text">
                  <span className="text-2xl">💭</span> Something to Reflect On
                </h2>
                <blockquote className="text-sophia-text2 italic border-l-4 border-sophia-purple/50 pl-4">
                  &ldquo;{artifacts.reflection_candidate.prompt}&rdquo;
                </blockquote>
              </section>
            )}
          </div>
        )}
        
        {/* Session Feedback */}
        <div className={cn(
          'transition-all duration-500 delay-400',
          showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
        )}>
          <SessionFeedback 
            sessionId={session.sessionId}
            onSubmit={(data) => {
              logger.debug('Recap', 'Session feedback submitted', { rating: data.rating });
              haptic('success');
            }}
          />
        </div>
        
        {/* Actions with enhanced styling */}
        <div className={cn(
          'flex gap-4 justify-center pt-4 transition-all duration-500 delay-500',
          showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
        )}>
          <button
            onClick={handleReturnHome}
            className={cn(
              'px-8 py-4 rounded-2xl font-semibold transition-all duration-300 flex items-center gap-3',
              'bg-sophia-purple hover:bg-sophia-purple/90 text-white',
              'shadow-lg hover:shadow-xl hover:scale-105 active:scale-95',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple focus-visible:ring-offset-2'
            )}
          >
            <Home className="w-5 h-5" />
            Start New Session
            <span className="text-lg">→</span>
          </button>
          
          <button
            className="px-6 py-4 rounded-2xl border border-sophia-surface-border text-sophia-text2 font-medium flex items-center gap-2 opacity-50 cursor-not-allowed"
            disabled
            title="Coming in Sprint 2"
          >
            <Share2 className="w-5 h-5" />
            Share
          </button>
        </div>
        
        {/* Subtle footer */}
        <p className={cn(
          'text-center text-sm text-sophia-text2/50 transition-all duration-500 delay-700',
          showContent ? 'opacity-100' : 'opacity-0'
        )}>
          Session saved • {new Date(session.startedAt).toLocaleDateString()}
        </p>
      </div>
      </div>
    </div>
  );
}
