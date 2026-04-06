"use client"

import { Mic, MessageCircle, Shield, Sparkles, ChevronRight, X } from "lucide-react"
import { useEffect, useState, useCallback } from "react"

import { useTranslation } from "../copy"
import { useHaptics } from "../hooks/useHaptics"
import { useOnboardingStore, type OnboardingStep } from "../stores/onboarding-store"

// Step configuration with icons
const STEPS: OnboardingStep[] = ["welcome", "voice", "text", "privacy"]

type StepConfig = {
  icon: React.ComponentType<{ className?: string }>
}

// All steps use Sophia's purple - consistent with the app's design system
const STEP_CONFIGS: Record<Exclude<OnboardingStep, "complete">, StepConfig> = {
  welcome: {
    icon: Sparkles,
  },
  voice: {
    icon: Mic,
  },
  text: {
    icon: MessageCircle,
  },
  privacy: {
    icon: Shield,
  },
}

export function OnboardingFlow() {
  const { t } = useTranslation()
  const { light: triggerLight, success: triggerSuccess } = useHaptics()
  const { hasCompletedOnboarding, currentStep, setStep, completeOnboarding } = useOnboardingStore()
  
  const [isVisible, setIsVisible] = useState(false)
  const [isExiting, setIsExiting] = useState(false)
  const [direction, setDirection] = useState<"forward" | "backward">("forward")
  
  // Current step index
  const currentIndex = STEPS.indexOf(currentStep as Exclude<OnboardingStep, "complete">)
  
  useEffect(() => {
    if (!hasCompletedOnboarding) {
      // Small delay for smooth entrance
      const timer = setTimeout(() => setIsVisible(true), 100)
      return () => clearTimeout(timer)
    }
  }, [hasCompletedOnboarding])

  const handleNext = useCallback(() => {
    triggerLight()
    setDirection("forward")
    
    if (currentIndex < STEPS.length - 1) {
      setStep(STEPS[currentIndex + 1])
    } else {
      // Complete onboarding
      setIsExiting(true)
      triggerSuccess()
      setTimeout(() => {
        completeOnboarding()
      }, 400)
    }
  }, [currentIndex, setStep, completeOnboarding, triggerLight, triggerSuccess])

  const handleBack = useCallback(() => {
    if (currentIndex > 0) {
      triggerLight()
      setDirection("backward")
      setStep(STEPS[currentIndex - 1])
    }
  }, [currentIndex, setStep, triggerLight])

  const handleSkip = useCallback(() => {
    triggerLight()
    setIsExiting(true)
    setTimeout(() => {
      completeOnboarding()
    }, 400)
  }, [completeOnboarding, triggerLight])

  // Don't render if already completed
  if (hasCompletedOnboarding) return null
  
  // Get current step config for icon
  const stepConfig = STEP_CONFIGS[currentStep as Exclude<OnboardingStep, "complete">]
  if (!stepConfig) return null
  
  const StepIcon = stepConfig.icon
  const isLastStep = currentIndex === STEPS.length - 1

  return (
    <div 
      className={`fixed inset-0 z-[100] flex items-center justify-center transition-all duration-500
        ${isVisible && !isExiting ? "opacity-100" : "opacity-0"}
      `}
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      {/* Solid backdrop - completely hides content behind */}
      <div 
        className={`absolute inset-0 bg-sophia-bg transition-all duration-500
          ${isVisible && !isExiting ? "opacity-100" : "opacity-0"}
        `}
      />
      
      {/* Animated background orbs - using Sophia's color system */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div 
          className="absolute w-[600px] h-[600px] rounded-full blur-[120px] opacity-30 animate-float"
          style={{ 
            background: `radial-gradient(circle, var(--sophia-purple), transparent 70%)`,
            top: "10%",
            left: "50%",
            transform: "translateX(-50%)",
          }}
        />
        <div 
          className="absolute w-[400px] h-[400px] rounded-full blur-[100px] opacity-20 animate-breatheSlow"
          style={{ 
            background: `radial-gradient(circle, var(--sophia-glow), transparent 70%)`,
            bottom: "20%",
            right: "-10%",
          }}
        />
      </div>

      {/* Skip button */}
      <button
        onClick={handleSkip}
        className="absolute top-6 right-6 z-10 flex items-center gap-1.5 px-3 py-2 text-sm text-sophia-text2 
          hover:text-sophia-text bg-sophia-surface/50 backdrop-blur-sm rounded-full border border-sophia-surface-border
          transition-all duration-200 hover:bg-sophia-surface hover:scale-[1.02] active:scale-[0.98]
          sm:top-8 sm:right-8"
        aria-label={t("onboarding.skip")}
      >
        <span className="hidden xs:inline">{t("onboarding.skip")}</span>
        <X className="h-4 w-4" />
      </button>

      {/* Main content card */}
      <div 
        className={`relative z-10 w-full max-w-md mx-4 transition-all duration-500 ease-out
          ${isVisible && !isExiting ? "translate-y-0 scale-100" : "translate-y-8 scale-95"}
        `}
      >
        {/* Glass card */}
        <div className="relative bg-sophia-surface/80 backdrop-blur-2xl rounded-3xl border border-sophia-surface-border overflow-hidden shadow-2xl">
          {/* Top gradient line - using Sophia purple */}
          <div 
            className="absolute top-0 left-0 right-0 h-1 bg-sophia-purple transition-all duration-500"
          />
          
          {/* Content container */}
          <div className="p-6 sm:p-8">
            {/* Step indicator */}
            <div className="flex justify-center gap-2 mb-8">
              {STEPS.map((step, idx) => (
                <button
                  key={step}
                  onClick={() => {
                    if (idx < currentIndex) {
                      setDirection("backward")
                      setStep(step)
                      triggerLight()
                    }
                  }}
                  disabled={idx > currentIndex}
                  className={`h-2 rounded-full transition-all duration-500 
                    ${idx === currentIndex 
                      ? "w-8 bg-sophia-purple" 
                      : idx < currentIndex 
                        ? "w-2 bg-sophia-purple/60 hover:bg-sophia-purple cursor-pointer" 
                        : "w-2 bg-sophia-text2/20"
                    }
                  `}
                  aria-label={`${t("onboarding.stepOf", { current: idx + 1, total: STEPS.length })}`}
                  aria-current={idx === currentIndex ? "step" : undefined}
                />
              ))}
            </div>

            {/* Icon with animated ring */}
            <div className="flex justify-center mb-8">
              <div className="relative">
                {/* Outer glow ring - using Sophia's purple */}
                <div 
                  className="absolute inset-0 rounded-full bg-sophia-purple opacity-20 blur-xl animate-ringBreathe"
                  style={{ transform: "scale(1.5)" }}
                />
                {/* Icon container */}
                <div 
                  className="relative w-20 h-20 sm:w-24 sm:h-24 rounded-full bg-sophia-purple
                    flex items-center justify-center shadow-lg animate-breathe"
                  key={currentStep}
                  style={{
                    animation: `${direction === "forward" ? "slideInRight" : "slideInLeft"} 0.5s ease-out, breathe 4s ease-in-out infinite`
                  }}
                >
                  <StepIcon className="h-10 w-10 sm:h-12 sm:w-12 text-white drop-shadow-md" />
                </div>
              </div>
            </div>

            {/* Text content with slide animation - fixed height to prevent layout shift */}
            <div 
              key={`content-${currentStep}`}
              className="text-center mb-8 h-[140px] sm:h-[120px] flex flex-col justify-center"
              style={{
                animation: `${direction === "forward" ? "slideInRight" : "slideInLeft"} 0.4s ease-out`
              }}
            >
              <h2 
                id="onboarding-title"
                className="text-2xl sm:text-3xl font-semibold text-sophia-text mb-3 tracking-tight"
              >
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {t(`onboarding.steps.${currentStep}.title` as any)}
              </h2>
              <p className="text-sophia-text2 text-base sm:text-lg leading-relaxed max-w-sm mx-auto">
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {t(`onboarding.steps.${currentStep}.description` as any)}
              </p>
            </div>

            {/* Action buttons - fixed width layout */}
            {/* Action buttons - equal width layout */}
            <div className="flex items-center gap-3">
              {/* Back button - only shown after first step */}
              {currentIndex > 0 && (
                <button
                  onClick={handleBack}
                  className="flex-1 h-12 rounded-2xl border border-sophia-surface-border
                    text-sophia-text2 hover:text-sophia-text hover:bg-sophia-surface
                    transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]"
                >
                  {t("onboarding.back")}
                </button>
              )}
              
              {/* Next/Complete button - using Sophia's purple with high contrast */}
              <button
                onClick={handleNext}
                className={`flex-1 h-12 rounded-2xl bg-sophia-purple
                  text-white font-semibold text-base
                  flex items-center justify-center gap-2
                  shadow-lg shadow-sophia-purple/30
                  transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]
                  hover:brightness-105 hover:shadow-xl hover:shadow-sophia-purple/40
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple focus-visible:ring-offset-2 focus-visible:ring-offset-sophia-bg
                  ${currentIndex === 0 ? "max-w-xs mx-auto" : ""}`}
              >
                <span>
                  {isLastStep ? t("onboarding.getStarted") : t("onboarding.continue")}
                </span>
                {!isLastStep && <ChevronRight className="h-5 w-5" />}
                {isLastStep && <Sparkles className="h-5 w-5" />}
              </button>
            </div>

            {/* Step counter - inside the modal */}
            <div className="flex justify-center mt-6">
              <span className="text-sm text-sophia-text2/60">
                {t("onboarding.stepOf", { current: currentIndex + 1, total: STEPS.length })}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* CSS Animations */}
      <style jsx>{`
        @keyframes slideInRight {
          from {
            opacity: 0;
            transform: translateX(30px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
        
        @keyframes slideInLeft {
          from {
            opacity: 0;
            transform: translateX(-30px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
      `}</style>
    </div>
  )
}
