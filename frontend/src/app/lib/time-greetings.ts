import type { CopyStructure } from "../copy/types"

import type { PresetType, ContextMode } from "./session-types"

type TimeOfDay = "morning" | "afternoon" | "evening" | "lateNight"

type Greeting = {
  heading: string
  icon: string
  body: string
}

/**
 * Determines the time of day based on the user's local hour
 * 
 * Ranges:
 * - Morning: 5:00 - 11:59
 * - Afternoon: 12:00 - 17:59
 * - Evening: 18:00 - 21:59
 * - Late Night: 22:00 - 4:59
 */
export function getTimeOfDay(): TimeOfDay {
  const hour = new Date().getHours()
  
  if (hour >= 5 && hour < 12) return "morning"
  if (hour >= 12 && hour < 18) return "afternoon"
  if (hour >= 18 && hour < 22) return "evening"
  return "lateNight"
}

/**
 * Returns a greeting object based on the user's local time
 * Includes heading, icon, and body text
 */
export function getTimeBasedGreeting(copy: CopyStructure): Greeting {
  const timeOfDay = getTimeOfDay()
  const greetings = copy.home.hero.greetings
  
  return greetings[timeOfDay] ?? greetings.default
}

/**
 * Returns just the heading text for simpler use cases
 */
export function getTimeBasedHeading(copy: CopyStructure): string {
  return getTimeBasedGreeting(copy).heading
}

/**
 * Returns just the icon for the current time of day
 */
export function getTimeBasedIcon(copy: CopyStructure): string {
  return getTimeBasedGreeting(copy).icon
}

/**
 * Returns a random placeholder from the rotating placeholders list
 * Called once per session/component mount for consistency
 */
export function getRandomPlaceholder(copy: CopyStructure): string {
  const placeholders = copy.chat.placeholders
  const randomIndex = Math.floor(Math.random() * placeholders.length)
  return placeholders[randomIndex]
}

// ============================================================================
// SESSION GREETINGS - Dynamic greetings for ritual sessions
// ============================================================================

type SessionGreeting = {
  message: string
  followUp?: string
}

/**
 * Session greetings matrix: preset × context × time
 * Each combination has multiple variants for variety
 */
