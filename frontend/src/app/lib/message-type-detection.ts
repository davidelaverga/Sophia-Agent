/**
 * Message Type Detection
 * 
 * Analyzes Sophia's messages to determine their conversational intent.
 * Used to apply subtle visual differentiation in the UI.
 * 
 * Types:
 * - question: Sophia is asking the user something
 * - affirmation: Positive reinforcement, encouragement
 * - instruction: Guiding the user to do something
 * - reflection: Helping user process/think
 * - casual: General conversation, greetings
 */

export type SophiaMessageType = 
  | 'question'
  | 'affirmation' 
  | 'instruction'
  | 'reflection'
  | 'casual';

// Patterns that indicate questions
const QUESTION_PATTERNS = [
  /\?$/,                           // Ends with ?
  /\?["'"\s]*$/,                   // Ends with ?" or ?' with optional space
  /^(what|how|why|when|where|who|which|can you|could you|would you|do you|are you|is there|have you)/i,
  /want to (tell|share|talk|try|explore)/i,
  /what's on your mind/i,
  /how (are you|do you|does|did|would|could)/i,
  /quick question/i,
  /real talk.*\?/i,                // "So real talk: ...?"
];

// Patterns that indicate affirmation/encouragement (empathy, validation)
const AFFIRMATION_PATTERNS = [
  /^(great|perfect|nice|good|awesome|excellent|wonderful|amazing|well done|that's|you've got|you're doing|i'm proud)/i,
  /\b(proud of you|you can|you've got this|you're capable|believe in you)\b/i,
  /^(yes|yeah|absolutely|exactly|definitely|totally|fair enough)/i,
  /that (makes sense|sounds|feels|works|stings|hurts)/i,
  /i hear you/i,
  /i see (what|how|that)/i,
  /i understand/i,
  /you've earned/i,
  /both are valid/i,
  /no pressure/i,
  /that stings/i,
  /losing hits different/i,
];

// Patterns that indicate instructions/guidance
const INSTRUCTION_PATTERNS = [
  /^(try|let's|take a|start by|begin with|focus on|notice|breathe|pause|say|repeat)/i,
  /here's (your|a|the|how|one)/i,
  /when you (feel|notice|sense|experience)/i,
  /(step \d|first,|second,|then,|next,|finally,)/i,
  /\b(anchor|mantra|phrase|reset|button)\b/i,
  /laugh if you can/i,
  /step away/i,
];

// Patterns that indicate reflection prompts
const REFLECTION_PATTERNS = [
  /what does .* feel like/i,
  /what comes up/i,
  /notice (what|how|if|when)/i,
  /sit with that/i,
  /take a moment/i,
  /think about/i,
  /reflect on/i,
  /consider/i,
];

// Casual/greeting patterns
const CASUAL_PATTERNS = [
  /^(hi|hey|hello|good morning|good afternoon|good evening|welcome)/i,
  /good to see you/i,
  /i'm here/i,
  /let me know/i,
  /^okay[,.]?\s*(no problem)?/i,
];

/**
 * Detect the type of a Sophia message
 */
export function detectMessageType(content: string): SophiaMessageType {
  const trimmed = content.trim();
  
  // Check patterns in order of specificity
  // Questions first (most important to highlight)
  for (const pattern of QUESTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return 'question';
    }
  }
  
  // Reflection prompts (often include questions but are more guided)
  for (const pattern of REFLECTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return 'reflection';
    }
  }
  
  // Instructions/guidance
  for (const pattern of INSTRUCTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return 'instruction';
    }
  }
  
  // Affirmations
  for (const pattern of AFFIRMATION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return 'affirmation';
    }
  }
  
  // Casual
  for (const pattern of CASUAL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return 'casual';
    }
  }
  
  // Default to casual if no pattern matches
  return 'casual';
}

/**
 * Get visual styling hints for a message type.
 * 
 * Uses Tailwind's standard color palette since custom CSS variables
 * can't be used directly in border-color classes.
 * 
 * Color meanings (more saturated for visibility):
 * - purple-400: Questions (Sophia is curious, engaging)
 * - emerald-400: Affirmation (positive, supportive, empathy)
 * - blue-400: Instruction (guiding, teaching)
 * - amber-400: Reflection (introspective, thoughtful)
 * - transparent: Casual (no accent needed)
 */
export function getMessageTypeStyle(type: SophiaMessageType): {
  accentClass: string;
  bgClass: string;
  label?: string;
} {
  switch (type) {
    case 'question':
      return {
        accentClass: 'border-l-purple-400',
        bgClass: 'bg-sophia-bubble',
        label: undefined,
      };
    case 'affirmation':
      return {
        accentClass: 'border-l-emerald-400',
        bgClass: 'bg-sophia-bubble',
        label: undefined,
      };
    case 'instruction':
      return {
        accentClass: 'border-l-blue-400',
        bgClass: 'bg-sophia-bubble',
        label: undefined,
      };
    case 'reflection':
      return {
        accentClass: 'border-l-amber-400',
        bgClass: 'bg-sophia-bubble',
        label: undefined,
      };
    case 'casual':
    default:
      return {
        accentClass: 'border-l-transparent', // Explicit transparent for casual
        bgClass: 'bg-sophia-bubble',
        label: undefined,
      };
  }
}
