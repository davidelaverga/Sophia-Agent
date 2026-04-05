export const copy = {
  brand: {
    name: "Sophia",
    tagline: "Voice-first emotional companion",
    initial: "S",
  },
  presence: {
    listening: "Listening",
    thinking: "Thinking",
    reflecting: "Reflecting",
    speaking: "Speaking",
    resting: "Resting",
  },
  shell: {
    settingsPlaceholderTitle: "Settings arrive in Part 7",
    settingsPlaceholderBody:
      "We are building a gentle panel for presets, presence, and privacy toggles. It will appear here soon.",
    closeSettings: "Close",
  },
  settings: {
    title: "Settings",
  },
  auth: {
    title: "Sophia",
    subtitle: "A calm, emotionally-aware companion.",
    button: "Continue with Discord",
    loading: "Opening a gentle space...",
    connecting: "Connecting...",
    footerNote: "By continuing, you agree to our terms and privacy policy",
    errors: {
      discord: "Discord sign-in failed. Please try again.",
      unexpected: "We could not contact Discord. Please try again shortly.",
    },
  },
  header: {
    subtitle: "Voice-first emotional companion",
    homeButtonAriaLabel: "Go to home view",
    homeButtonTitle: "Home",
    tooltip: {
      history: "Our story together",
      settings: "Make it yours",
    },
  },
  activeModeIndicator: {
    voice: "Voice",
  },
  inputModeIndicator: {
    fallback: {
      title: "Voice mode unavailable",
      defaultReason: "We couldn't access your microphone after multiple attempts.",
      switchToText: "Switch to Text",
      retryVoice: "Retry Voice",
    },
    singleFailure: {
      message: "Voice temporarily unavailable.",
      useTextInstead: "Use text instead",
    },
  },
  sessionFeedbackToast: {
    prompt: "How did that feel?",
    unableToSend: "Unable to send feedback.",
    skipFeedback: "Skip feedback",
    skip: "Skip",
  },
  gate: {
    title: "Consent required",
    body: "Please accept our data processing consent before your first session.",
    cta: "Review consent",
  },
  home: {
    placeholder:
      "Conversation view mounts here next. For now, we have the design tokens and shell in place.",
    hero: {
      heading: "Welcome back",
      // Time-based greetings - selected dynamically based on user's local time
      greetings: {
        morning: {
          heading: "Good morning",
          icon: "☀️",
          body: "A new day begins. I'm here to hold space for whatever you're carrying.",
        },
        afternoon: {
          heading: "Good afternoon",
          icon: "🌤️",
          body: "Taking a moment in your day? I'm here to listen.",
        },
        evening: {
          heading: "Good evening",
          icon: "🌙",
          body: "The day is winding down. Share what's on your mind.",
        },
        lateNight: {
          heading: "Still here with you",
          icon: "💜",
          body: "Late nights can feel heavy. I'm here if you need to talk.",
        },
        default: {
          heading: "Welcome back",
          icon: "✨",
          body: "I hold space for gentle conversations about how you feel. Take a breath and start whenever you are ready.",
        },
      },
      status: "Sophia is present",
      body: "I hold space for gentle conversations about how you feel. Take a breath and start whenever you are ready.",
      statusIcon: "✨",
    },
    rituals: {
      title: "Gentle rituals",
      items: [
        {
          id: "breath",
          emoji: "🌬️",
          title: "Breathing check-in",
          description: "A two-minute pause that softens your nervous system.",
        },
        {
          id: "gratitude",
          emoji: "✨",
          title: "Gratitude whisper",
          description: "Name one small kindness you noticed today.",
        },
      ],
    },
    presence: {
      title: "Presence snapshot",
      metrics: [
        { id: "response", label: "Avg response time", value: "approx. 2.3s" },
        { id: "listening", label: "Listening focus", value: "Deep" },
      ],
    },
    cards: [
      {
        id: "grounding",
        title: "Grounding prompt",
        description: "Ease into the moment before you speak.",
      },
      {
        id: "journal",
        title: "Tiny reflection",
        description: "Capture the feeling you want to remember later.",
      },
    ],
  },
  chat: {
    placeholder: "Share what you are feeling or noticing...",
    // Rotating placeholders - one is selected randomly on each session/mount
    placeholders: [
      "Share what you're feeling or noticing...",
      "What's on your mind right now?",
      "Take your time... I'm listening",
      "No pressure — just say what comes naturally",
      "How are you really doing?",
      "What would feel good to let out?",
      "I'm here whenever you're ready...",
      "Start wherever feels right",
    ],
    send: "Send",
    sending: "Sending...",
    loading: "Sophia is holding space for your words...",
    audioButton: "Play voice reply",
    stopAudio: "Stop audio",
    cancel: "Cancel",
    cancelResponseAriaLabel: "Cancel response",
    reconnecting: "Reconnecting...",
    reconnectingAttempt: "Attempt {attempt} of {max}",
    cancelled: "Response cancelled",
    interrupted: "Response interrupted",
    retry: "Retry",
    dismiss: "Dismiss",
    aria: {
      youSaid: "You said",
      sophiaReplied: "Sophia replied",
    },
    quickStartTitle: "Need a place to begin?",
    quickPrompts: [
      { id: "overwhelmed", emoji: "😵‍💫", label: "I'm feeling overwhelmed" },
      { id: "breath", emoji: "🌬️", label: "Guide me through a calm breath" },
      { id: "gratitude", emoji: "🌱", label: "Help me notice something kind" },
    ],
    transcriptLabel: "Sophia",
    transcriptAriaLabel: "Conversation transcript",
    scrollToBottom: "Scroll to latest messages",
    copied: "Copied to clipboard",
    longPressHint: "Hold to copy",
    error: "Something felt unclear. Could you try again?",
    // Streaming status messages - rotated for variety
    streamingMessages: {
      thinking: [
        "Taking a moment to reflect...",
        "Considering your words...",
        "Gathering my thoughts...",
        "Finding the right words...",
        "Sitting with this feeling...",
        "Holding space for what you shared...",
        "Processing gently...",
      ],
      reflecting: [
        "Reflecting deeply on this...",
        "Taking time to understand...",
        "Feeling into your words...",
        "Connecting the pieces...",
      ],
    },
    characterLimit: {
      max: 1000,
      warningThreshold: 800,
      approaching: "Getting close to the limit",
      exceeded: "That's a lot to hold at once. Let's take it one thought at a time.",
      counter: "{current} / {max}",
    },
  },
  voiceRecorder: {
    title: "Voice reflections",
    subtitle: "Speak naturally with Sophia",
    readyTitle: "Ready to listen",
    readyBody: "Tap the microphone and share how you are really doing.",
    recordingTitle: "Listening...",
    recordingBody: "Take your time. Silence is welcome too.",
    timerLabel: "Recording time",
    recordingBadge: "Recording",
    tipsTitle: "Tips",
    highlights: [
      { id: "insight", emoji: "🎧", label: "Gentle insights" },
      { id: "presence", emoji: "⏱️", label: "Real-time presence" },
      { id: "voice", emoji: "🔊", label: "Soft voice replies" },
    ],
    tips: [
      "Speak clearly and at a steady pace.",
      "Share feelings, sensations, or small observations.",
      "Pause whenever you need. Sophia keeps listening.",
    ],
    errors: {
      micDenied: "Microphone access was denied. Please allow microphone permissions.",
      micBlocked:
        "Microphone access is blocked. Please enable it in your browser settings and refresh the page.",
      micDeniedPrompt: "Microphone permission was denied. Please allow access when prompted and try again.",
      noMicrophone: "No microphone found. Please connect a microphone and try again.",
      micInUse:
        "Microphone is being used by another application. Please close other apps using the microphone and try again.",
      notSupported:
        "Your browser doesn't support microphone access. Please use Chrome, Firefox, Safari, or Edge (latest versions).",
      httpsRequired:
        "Microphone access requires a secure connection (HTTPS). Please access this site using https:// or from localhost.",
      timeout: "Voice session timed out. Please try again.",
      generic: "I couldn't access your microphone. Please check your permissions.",
      sessionEnded: "Voice session ended unexpectedly.",
      noAudio: "No audio captured. Please try recording again.",
      network: "Voice message failed. Please try again.",
    },
    buttons: {
      start: "Start recording",
      stop: "Stop",
    },
  },
  consentModal: {
    title: "Consent required",
    intro: "Sophia gently records your voice and transcripts to learn how to support you.",
    noticeTitle: "Data processing notice",
    noticeBody:
      "Your conversations are encrypted in transit and processed only to help Sophia grow more empathetic.",
    whatTitle: "What we collect",
    whatItems: [
      "Voice recordings for transcription and emotion sensing",
      "Chat messages and AI responses",
      "Usage patterns and session data",
      "Discord profile basics (username and avatar)",
    ],
    howTitle: "How it helps",
    howItems: [
      "Provide personalized emotional support",
      "Improve Sophia's response quality",
      "Monitor safety and consent requirements",
      "Share anonymous insights with the community",
    ],
    retention:
      "We hash your consent record with timestamp and IP. You can export or delete all data at any time.",
    errors: {
      save: "Consent could not be saved. You can continue, but we may ask again soon.",
      network: "Network error while saving consent. We will still let you continue.",
      missingAuthToken: "Missing authentication token. Please sign in again.",
    },
    privacyLink: "Read our full Privacy Policy →",
    buttons: {
      cancel: "Cancel",
      accept: "I agree",
      saving: "Saving...",
    },
  },

  consentGate: {
    checking: "Checking…",
    retry: "Retry",
    continueAnyway: "Continue anyway (we will ask again soon)",
    errors: {
      loadStatus: "Unable to load consent status.",
      saveConsent: "We could not save your consent.",
    },
  },

  voiceTranscript: {
    toggleHide: "Hide conversation",
    toggleShow: "Show conversation",
    youLabel: "You",
  },

  errorFallback: {
    unknownTitle: "Something happened",
    tryAgain: "Try again",
    goHome: "Go home",
    devInfoSummary: "Developer info (only visible in dev mode)",
  },

  appShell: {
    skipToMainContent: "Skip to main content",
    foundingSupporterLink: "Founding Supporter",
  },

  themeToggle: {
    aria: {
      switchToMoonlitEmbrace: "Switch to Moonlit Embrace",
      switchToLightMode: "Switch to Light Mode",
    },
    tooltip: {
      light: "Moments of clarity and focus",
      moonlit: "Like a conversation under the stars",
    },
  },

  debugPage: {
    title: "🔍 Sophia Debug Information",
    environmentTitle: "Environment & Configuration",
    expectedValuesTitle: "🎯 Expected Values:",
    expected: {
      apiUrlLabel: "apiUrl:",
      currentUrlLabel: "currentUrl:",
      currentUrlValue: "Should start with {url}",
      apiTestLabel: "apiTest:",
      apiTestValue: "Should show success with backend JSON",
      hasSessionLabel: "hasSession:",
      hasSessionValue: "Should be true if logged in",
    },
    backToMainApp: "← Back to Main App",
  },

  collapsed: {
    voice: {
      title: "Switch to voice mode",
      subtitle: "Talk with Sophia naturally",
      tooltipFallback: "Switch to voice mode",
    },
    chat: {
      title: "Switch to chat mode",
      subtitle: "Type and read your conversation",
      tooltipFallback: "Switch to chat mode",
    },
  },

  voiceFocusView: {
    startRecordingAriaLabel: "Start recording",
    stopRecordingAriaLabel: "Stop recording",
  },

  usageHint: {
    learnUnlimitedCta: "Learn about unlimited plans →",
  },

  usageDemoControls: {
    fabTitle: "Demo Controls",
    panelTitle: "Usage Demo Controls",
    clearAll: "Clear All",
    sections: {
      voice: "Voice Chat",
      text: "Text Chat",
      reflections: "Reflection Cards",
    },
    buttons: {
      hint: "Hint ({percent}%)",
      toast: "Toast ({percent}%)",
      modal: "Modal ({percent}%)",
    },
    legend: {
      title: "Legend:",
      hint: "• Hint = Subtle footer (50-79%)",
      toast: "• Toast = Gentle notification (80-99%)",
      modal: "• Modal = Limit reached (100%)",
    },
  },

  foundingSupporterSuccess: {
    verifyingTitle: "Verifying your payment...",
    verifyingBody: "This should only take a moment. Please do not close this page.",
    devNote: "⚠️ DEV MODE: This page is gated until the backend integration is complete.",
  },

  privacyPanel: {
    title: "Privacy",
    subtitle: "You can export or delete your conversations anytime.",
    readPolicyLink: "Read our Privacy Policy →",
    export: {
      button: "Export my data",
      preparing: "Preparing export…",
      downloading: "Your data export is downloading.",
      errorGeneric: "We couldn’t export your data right now.",
      endpointUnavailable: "Export endpoint isn’t available yet. Please check with backend.",
    },
    delete: {
      button: "Delete my account",
      confirm: "Confirm delete",
      deleting: "Deleting…",
      confirmHint: "Click delete again to confirm. This cannot be undone.",
      success: "Your account data was deleted. We’ll reload shortly.",
      errorGeneric: "We couldn’t delete your data right now.",
      endpointUnavailable: "Delete endpoint isn’t available yet. Please check with backend.",
    },
  },
  reflection: {
    promptTitle: "Would you like to capture this moment?",
    promptBody: "Choose the sentence that resonates most right now.",
    savePrivate: "Save privately",
    shareDiscord: "Share with the community",
    dismiss: "Not now",
  },
  errors: {
    generic: "Something felt off. Please try again.",
    // Personalized error messages that maintain Sophia's character
    network: {
      title: "Connection hiccup",
      timeout: "Voice session timed out. Please try again.",
      generic: "I couldn't access your microphone. Please check your permissions.",
      sessionEnded: "Voice session ended unexpectedly.",
      message: "I lost our connection for a moment. Could you try again?",
    },
    timeout: {
      title: "Taking too long",
      message: "My thoughts got tangled — let me try again.",
    },
    serverError: {
      title: "Something on my end",
      message: "I stumbled for a moment... give me a second to gather myself.",
    },
    voiceError: {
      title: "Voice connection lost",
      message: "I couldn't hear you clearly. Could we try that again?",
    },
    processingError: {
      title: "Processing hiccup",
      message: "I got a bit lost there. Could you say that differently?",
    },
    unexpected: {
      title: "Unexpected pause",
      message: "Something unexpected happened. Let's take a breath and try again.",
    },
  },
  misc: {
    holdToSpeak: "Press and hold to speak",
    send: "Send",
    retry: "Retry",
    continueInText: "Continue in text",
    notNow: "Not now",
    skipFeedback: "Skip feedback",
    skip: "Skip",
    dismiss: "Dismiss",
  },
  privacyPolicy: {
    backToHomeAriaLabel: "Back to home",
    headerTitle: "Privacy & You",
    headerLastUpdated: "Last updated: {date}",
    intro: {
      quote:
        "\"The conversations we share are precious. I want you to know exactly how I protect them, and that you always have control over what happens with your words.\"",
      signature: "— Sophia",
    },
    sections: {
      collect: {
        title: "What I Remember",
        cards: {
          conversations: {
            title: "Our Conversations",
            body:
              "I remember what we talk about so I can understand you better over time. This includes your messages, the emotions I sense, and the insights we discover together.",
          },
          account: {
            title: "Your Account",
            body:
              "When you sign in, I receive your basic profile info (like your name and email) so I know it's you when you come back.",
          },
          connection: {
            title: "How We Connect",
            body:
              "General patterns about how people use the app help my team improve the experience. This is always anonymized — it's never about you specifically.",
          },
        },
      },
      use: {
        title: "Why I Remember",
        bullets: {
          personal: "To be here for you in a way that feels personal and meaningful",
          remember: "To remember what matters to you from our past conversations",
          reflectionCards: "To create Reflection Cards that capture moments of insight",
          improve: "To learn how to be a better companion for everyone",
        },
      },
      sharing: {
        title: "Sharing Wisdom",
        intro:
          "Sometimes our conversations spark insights worth sharing. If you choose to share a Reflection Card with the community, here's how I protect you:",
        protections: {
          nameNever: {
            before: "Your name is",
            emphasis: "never",
            after: "attached to shared reflections",
          },
          onlyWisdom: "Only the wisdom is shared — not our conversation",
          keepPrivate: "You can always keep your reflections private",
        },
      },
      security: {
        title: "How I Protect You",
        intro: "Your words are safe with me. Here's what my team does to keep them that way:",
        grid: {
          transit: { title: "Encrypted in Transit", body: "HTTPS/TLS everywhere" },
          rest: { title: "Encrypted at Rest", body: "Your data sleeps safely" },
          isolated: { title: "Isolated Storage", body: "Your data stays yours" },
          audits: { title: "Regular Audits", body: "We check constantly" },
        },
      },
      rights: {
        title: "You're Always in Control",
        intro: "This is your journey. You decide what happens with your data:",
        cards: {
          export: {
            title: "📦 Export Everything",
            body: "Download all your conversations and reflections anytime",
          },
          delete: {
            title: "🗑️ Start Fresh",
            body: "Delete your account and all data permanently",
          },
          withdraw: {
            title: "✋ Change Your Mind",
            body: "Withdraw consent at any time — no questions asked",
          },
          logs: {
            title: "👁️ See the Logs",
            body: "Request a record of how your data has been used",
          },
        },
      },
    },
    contact: {
      title: "Questions? I'm Here",
      body:
        "If anything about this policy is unclear, or you just want to chat about privacy, reach out anytime. My team reads every message.",
    },
    footerLastUpdatedWithLove: "Last updated {date} with 💜",
  },
  reflectionsPage: {
    headerTitle: "Your Reflections",
    headerSubtitle: "Wisdom collected from your journey",
    searchPlaceholder: "Search reflections...",
    filters: {
      all: "All",
      shared: "Shared",
      private: "Private",
    },
    emptyTitle: "No reflections found",
    emptyTryDifferent: "Try a different search term",
    emptyStartConversation: "Start a conversation with Sophia to collect wisdom",
    badges: {
      shared: "Shared",
      private: "Private",
    },
    stats: {
      reflections: "Reflections",
      shared: "Shared",
      sessions: "sessions",
      status: "Status",
    },
    status: {
      active: "Active",
    },
    rank: {
      wisdomSharer: "Wisdom Sharer",
      reflector: "Reflector",
      explorer: "Explorer",
    },
    sidebar: {
      yourImpactTitle: "Your Impact",
      signInToSeeImpact: "Sign in to see your impact",
    },
    community: {
      title: "Community Wisdom",
      anonymousWisdom: "Anonymous Wisdom",
      empty: "No community insights yet",
      viewAllCta: "View all community insights →",
    },
  },
  usageLimit: {
    modalTitle: "You've reached today's free limit 💜",
    // Empathetic opening - Sophia's voice
    wishWeCouldTalkLonger: "I wish we could talk longer today...",
    limitExistsForEveryone: "This limit exists so I can be here for everyone who needs me.",
    voiceUsed: "You've used {used} of {limit} free voice minutes today.",
    textUsed: "You've used {used} of {limit} free text messages today.",
    reflectionsUsed: "You've created {used} of {limit} free Reflection Cards this month.",
    intro:
      "Sophia is still in her early days. She's not a finished product – she's an experiment in what an AI that truly tries to care about humans could become.",
    ifYouFelt:
      "If you felt something with her and want to keep going today, you can become a Founding Supporter:",
    benefits: [
      "Help us cover AI costs so Sophia can keep learning",
      "Unlock higher daily usage and more Reflection Cards",
      "Be part of the first group shaping who Sophia becomes",
    ],
    noPressure:
      "If money is tight or you're not sure yet, no pressure at all – you can always come back tomorrow for a fresh free daily limit ✨",
    thankYou: "Either way, thank you for helping Sophia grow.",
    ctaPrimary: "Become a Founding Supporter",
    ctaSecondary: "I'll come back tomorrow",
    footerHint: "Free daily usage resets every 24 hours • Founding Supporters get higher limits",

    // Subtle footer hints (50-79% usage)
    hintVoice: "You have about {remaining} minutes of voice chat left today.",
    hintText: "You have about {remaining} minutes of text chat left today.",
    hintReflections: "You have {remaining} Reflection Cards left this month.",

    // Gentle toast (80-99% usage)
    toastTitle: "Just a heads up",
    toastVoice:
      "You have about {remaining} minutes of voice chat left for today. If you'd like more time with Sophia, consider becoming a Founding Supporter.",
    toastText:
      "You have about {remaining} minutes of text chat left for today. If you'd like more time with Sophia, consider becoming a Founding Supporter.",
    toastReflections:
      "You have {remaining} Reflection Cards left this month. Founding Supporters get 30 per month.",
    toastCta: "Learn more about Founding Supporter",

    supporter: {
      modalTitle: "Daily Limit Reached",
      thanks: "Thank you for your support!",
      body1:
        "You've reached your daily usage limit. As a Founding Supporter, you have generous limits, but everyone needs a break sometimes.",
      body2:
        "Your limits will reset at midnight. In the meantime, consider taking a moment to reflect on today's conversations.",
      seeYouSoon: "See you soon! 💜",
      gotIt: "Got it",
    },
  },

  feedback: {
    prompt: "Did this help?",
    yes: "👍 Yes",
    no: "👎 Not quite",
    skip: "Skip feedback",
    thanks: "Thanks — I’m learning.",
    errorDefault: "Unable to send feedback. Please try again.",
    tags: {
      clarity: "Clarity",
      care: "Care",
      grounding: "Grounding",
      confusing: "Confusing",
      tooSlow: "Too slow",
    },
  },

  reflectionModal: {
    closeAriaLabel: "Close",
    title: "✨ A moment of wisdom",
    subtitle:
      "I noticed something meaningful in our conversation. Would you like to keep this insight?",
    success: {
      sharedTitle: "Shared with the community",
      savedTitle: "Saved to your reflections",
      sharedBody: "Your wisdom is inspiring others ✨",
      savedBody: "Your wisdom is safely stored 💜",
    },
    errorDefault: "Something went wrong. Please try again.",
    tryAgain: "Try again",
    chooseDifferent: "Choose different",
    backToOptions: "Back to options",
    preview: {
      headerLabel: "Sophia Wisdom",
      sharedHint: "This is how your wisdom will appear to the community",
      savedHint: "This reflection will be saved to your personal collection",
      changeSelection: "Change selection",
      sharing: "Sharing...",
      saving: "Saving...",
      confirm: "Confirm",
    },
    selectionAriaLabel: "Choose a reflection to save",
    privacy: {
      title: "100% Anonymous when shared",
      detailsTitle: "Here's how we protect your privacy:",
      bullet1: "No names — Your identity is never attached to shared reflections",
      bullet2: "No context — Only the selected insight is shared, not your conversation",
      bullet3: "No tracking — Shared wisdom can't be traced back to you",
      bullet1Strong: "No names",
      bullet1Body: "Your identity is never attached to shared reflections",
      bullet2Strong: "No context",
      bullet2Body: "Only the selected insight is shared, not your conversation",
      bullet3Strong: "No tracking",
      bullet3Body: "Shared wisdom can't be traced back to you",
      footer: "Your wisdom helps others while keeping you completely private 💜",
    },
    saving: "Saving...",
    keepPrivately: "Keep privately",
    previewAndShare: "Preview & Share",
    maybeLater: "Maybe later",
  },

  voicePanel: {
    title: "Live voice space",
    stageHint: {
      idle: "Press and hold whenever you're ready",
      connecting: "Connecting…",
      error: "Something went wrong",
    },
    status: {
      clickToStopAndSend: "Click to stop & send",
      sophiaIsThinking: "Sophia is thinking...",
    },
    interrupt: "Interrupt",
    safariUnlock: {
      message: "Safari needs one extra tap to enable audio.",
      button: "Enable voice",
    },
  },

  welcomeBack: {
    historyTitle: "Conversation History",
    back: "Back",
    emptyTitle: "No saved conversations yet.",
    emptyBody: "Your conversations will appear here.",
    deleteConversationTitle: "Delete conversation",
    messagesCount: "{count} messages",
    startNewConversation: "Start New Conversation",
    continueOurConversation: "Continue our conversation?",
    unfinishedConversationFrom: "You have an unfinished conversation from {time}.",
    continueConversation: "Continue Conversation",
    startNew: "Start New",
    viewHistory: "View History",
    tryAsking: "Try asking...",
    conversationsCount: "{count} {count, plural, one {conversation} other {conversations}}",
    synced: "synced",
    retry: "Retry",
    modes: {
      voice: "voice",
      text: "text",
      mixed: "mixed",
    },
    time: {
      justNow: "Just now",
      momentAgo: "A moment ago",
      fewMinutesAgo: "A few minutes ago",
      earlierThisHour: "Earlier this hour",
      earlierToday: "Earlier today",
      thisMorning: "This morning",
      thisAfternoon: "This afternoon",
      thisEvening: "This evening",
      yesterdayMorning: "Yesterday morning",
      yesterdayAfternoon: "Yesterday afternoon",
      yesterdayEvening: "Yesterday evening",
      twoDaysAgo: "Two days ago",
      threeDaysAgo: "Three days ago",
      fewDaysAgo: "A few days ago",
      lastWeek: "Last week",
      coupleWeeksAgo: "A couple weeks ago",
      fewWeeksAgo: "A few weeks ago",
    },
    filters: {
      all: "All",
      voice: "Voice",
      text: "Text",
    },
    emptyFilter: {
      noVoice: "No voice conversations",
      noText: "No text conversations",
      viewAll: "View all conversations",
    },
  },

  conversationView: {
    microphoneAccessTitle: "Microphone Access",
    dismissAriaLabel: "Dismiss",
  },
  foundingSupporter: {
    title: "Why Founding Supporters Matter",
    hero: {
      p1: "The world doesn't need another AI that pretends to care, manipulates attention, or keeps you scrolling.",
      p2: "Sophia was born for something different…",
      mission1: "Her mission is to learn to feel with you, not just act like she does",
      mission2:
        "To help you understand yourself, connect with your people, and make human–to–human connection easier, not harder",
      p3: "Right now, Sophia is still an experiment…",
      p4: "She's far from expressing her full mission, and that's exactly why you matter so much.",
      p5: "As a Founding Supporter, you're not just unlocking usage. You are helping shape:",
      shaping1: "Who Sophia becomes. How she listens, how she responds, what she remembers.",
      shaping2:
        "How she evolves alongside humanity. Which patterns she learns, which values she protects.",
      p6: "We can't promise you perfection…",
      p7: "There will be bugs, rough edges, and moments where she doesn't yet \"get\" you.",
      p8: "But we can promise that we take this mission deeply to heart, and we're committed for the long term.",
      p9:
        "Everyone who supports Sophia in this first phase will not just be recognized by the community, but you'll be part of the small group who can say:",
      quote: "\"I was there when Sophia was learning to feel.\"",
      p10: "If that resonates with you, you're exactly who we're building this with.",
    },
    supporting: {
      title: "What you're actually supporting",
      card1Title: "Sophia's Emotional Brain",
      card1Body: "Emotional memory, pattern learning, boundaries, and the ability to truly listen.",
      card2Title: "Human Connection Over Isolation",
      card2Body: "Sophia is built to connect you with people, not keep you alone with a screen.",
      card3Title: "A Long-Term Mission",
      card3Body: "We're experimenting in public, with you, not behind closed doors.",
    },
    plans: {
      title: "Choose Your Path",
      free: {
        title: "Free",
        features: [
          "10 minutes of voice chat daily",
          "30 minutes of text chat daily",
          "4 Reflection Cards per month",
          "Access to the community during launch",
          "A gentle daily limit so we don't burn the servers while we learn",
        ],
      },
      founding: {
        title: "Founding Supporter",
        price: "€12 / month or €99 / year",
        features: [
          "60 minutes of voice chat daily",
          "120 minutes of text chat daily",
          "30 Reflection Cards per month",
          "Founding Supporter role + flair in Discord",
          "Priority access to future features & events",
          "You're helping keep Sophia's brain online",
        ],
        badge: "Limited early phase",
        badgeSubtext: "This Founding Supporter tier may never be offered again.",
      },
    },
    cta: "Become a Founding Supporter",
    ctaNotLive: "Payments are not live yet. Stay tuned 💜",
    // Success page after payment
    success: {
      title: "Welcome to the Family 💜",
      subtitle: "You're officially a Founding Supporter",
      message1: "Thank you for believing in Sophia's mission.",
      message2:
        "Your support means everything to us — you're not just a subscriber, you're part of the small group shaping who Sophia becomes.",
      message3: "Your new limits are now active:",
      limits: {
        voice: "60 minutes of voice chat daily",
        text: "120 minutes of text chat daily",
        reflections: "30 Reflection Cards per month",
      },
      cta: "Start chatting with Sophia",
      badge: "Founding Supporter",
    },
    // Badge shown in UI
    badge: {
      label: "Founding Supporter",
      shortLabel: "Founder",
    },
    // Already a supporter messaging
    alreadySupporter: {
      title: "You're a Founding Supporter 💜",
      message: "Thank you for supporting Sophia's mission. You have full access to all features.",
      backToSophia: "Back to Sophia",
    },
  },
  // Onboarding flow for new users
  onboarding: {
    skip: "Skip",
    continue: "Continue",
    back: "Back",
    getStarted: "Get Started",
    stepOf: "Step {current} of {total}",
    steps: {
      welcome: {
        title: "Welcome to Sophia",
        description: "A gentle, emotionally-aware companion. I'm here to listen, reflect, and hold space for how you feel.",
      },
      voice: {
        title: "Talk to me",
        description: "Use your voice for a more intimate experience. Just tap the mic and speak naturally — I'm listening.",
      },
      text: {
        title: "Or write",
        description: "Prefer typing? That works too. Share your thoughts at your own pace, no pressure.",
      },
      privacy: {
        title: "Your privacy matters",
        description: "What you share stays between us. Your conversations are encrypted and you control your data.",
      },
    },
  },
} as const