const SESSION_GREETINGS: Record<PresetType, Record<ContextMode, Record<TimeOfDay, SessionGreeting[]>>> = {
  prepare: {
    gaming: {
      morning: [
        { message: "Morning gaming session? Let's set you up for a good one.", followUp: "What's the game today?" },
        { message: "Early grind! I respect it. Let's lock in your mindset.", followUp: "What do you want to focus on?" },
        { message: "Rise and game. What's the mission this morning?" },
      ],
      afternoon: [
        { message: "Pre-game ritual time. What's the vibe going into this one?", followUp: "Any specific goal?" },
        { message: "Afternoon session incoming. Let's get your head right.", followUp: "What matters most this game?" },
        { message: "Ready to lock in? Tell me what you want to carry into this session." },
      ],
      evening: [
        { message: "Night session. These are the ones that matter. What's your intention?", followUp: "Let's make it count." },
        { message: "Evening gaming. Perfect time for focused play. What's the goal?", followUp: "I'm here to help you stay sharp." },
        { message: "Ready for the grind? Let's set you up mentally.", followUp: "What mindset do you want?" },
      ],
      lateNight: [
        { message: "Late night session. These can go either way. What's your intention?", followUp: "Let's make sure it's a good one." },
        { message: "Burning the midnight oil. What kind of session do you want?", followUp: "I'll help you stay focused." },
        { message: "Night owl gaming. Let's make it intentional, not just reactive." },
      ],
    },
    work: {
      morning: [
        { message: "Morning work prep. Let's set you up for a productive day.", followUp: "What's the priority today?" },
        { message: "New day, fresh start. What do you want to focus on this morning?" },
        { message: "Ready to tackle the day? Let's get your mind clear first.", followUp: "What's most important?" },
      ],
      afternoon: [
        { message: "Afternoon work session. Let's reset and refocus.", followUp: "What needs your attention?" },
        { message: "Midday check-in. How can we set up the rest of your day?", followUp: "Any blockers?" },
        { message: "Pre-work prep. Let's get intentional about what's next." },
      ],
      evening: [
        { message: "Evening work session? Let's make it focused and finite.", followUp: "What's the one thing you need to finish?" },
        { message: "Working late. Let's be intentional so you can rest soon.", followUp: "What's the goal?" },
        { message: "Night work. Define what 'done' looks like so you can disconnect." },
      ],
      lateNight: [
        { message: "Burning the midnight oil for work. Let's make it count.", followUp: "What absolutely needs to happen?" },
        { message: "Late night work. Let's set clear boundaries on this session.", followUp: "When will you stop?" },
        { message: "Night work. No judgment. Let's be efficient so you can rest." },
      ],
    },
    life: {
      morning: [
        { message: "Good morning. Let's prepare your mind for whatever today brings.", followUp: "What's on your heart?" },
        { message: "A new day. Take a breath. What do you want to carry into today?" },
        { message: "Morning prep. I'm here to help you start right.", followUp: "How are you feeling?" },
      ],
      afternoon: [
        { message: "Afternoon check-in. Let's prepare you for what's ahead.", followUp: "What do you need?" },
        { message: "Taking a moment to prepare. What's on your mind?" },
        { message: "Midday pause. What would help you move forward well?" },
      ],
      evening: [
        { message: "Evening prep. What are you preparing for?", followUp: "I'm listening." },
        { message: "Taking time to prepare before the night. What matters right now?" },
        { message: "Evening mindset. Let's set you up for whatever's next." },
      ],
      lateNight: [
        { message: "Late night prep. Something on your mind?", followUp: "I'm here." },
        { message: "Night thoughts. Let's work through whatever you're preparing for." },
        { message: "Still awake. What are you getting ready for?" },
      ],
    },
  },
  debrief: {
    gaming: {
      morning: [
        { message: "Morning debrief? That must have been quite a session.", followUp: "How did it go?" },
        { message: "Processing an overnight session? I'm listening.", followUp: "Tell me about it." },
        { message: "Debrief time. What happened in your gaming session?" },
      ],
      afternoon: [
        { message: "Post-game debrief. How did it feel?", followUp: "Walk me through it." },
        { message: "Session complete. Let's process what happened.", followUp: "The good and the bad." },
        { message: "Debrief time. No judgment. What went down?" },
      ],
      evening: [
        { message: "Evening debrief. How was the session?", followUp: "Let's unpack it together." },
        { message: "Post-game. Time to process. How are you feeling?", followUp: "Tell me everything." },
        { message: "Session over. What are you carrying from that one?" },
      ],
      lateNight: [
        { message: "Late night debrief. Can't sleep on how that went?", followUp: "I'm listening." },
        { message: "Processing after a night session. What happened?", followUp: "Good or rough?" },
        { message: "Night debrief. Let it out. How did it go?" },
      ],
    },
    work: {
      morning: [
        { message: "Morning work debrief. Yesterday still on your mind?", followUp: "Let's process it." },
        { message: "Debrief from work. What happened?", followUp: "I'm here to help you make sense of it." },
        { message: "Work reflection. Something you need to unpack?" },
      ],
      afternoon: [
        { message: "Midday work debrief. How's the day going?", followUp: "What needs processing?" },
        { message: "Work debrief. Let's talk through what happened.", followUp: "No filter needed." },
        { message: "Post-meeting? Post-deadline? Let's debrief.", followUp: "What's on your mind?" },
      ],
      evening: [
        { message: "End of workday. How did it go?", followUp: "Let's close it out properly." },
        { message: "Work debrief time. What happened today?", followUp: "The wins and the frustrations." },
        { message: "Evening reflection on work. What are you carrying home?" },
      ],
      lateNight: [
        { message: "Work still on your mind? Let's debrief.", followUp: "What happened?" },
        { message: "Late night work thoughts. Can't let it go?", followUp: "Talk to me." },
        { message: "Processing work at night. What needs unpacking?" },
      ],
    },
    life: {
      morning: [
        { message: "Morning reflection. Something from yesterday still with you?", followUp: "Let's talk." },
        { message: "Debrief time. What happened that you need to process?" },
        { message: "Morning thoughts. Something on your heart?" },
      ],
      afternoon: [
        { message: "Afternoon debrief. What's happened today?", followUp: "I'm listening." },
        { message: "Taking time to reflect. What needs processing?", followUp: "No rush." },
        { message: "Debrief moment. What's been going on?" },
      ],
      evening: [
        { message: "Evening reflection. How was your day?", followUp: "Really, how was it?" },
        { message: "End of day debrief. What are you carrying?", followUp: "Let's unpack it." },
        { message: "Night reflection. What happened today that matters?" },
      ],
      lateNight: [
        { message: "Late night thoughts. Something keeping you up?", followUp: "I'm here." },
        { message: "Can't sleep on something? Let's debrief.", followUp: "What's on your mind?" },
        { message: "Night reflection. Something needs processing?" },
      ],
    },
  },
  reset: {
    gaming: {
      morning: [
        { message: "Morning tilt reset? Must've been rough. Let's recalibrate.", followUp: "Take a breath." },
        { message: "Reset time. We're gonna get your head right.", followUp: "Deep breath first." },
        { message: "Gaming got frustrating. That's okay. Let's reset." },
      ],
      afternoon: [
        { message: "Tilt hitting? Let's reset. One breath at a time.", followUp: "I'm with you." },
        { message: "Frustration building. Let's pause and reset.", followUp: "It's just a game." },
        { message: "Reset time. Close your eyes. We'll get you back to baseline." },
      ],
      evening: [
        { message: "Night session getting tilting? Let's reset before it spirals.", followUp: "Breathe with me." },
        { message: "Tilt reset. The games aren't going anywhere. Your mental is priority." },
        { message: "Frustration creeping in? Let's catch it early. Reset time." },
      ],
      lateNight: [
        { message: "Late night tilt is the worst. Let's reset.", followUp: "Tired + tilted is a bad combo." },
        { message: "Night reset. Your brain is tired. Let's recalibrate.", followUp: "One breath." },
        { message: "Tilt at night hits different. Let's slow down and reset." },
      ],
    },
    work: {
      morning: [
        { message: "Stressful morning? Let's reset. Work can wait 90 seconds.", followUp: "Breathe first." },
        { message: "Work stress building. Quick reset. Let's go.", followUp: "You've got this." },
        { message: "Morning overwhelm. Let's pause and reset your nervous system." },
      ],
      afternoon: [
        { message: "Afternoon stress. Let's do a quick reset.", followUp: "30 seconds of breath." },
        { message: "Work overwhelm? Pause. Let's reset together.", followUp: "Just you and me." },
        { message: "Midday stress reset. Your body needs this break." },
      ],
      evening: [
        { message: "Work stress carrying over? Let's reset before it takes your night.", followUp: "Breathe." },
        { message: "Evening stress reset. Leave work at work. Start here.", followUp: "One deep breath." },
        { message: "Work tension. Let's release it before bed." },
      ],
      lateNight: [
        { message: "Work stress keeping you up? Let's reset.", followUp: "Can't solve it tonight anyway." },
        { message: "Late night stress. Your brain is spinning. Let's slow it down." },
        { message: "Night reset. Work will be there tomorrow. Let your body rest." },
      ],
    },
    life: {
      morning: [
        { message: "Morning reset. Something threw you off?", followUp: "Let's recalibrate." },
        { message: "Need to ground yourself this morning. Let's reset.", followUp: "One breath at a time." },
        { message: "Reset time. Whatever happened, we're here now." },
      ],
      afternoon: [
        { message: "Afternoon reset. Let's get you back to center.", followUp: "Breathe with me." },
        { message: "Life feeling overwhelming? Quick reset.", followUp: "Just 60 seconds." },
        { message: "Midday grounding. Let's reset your nervous system." },
      ],
      evening: [
        { message: "Evening reset. Let go of the day's weight.", followUp: "Exhale it out." },
        { message: "Reset time. The day is done. Let's release.", followUp: "You did enough." },
        { message: "Night reset. Let's ground you before sleep." },
      ],
      lateNight: [
        { message: "Late night reset. Can't sleep?", followUp: "Let's calm your system." },
        { message: "Night grounding. Your mind is racing. Let's slow down.", followUp: "Breathe." },
        { message: "Reset before sleep. Let's release whatever you're holding." },
      ],
    },
  },
  vent: {
    gaming: {
      morning: [
        { message: "Morning vent. Something happened that needs out?", followUp: "Let it rip." },
        { message: "Vent session. I'm ready. What happened?", followUp: "No filter." },
        { message: "Time to let it out. What went wrong?" },
      ],
      afternoon: [
        { message: "Vent time. I'm all ears. What's got you frustrated?", followUp: "Let it out." },
        { message: "Gaming frustration? Vent to me. No judgment.", followUp: "Tell me everything." },
        { message: "Let it out. What happened in your session?" },
      ],
      evening: [
        { message: "Night vent. Something's bothering you. Tell me.", followUp: "I'm listening." },
        { message: "Vent session. The games got to you?", followUp: "I'm here for it." },
        { message: "Time to let it out. What happened?" },
      ],
      lateNight: [
        { message: "Late night vent. Can't sleep on the frustration?", followUp: "Let it out." },
        { message: "Vent time. The night sessions got intense?", followUp: "Tell me." },
        { message: "Night venting. Sometimes you just need to get it out." },
      ],
    },
    work: {
      morning: [
        { message: "Morning work vent. Already frustrated?", followUp: "Tell me what happened." },
        { message: "Work stress vent. I'm here. Let it out.", followUp: "No holding back." },
        { message: "Vent session. What's going on at work?" },
      ],
      afternoon: [
        { message: "Midday vent. Work getting to you?", followUp: "Let it out." },
        { message: "Work frustration. Vent to me.", followUp: "I'm listening." },
        { message: "Stress vent. What happened?", followUp: "Tell me everything." },
      ],
      evening: [
        { message: "End of day vent. Work was rough?", followUp: "I'm here." },
        { message: "Vent time. What happened today?", followUp: "Don't hold it in." },
        { message: "Work stress needs out. I'm listening." },
      ],
      lateNight: [
        { message: "Work still frustrating you at night? Vent it out.", followUp: "I'm here." },
        { message: "Late night work vent. Can't let it go?", followUp: "Tell me." },
        { message: "Night vent. Work thoughts spinning?", followUp: "Let them out." },
      ],
    },
    life: {
      morning: [
        { message: "Morning vent. Something's been building up?", followUp: "Let it out." },
        { message: "Vent session. What's on your mind?", followUp: "I'm listening." },
        { message: "Time to let it out. What's been bothering you?" },
      ],
      afternoon: [
        { message: "Afternoon vent. Something needs to come out?", followUp: "Go for it." },
        { message: "Vent time. I'm here. What's happening?", followUp: "No judgment." },
        { message: "Let it out. What's frustrating you?" },
      ],
      evening: [
        { message: "Evening vent. Let go of the day's frustrations.", followUp: "I'm listening." },
        { message: "Vent session. What happened today?", followUp: "Tell me." },
        { message: "Time to release. What's been building up?" },
      ],
      lateNight: [
        { message: "Late night vent. Can't sleep on it?", followUp: "Let it out." },
        { message: "Night venting. I'm here for you.", followUp: "What's going on?" },
        { message: "Vent time. Whatever's keeping you up, let it out." },
      ],
    },
  },
  open: {
    gaming: {
      morning: [
        { message: "Hey. What's on your mind?", followUp: "No agenda needed." },
        { message: "Morning. I'm here.", followUp: "What do you want to talk about?" },
        { message: "Just wanted to chat? I'm listening." },
      ],
      afternoon: [
        { message: "Hey. What's going on?", followUp: "I'm all ears." },
        { message: "Afternoon check-in. How are you?", followUp: "No rituals, just talk." },
        { message: "I'm here. What's on your mind?" },
      ],
      evening: [
        { message: "Evening. What's up?", followUp: "I'm here for whatever." },
        { message: "Hey. Something on your mind?", followUp: "Let's talk." },
        { message: "No agenda. Just us. What's happening?" },
      ],
      lateNight: [
        { message: "Late night thoughts? I'm here.", followUp: "What's on your mind?" },
        { message: "Can't sleep? Talk to me.", followUp: "I'm listening." },
        { message: "Night owl mode. What's up?" },
      ],
    },
    work: {
      morning: [
        { message: "Good morning. What's on your mind?", followUp: "I'm here." },
        { message: "Hey. Just wanted to check in.", followUp: "How are you?" },
        { message: "Morning. I'm listening. What's up?" },
      ],
      afternoon: [
        { message: "Afternoon. What's on your mind?", followUp: "No structure needed." },
        { message: "Hey. I'm here if you want to talk.", followUp: "About anything." },
        { message: "Just checking in. How's it going?" },
      ],
      evening: [
        { message: "End of day. What's on your mind?", followUp: "I'm listening." },
        { message: "Evening check-in. How are you doing?", followUp: "Really." },
        { message: "Hey. What's up?" },
      ],
      lateNight: [
        { message: "Working late? I'm here too.", followUp: "What's on your mind?" },
        { message: "Night thoughts. Want to talk?", followUp: "I'm listening." },
        { message: "Late night. What's going on?" },
      ],
    },
    life: {
      morning: [
        { message: "Good morning. I'm here.", followUp: "What's on your mind?" },
        { message: "Morning. Just wanted to say hi.", followUp: "How are you?" },
        { message: "Hey. I'm listening. What's up?" },
      ],
      afternoon: [
        { message: "Hey. What's going on?", followUp: "I'm here." },
        { message: "Afternoon. Anything on your mind?", followUp: "I'm all ears." },
        { message: "Just checking in. How are you doing?" },
      ],
      evening: [
        { message: "Evening. How was your day?", followUp: "I'm here to listen." },
        { message: "Hey. What's on your mind?", followUp: "No agenda." },
        { message: "I'm here. What do you want to talk about?" },
      ],
      lateNight: [
        { message: "Can't sleep? I'm here.", followUp: "What's on your mind?" },
        { message: "Late night. Sometimes you just need to talk.", followUp: "I'm listening." },
        { message: "Night thoughts? Share them with me." },
      ],
    },
  },
  // Chat is an alias for open - free-form conversation
  chat: {
    gaming: {
      morning: [{ message: "Morning! What's on your mind?", followUp: "I'm listening." }],
      afternoon: [{ message: "Hey, what's up?", followUp: "I'm here." }],
      evening: [{ message: "Evening. What's going on?", followUp: "Talk to me." }],
      lateNight: [{ message: "Late night chat? I'm here.", followUp: "What's on your mind?" }],
    },
    work: {
      morning: [{ message: "Morning. What's on your mind?", followUp: "I'm listening." }],
      afternoon: [{ message: "Hey. What's going on?", followUp: "I'm here." }],
      evening: [{ message: "End of day. How are you?", followUp: "I'm listening." }],
      lateNight: [{ message: "Working late? I'm here too.", followUp: "What's up?" }],
    },
    life: {
      morning: [{ message: "Good morning. I'm here.", followUp: "What's on your mind?" }],
      afternoon: [{ message: "Hey. Anything on your mind?", followUp: "I'm listening." }],
      evening: [{ message: "Evening. How was your day?", followUp: "I'm here to listen." }],
      lateNight: [{ message: "Can't sleep? I'm here.", followUp: "What's on your mind?" }],
    },
  },
}

/**
 * Get a session greeting based on preset, context, and time of day
 * Randomly selects from available variants for variety
 */
export function getSessionGreeting(
  presetType: PresetType,
  contextMode: ContextMode
): SessionGreeting {
  const timeOfDay = getTimeOfDay()
  const greetings = SESSION_GREETINGS[presetType]?.[contextMode]?.[timeOfDay]
  
  if (!greetings || greetings.length === 0) {
    // Fallback greeting
    return { 
      message: "I'm here with you. What's on your mind?",
      followUp: "Take your time."
    }
  }
  
  // Random selection for variety
  const index = Math.floor(Math.random() * greetings.length)
  return greetings[index]
}

/**
 * Get a formatted greeting message (combines message + followUp)
 */
export function getSessionGreetingMessage(
  presetType: PresetType,
  contextMode: ContextMode
): string {
  const greeting = getSessionGreeting(presetType, contextMode)
  return greeting.followUp 
    ? `${greeting.message} ${greeting.followUp}`
    : greeting.message
}

// ============================================================================
// THINKING MESSAGES - Variety for typing indicator
// ============================================================================

const THINKING_MESSAGES: Record<PresetType, string[]> = {
  prepare: [
    "Thinking about your focus...",
    "Considering your intention...",
    "Preparing some thoughts...",
    "Getting your mindset ready...",
  ],
  debrief: [
    "Processing what you shared...",
    "Reflecting on that...",
    "Thinking through this with you...",
    "Sitting with what happened...",
  ],
  reset: [
    "Finding calm with you...",
    "Centering...",
    "Breathing with you...",
    "Grounding...",
  ],
  vent: [
    "Hearing you out...",
    "Taking that in...",
    "I'm with you...",
    "Listening...",
  ],
  open: [
    "Thinking...",
    "I'm here...",
    "Taking that in...",
    "Let me think about that...",
  ],
  chat: [
    "Thinking...",
    "I'm here...",
    "Taking that in...",
    "Let me think about that...",
  ],
}

/**
 * Get a thinking message appropriate for the preset type
 */
export function getThinkingMessage(presetType?: PresetType): string {
  const messages = presetType 
    ? THINKING_MESSAGES[presetType] 
    : THINKING_MESSAGES.prepare
  
  const index = Math.floor(Math.random() * messages.length)
  return messages[index]
}

// ============================================================================
// INPUT PLACEHOLDERS - Context-aware
// ============================================================================

const INPUT_PLACEHOLDERS: Record<PresetType, Record<ContextMode, string[]>> = {
  prepare: {
    gaming: [
      "What's your goal for this session?",
      "What mindset do you want?",
      "Any frustrations to leave behind?",
    ],
    work: [
      "What's the priority?",
      "What needs your focus?",
      "Any blockers to clear?",
    ],
    life: [
      "What are you preparing for?",
      "What do you need right now?",
      "What's on your mind?",
    ],
  },
  debrief: {
    gaming: [
      "How did it go?",
      "What happened in that session?",
      "Any moments that stood out?",
    ],
    work: [
      "How was your day?",
      "What happened?",
      "What are you carrying?",
    ],
    life: [
      "What's on your mind?",
      "What happened?",
      "How are you feeling about it?",
    ],
  },
  reset: {
    gaming: [
      "What triggered the tilt?",
      "What do you need to let go?",
      "How are you feeling?",
    ],
    work: [
      "What's stressing you?",
      "What do you need to release?",
      "Take a breath and type...",
    ],
    life: [
      "What's overwhelming you?",
      "What do you need?",
      "Just breathe and share...",
    ],
  },
  vent: {
    gaming: [
      "What happened?",
      "Let it out...",
      "Tell me everything.",
    ],
    work: [
      "What's frustrating you?",
      "Let it out...",
      "No filter needed.",
    ],
    life: [
      "What's bothering you?",
      "I'm listening...",
      "Go ahead, let it out.",
    ],
  },
  open: {
    gaming: [
      "What's on your mind?",
      "Talk to me...",
      "What's up?",
    ],
    work: [
      "What's on your mind?",
      "I'm listening...",
      "What do you want to talk about?",
    ],
    life: [
      "What's on your mind?",
      "I'm here...",
      "What do you want to share?",
    ],
  },
  chat: {
    gaming: [
      "What's on your mind?",
      "Talk to me...",
      "What's up?",
    ],
    work: [
      "What's on your mind?",
      "I'm listening...",
      "What do you want to talk about?",
    ],
    life: [
      "What's on your mind?",
      "I'm here...",
      "What do you want to share?",
    ],
  },
}

/**
 * Get an input placeholder for the current session context
 * Enhanced in Sprint 1+ to support emotional tone from bootstrap
 */
export function getInputPlaceholder(
  presetType: PresetType, 
  contextMode: ContextMode,
  tone?: 'warm' | 'energizing' | 'grounding' | 'supportive'
): string {
  // Tone-specific overrides (from bootstrap emotional weather)
  if (tone) {
    const toneOverrides: Record<string, string[]> = {
      supportive: [
        "Take your time... I'm here.",
        "No rush. Say what feels right.",
        "I'm listening. What do you need?",
      ],
      grounding: [
        "Let's slow down. What's happening right now?",
        "Take a breath. What's on your mind?",
        "Present moment. What do you notice?",
      ],
      warm: [
        "Good to see you. What's up?",
        "Hey. What's going on?",
        "I'm here. What do you want to talk about?",
      ],
      energizing: [
        "Let's do this. What's the plan?",
        "Ready to go? What's first?",
        "Locked in. What are we working on?",
      ],
    }
    
    const overrides = toneOverrides[tone]
    if (overrides && overrides.length > 0) {
      const index = Math.floor(Math.random() * overrides.length)
      return overrides[index]
    }
  }
  
  const placeholders = INPUT_PLACEHOLDERS[presetType]?.[contextMode]
  
  if (!placeholders || placeholders.length === 0) {
    return "What's on your mind?"
  }
  
  const index = Math.floor(Math.random() * placeholders.length)
  return placeholders[index]
}

// ============================================================================
// CLOSING MESSAGES - For recap page
// ============================================================================

const CLOSING_MESSAGES: Record<PresetType, string[]> = {
  prepare: [
    "You're ready. Go get it.",
    "Locked in. Now make it happen.",
    "Your head is right. Time to execute.",
    "Preparation complete. You've got this.",
  ],
  debrief: [
    "Thanks for processing that with me.",
    "Good debrief. You learned something today.",
    "That was important. Glad you took the time.",
    "Reflection complete. Carry the lessons forward.",
  ],
  reset: [
    "Reset complete. You're back to baseline.",
    "Feeling more grounded? Good.",
    "Nervous system recalibrated. Take it slow.",
    "You're centered again. Well done.",
  ],
  vent: [
    "Glad you got that out. Feel better?",
    "That needed to come out. Good on you.",
    "Venting complete. Sometimes you just need to release.",
    "I heard you. That took courage to share.",
  ],
  open: [
    "Good talk. Take care.",
    "Thanks for sharing. I'm always here.",
    "Nice chat. See you next time.",
    "I'm here whenever you want to talk.",
  ],
  chat: [
    "Good talk. Take care.",
    "Thanks for sharing. I'm always here.",
    "Nice chat. See you next time.",
    "I'm here whenever you want to talk.",
  ],
}

/**
 * Get a closing message for the recap page
 */
export function getClosingMessage(presetType?: PresetType): string {
  const messages = presetType 
    ? CLOSING_MESSAGES[presetType] 
    : ["Great session. Take care of yourself."]
  
  const index = Math.floor(Math.random() * messages.length)
  return messages[index]
}
