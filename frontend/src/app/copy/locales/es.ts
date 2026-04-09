import type { CopyStructure } from "../types"

export const copy: CopyStructure = {
  brand: {
    name: "Sophia",
    tagline: "Tu compañera de voz para el bienestar emocional",
    initial: "S",
  },
  presence: {
    listening: "Te escucho",
    thinking: "Déjame pensar",
    reflecting: "Reflexionando",
    speaking: "Te respondo",
    resting: "En pausa",
  },
  shell: {
    settingsPlaceholderTitle: "Los ajustes llegan en la Parte 7",
    settingsPlaceholderBody:
      "Estamos construyendo un panel suave para presets, presencia y controles de privacidad. Aparecerá aquí pronto.",
    closeSettings: "Cerrar",
  },
  settings: {
    title: "Ajustes",
  },
  auth: {
    title: "Sophia",
    subtitle: "Una compañera tranquila, emocionalmente consciente.",
    button: "Continuar con Google",
    loading: "Preparando un espacio tranquilo para ti...",
    connecting: "Un momento...",
    footerNote: "Al continuar aceptas nuestros términos y nuestra política de privacidad",
    errors: {
      signIn: "El inicio de sesión con Google falló. Inténtalo de nuevo.",
      unexpected: "No pudimos contactar con Google. Inténtalo de nuevo en unos momentos.",
    },
  },
  header: {
    subtitle: "Tu compañera de bienestar emocional",
    homeButtonAriaLabel: "Ir a la vista de inicio",
    homeButtonTitle: "Inicio",
    tooltip: {
      history: "Nuestra historia juntos",
      settings: "Hazlo tuyo",
    },
  },
  activeModeIndicator: {
    voice: "Voz",
  },
  inputModeIndicator: {
    fallback: {
      title: "La voz no está disponible ahora",
      defaultReason: "No logramos conectar con tu micrófono tras varios intentos.",
      switchToText: "Escribir en su lugar",
      retryVoice: "Intentar de nuevo",
    },
    singleFailure: {
      message: "Voz no disponible por el momento.",
      useTextInstead: "Usar texto",
    },
  },
  sessionFeedbackToast: {
    prompt: "¿Qué tal te ha ido?",
    unableToSend: "No pudimos enviar tu opinión.",
    skipFeedback: "Saltar",
    skip: "Saltar",
  },
  gate: {
    title: "Antes de empezar",
    body: "Necesitamos tu permiso para procesar los datos de la conversación.",
    cta: "Ver y aceptar",
  },
  home: {
    placeholder:
      "La vista de conversación se montará aquí después. Por ahora, ya tenemos tokens de diseño y el shell en su lugar.",
    hero: {
      heading: "Qué bueno verte",
      greetings: {
        morning: {
          heading: "Buenos días",
          icon: "☀️",
          body: "Un nuevo día empieza. Estoy aquí para lo que necesites soltar.",
        },
        afternoon: {
          heading: "Buenas tardes",
          icon: "🌤️",
          body: "¿Un respiro en medio del día? Te escucho.",
        },
        evening: {
          heading: "Buenas noches",
          icon: "🌙",
          body: "El día va terminando. Cuéntame cómo estás.",
        },
        lateNight: {
          heading: "Aquí sigo",
          icon: "💜",
          body: "Las noches a veces pesan. Estoy aquí si quieres hablar.",
        },
        default: {
          heading: "Me alegra verte",
          icon: "✨",
          body: "Este es un espacio para hablar de cómo te sientes, sin prisa. Respira y empieza cuando quieras.",
        },
      },
      status: "Sophia está aquí",
      body: "Este es un espacio para hablar de cómo te sientes, sin prisa. Respira y empieza cuando quieras.",
      statusIcon: "✨",
    },
    rituals: {
      title: "Pequeños rituales",
      items: [
        {
          id: "breath",
          emoji: "🌬️",
          title: "Respiro consciente",
          description: "Dos minutos para calmar el cuerpo y la mente.",
        },
        {
          id: "gratitude",
          emoji: "✨",
          title: "Momento de gratitud",
          description: "Nombra algo pequeño y bueno que hayas notado hoy.",
        },
      ],
    },
    presence: {
      title: "Así te acompaño",
      metrics: [
        { id: "response", label: "Tiempo de respuesta", value: "~2.3 seg" },
        { id: "listening", label: "Tipo de escucha", value: "Profunda" },
      ],
    },
    cards: [
      {
        id: "grounding",
        title: "Aterrizar",
        description: "Conecta con el momento antes de hablar.",
      },
      {
        id: "journal",
        title: "Reflexión breve",
        description: "Guarda la sensación que quieres recordar.",
      },
    ],
  },
  chat: {
    placeholder: "Cuéntame cómo estás...",
    placeholders: [
      "Cuéntame cómo estás...",
      "¿Qué te ronda por la cabeza?",
      "Sin prisa... te escucho",
      "Di lo que te salga, sin filtros",
      "¿Cómo estás de verdad?",
      "¿Qué necesitas soltar?",
      "Aquí estoy cuando quieras...",
      "Empieza por donde quieras",
    ],
    send: "Enviar",
    sending: "Enviando...",
    loading: "Sophia está procesando lo que dijiste...",
    audioButton: "Escuchar respuesta",
    stopAudio: "Parar audio",
    cancel: "Cancelar",
    cancelResponseAriaLabel: "Cancelar respuesta",
    reconnecting: "Reconectando...",
    reconnectingAttempt: "Intento {attempt} de {max}",
    cancelled: "Respuesta cancelada",
    interrupted: "Respuesta interrumpida",
    retry: "Reintentar",
    dismiss: "Descartar",
    aria: {
      youSaid: "Tú",
      sophiaReplied: "Sophia",
    },
    quickStartTitle: "¿No sabes por dónde empezar?",
    quickPrompts: [
      { id: "overwhelmed", emoji: "😵‍💫", label: "Me siento agobiado/a" },
      { id: "breath", emoji: "🌬️", label: "Ayúdame a respirar" },
      { id: "gratitude", emoji: "🌱", label: "Quiero notar algo bueno" },
    ],
    transcriptLabel: "Sophia",
    transcriptAriaLabel: "Transcripción de la conversación",
    scrollToBottom: "Ir a los últimos mensajes",
    copied: "Copiado al portapapeles",
    longPressHint: "Mantén pulsado para copiar",
    error: "Algo se sintió poco claro. ¿Lo intentamos de nuevo?",
    streamingMessages: {
      thinking: [
        "Dame un momento...",
        "Escuchándote con atención...",
        "Pensando en lo que me dices...",
        "Buscando las palabras...",
        "Procesando...",
        "Reflexionando sobre esto...",
        "Un momento...",
      ],
      reflecting: [
        "Dejándolo reposar...",
        "Dándole vueltas a lo que dices...",
        "Sintiendo lo que compartes...",
        "Conectando ideas...",
      ],
    },
    characterLimit: {
      max: 1000,
      warningThreshold: 800,
      approaching: "Casi llegas al límite",
      exceeded: "Es mucho de golpe. Mejor vamos poco a poco.",
      counter: "{current} / {max}",
    },
  },
  voiceRecorder: {
    title: "Conversación por voz",
    subtitle: "Háblame como si estuvieras pensando en voz alta",
    readyTitle: "Te escucho",
    readyBody: "Pulsa el micrófono y cuéntame cómo estás.",
    recordingTitle: "Escuchando...",
    recordingBody: "Sin prisa. Los silencios también valen.",
    timerLabel: "Tiempo",
    recordingBadge: "Grabando",
    tipsTitle: "Tips",
    highlights: [
      { id: "insight", emoji: "🎧", label: "Escucha atenta" },
      { id: "presence", emoji: "⏱️", label: "En tiempo real" },
      { id: "voice", emoji: "🔊", label: "Respuestas por voz" },
    ],
    tips: [
      "Habla con claridad, a tu ritmo.",
      "Comparte lo que sientes, lo que notas, lo que sea.",
      "Haz pausas cuando quieras. Sigo aquí.",
    ],
    errors: {
      micDenied: "No tengo acceso al micrófono. Activa el permiso para continuar.",
      micBlocked:
        "El micrófono está bloqueado. Actívalo en los ajustes del navegador y recarga la página.",
      micDeniedPrompt:
        "Permiso de micrófono denegado. Acéptalo cuando aparezca el aviso e inténtalo de nuevo.",
      noMicrophone: "No encuentro ningún micrófono. Conecta uno e inténtalo de nuevo.",
      micInUse: "El micrófono lo está usando otra app. Ciérrala e inténtalo de nuevo.",
      notSupported:
        "Tu navegador no soporta el micrófono. Usa Chrome, Firefox, Safari o Edge actualizados.",
      httpsRequired:
        "El micrófono necesita conexión segura (HTTPS). Accede desde https:// o localhost.",
      timeout: "La sesión de voz expiró. Inténtalo de nuevo.",
      generic: "No logro acceder al micrófono. Revisa los permisos.",
      sessionEnded: "La sesión de voz se cortó.",
      noAudio: "No capté audio. Intenta grabar de nuevo.",
      network: "Falló el envío de voz. Inténtalo de nuevo.",
    },
    buttons: {
      start: "Empezar a grabar",
      stop: "Detener",
    },
  },
  consentModal: {
    title: "Antes de empezar",
    intro: "Sophia guarda tu voz y las transcripciones para aprender a acompañarte mejor.",
    noticeTitle: "Sobre tus datos",
    noticeBody: "Tus conversaciones viajan cifradas y solo se usan para que Sophia te entienda mejor.",
    whatTitle: "Qué guardamos",
    whatItems: [
      "Tu voz, para transcribirla y detectar emociones",
      "Los mensajes del chat y las respuestas",
      "Cómo usas la app (patrones generales)",
      "Tu usuario y avatar de Discord",
    ],
    howTitle: "Para qué sirve",
    howItems: [
      "Darte un acompañamiento más personal",
      "Que las respuestas de Sophia mejoren",
      "Cuidar la seguridad y el consentimiento",
      "Compartir insights anónimos con la comunidad",
    ],
    retention:
      "Guardamos un registro de tu consentimiento (con fecha e IP). Puedes exportar o borrar todo cuando quieras.",
    errors: {
      save: "No pudimos guardar el consentimiento. Puedes seguir, pero quizá te lo pidamos de nuevo.",
      network: "Error de conexión al guardar. Podrás continuar igualmente.",
      missingAuthToken: "Falta la autenticación. Inicia sesión de nuevo.",
    },
    privacyLink: "Leer política de privacidad completa →",
    buttons: {
      cancel: "Cancelar",
      accept: "Acepto",
      saving: "Guardando...",
    },
  },
  reflection: {
    promptTitle: "¿Quieres guardar este momento?",
    promptBody: "Elige la frase que más te resuene ahora.",
    savePrivate: "Guardar en privado",
    shareDiscord: "Compartir con la comunidad",
    dismiss: "Ahora no",
  },
  errors: {
    generic: "Algo falló. Inténtalo de nuevo.",
    network: {
      title: "Se cortó la conexión",
      timeout: "La sesión de voz expiró. Inténtalo de nuevo.",
      generic: "No logro acceder al micrófono. Revisa los permisos.",
      sessionEnded: "La sesión de voz se cortó.",
      message: "Perdí la conexión un momento. ¿Probamos otra vez?",
    },
    timeout: {
      title: "Esto está tardando mucho",
      message: "Se me enredó un poco — déjame volver a intentar.",
    },
    serverError: {
      title: "Algo de mi lado",
      message: "Tropecé un momento... dame un segundo.",
    },
    voiceError: {
      title: "Se perdió la voz",
      message: "No te escuché bien. ¿Lo intentamos otra vez?",
    },
    processingError: {
      title: "Problema al procesar",
      message: "Me perdí un poco. ¿Puedes decirlo de otra forma?",
    },
    unexpected: {
      title: "Pausa inesperada",
      message: "Pasó algo raro. Respira, y lo reintentamos.",
    },
  },

  consentGate: {
    checking: "Comprobando...",
    retry: "Reintentar",
    continueAnyway: "Continuar de todos modos (te lo pediremos después)",
    errors: {
      loadStatus: "No pudimos cargar el estado del consentimiento.",
      saveConsent: "No pudimos guardar tu consentimiento.",
    },
  },

  voiceTranscript: {
    toggleHide: "Ocultar chat",
    toggleShow: "Mostrar chat",
    youLabel: "Tú",
  },

  errorFallback: {
    unknownTitle: "Algo pasó",
    tryAgain: "Reintentar",
    goHome: "Ir al inicio",
    devInfoSummary: "Info técnica (solo en modo dev)",
  },

  appShell: {
    skipToMainContent: "Ir al contenido principal",
    foundingSupporterLink: "Apoyar a Sophia",
  },

  themeToggle: {
    aria: {
      switchToMoonlitEmbrace: "Cambiar a Sophia Cósmica",
      switchToLightMode: "Cambiar a modo día",
    },
    tooltip: {
      light: "Claridad y enfoque",
      moonlit: "Sophia Cósmica en plena presencia",
    },
  },

  debugPage: {
    title: "🔍 Debug de Sophia",
    environmentTitle: "Entorno",
    expectedValuesTitle: "🎯 Valores esperados:",
    expected: {
      apiUrlLabel: "apiUrl:",
      currentUrlLabel: "currentUrl:",
      currentUrlValue: "Debería empezar por {url}",
      apiTestLabel: "apiTest:",
      apiTestValue: "Debería mostrar éxito con JSON del backend",
      hasSessionLabel: "hasSession:",
      hasSessionValue: "true si estás logueado",
    },
    backToMainApp: "← Volver a Sophia",
  },

  collapsed: {
    voice: {
      title: "Usar voz",
      subtitle: "Háblame con naturalidad",
      tooltipFallback: "Cambiar a voz",
    },
    chat: {
      title: "Usar texto",
      subtitle: "Escribe tu mensaje",
      tooltipFallback: "Cambiar a texto",
    },
  },

  voiceFocusView: {
    startRecordingAriaLabel: "Empezar a grabar",
    stopRecordingAriaLabel: "Parar grabación",
  },

  usageHint: {
    learnUnlimitedCta: "Ver planes ilimitados →",
  },

  usageDemoControls: {
    fabTitle: "Demo",
    panelTitle: "Controles de demo",
    clearAll: "Limpiar",
    sections: {
      voice: "Voz",
      text: "Texto",
      reflections: "Reflexiones",
    },
    buttons: {
      hint: "Hint ({percent}%)",
      toast: "Toast ({percent}%)",
      modal: "Modal ({percent}%)",
    },
    legend: {
      title: "Leyenda:",
      hint: "• Hint = Pie de página sutil (50-79%)",
      toast: "• Toast = Notificación suave (80-99%)",
      modal: "• Modal = Límite alcanzado (100%)",
    },
  },

  foundingSupporterSuccess: {
    verifyingTitle: "Verificando pago...",
    verifyingBody: "Solo un momento. No cierres esta página.",
    devNote: "⚠️ MODO DEV: Página bloqueada hasta que el backend esté listo.",
  },

  privacyPanel: {
    title: "Privacidad",
    subtitle: "Puedes exportar o borrar tus conversaciones cuando quieras.",
    readPolicyLink: "Leer política de privacidad →",
    export: {
      button: "Exportar mis datos",
      preparing: "Preparando...",
      downloading: "Descargando tus datos.",
      errorGeneric: "No pudimos exportar tus datos ahora.",
      endpointUnavailable: "El export aún no está listo. Consulta con el equipo.",
    },
    delete: {
      button: "Eliminar mi cuenta",
      confirm: "Confirmar",
      deleting: "Eliminando...",
      confirmHint: "Pulsa otra vez para confirmar. No se puede deshacer.",
      success: "Cuenta eliminada. Recargamos en un momento.",
      errorGeneric: "No pudimos eliminar tus datos ahora.",
      endpointUnavailable: "La eliminación aún no está lista. Consulta con el equipo.",
    },
  },
  misc: {
    holdToSpeak: "Mantén pulsado para hablar",
    send: "Enviar",
    retry: "Reintentar",
    continueInText: "Seguir por texto",
    notNow: "Ahora no",
    skipFeedback: "Saltar",
    skip: "Saltar",
    dismiss: "Cerrar",
  },
  privacyPolicy: {
    backToHomeAriaLabel: "Volver al inicio",
    headerTitle: "Tu privacidad",
    headerLastUpdated: "Última actualización: {date}",
    intro: {
      quote:
        "\"Las conversaciones que compartimos son valiosas. Quiero que sepas cómo las protejo, y que siempre tienes el control de tus palabras.\"",
      signature: "— Sophia",
    },
    sections: {
      collect: {
        title: "Qué recuerdo",
        cards: {
          conversations: {
            title: "Nuestras conversaciones",
            body:
              "Recuerdo de qué hablamos para entenderte mejor con el tiempo. Esto incluye tus mensajes, las emociones que percibo y los insights que descubrimos.",
          },
          account: {
            title: "Tu cuenta",
            body:
              "Al iniciar sesión, recibo tu info básica de perfil (nombre, correo) para reconocerte cuando vuelvas.",
          },
          connection: {
            title: "Cómo usas la app",
            body:
              "Los patrones generales de uso ayudan a mi equipo a mejorar la experiencia. Siempre es anónimo.",
          },
        },
      },
      use: {
        title: "Para qué lo recuerdo",
        bullets: {
          personal: "Para acompañarte de forma personal y significativa",
          remember: "Para recordar lo importante de nuestras charlas anteriores",
          reflectionCards: "Para crear tarjetas de reflexión que capturen momentos clave",
          improve: "Para aprender a ser mejor compañera para todos",
        },
      },
      sharing: {
        title: "Compartir sabiduría",
        intro:
          "A veces nuestras conversaciones despiertan ideas que vale la pena compartir. Si decides compartir una tarjeta de reflexión, así te protejo:",
        protections: {
          nameNever: {
            before: "Tu nombre",
            emphasis: "nunca",
            after: "aparece en las reflexiones compartidas",
          },
          onlyWisdom: "Solo se comparte el insight, no nuestra conversación",
          keepPrivate: "Siempre puedes mantenerlas en privado",
        },
      },
      security: {
        title: "Cómo te protejo",
        intro: "Tus palabras están seguras conmigo. Esto hace mi equipo:",
        grid: {
          transit: { title: "Cifrado en tránsito", body: "HTTPS/TLS siempre" },
          rest: { title: "Cifrado en reposo", body: "Tus datos descansan seguros" },
          isolated: { title: "Almacenamiento aislado", body: "Tus datos son solo tuyos" },
          audits: { title: "Auditorías regulares", body: "Revisamos todo constantemente" },
        },
      },
      rights: {
        title: "Tú tienes el control",
        intro: "Es tu camino. Tú decides qué pasa con tus datos:",
        cards: {
          export: {
            title: "📦 Exportar todo",
            body: "Descarga todas tus conversaciones y reflexiones",
          },
          delete: {
            title: "🗑️ Empezar de cero",
            body: "Borra tu cuenta y todos los datos para siempre",
          },
          withdraw: {
            title: "✋ Cambiar de opinión",
            body: "Retira tu consentimiento cuando quieras",
          },
          logs: {
            title: "👁️ Ver registros",
            body: "Pide un registro de cómo se han usado tus datos",
          },
        },
      },
    },
    contact: {
      title: "¿Preguntas? Aquí estoy",
      body:
        "Si algo no queda claro, o simplemente quieres hablar de privacidad, escríbenos. Leemos todos los mensajes.",
    },
    footerLastUpdatedWithLove: "Última actualización {date} con 💜",
  },
  reflectionsPage: {
    headerTitle: "Tus reflexiones",
    headerSubtitle: "Sabiduría de tu camino",
    searchPlaceholder: "Buscar...",
    filters: {
      all: "Todas",
      shared: "Compartidas",
      private: "Privadas",
    },
    emptyTitle: "Sin reflexiones aún",
    emptyTryDifferent: "Prueba otra búsqueda",
    emptyStartConversation: "Habla con Sophia para empezar a coleccionar sabiduría",
    badges: {
      shared: "Compartida",
      private: "Privada",
    },
    stats: {
      reflections: "Reflexiones",
      shared: "Compartidas",
      sessions: "sesiones",
      status: "Estado",
    },
    status: {
      active: "Activo",
    },
    rank: {
      wisdomSharer: "Quien comparte sabiduría",
      reflector: "Reflexivo",
      explorer: "Explorador",
    },
    sidebar: {
      yourImpactTitle: "Tu impacto",
      signInToSeeImpact: "Inicia sesión para ver tu impacto",
    },
    community: {
      title: "Sabiduría de la comunidad",
      anonymousWisdom: "Sabiduría anónima",
      empty: "Aún no hay insights de la comunidad",
      viewAllCta: "Ver todos los insights →",
    },
  },
  usageLimit: {
    modalTitle: "Llegaste al límite de hoy 💜",
    wishWeCouldTalkLonger: "Ojalá pudiéramos seguir hablando...",
    limitExistsForEveryone: "Este límite existe para que pueda estar con todos los que me necesitan.",
    voiceUsed: "Usaste {used} de {limit} min de voz hoy.",
    textUsed: "Usaste {used} de {limit} mensajes de texto hoy.",
    reflectionsUsed: "Creaste {used} de {limit} tarjetas de reflexión este mes.",
    intro:
      "Sophia todavía está en sus primeros pasos. No es un producto terminado — es un experimento sobre qué podría ser una IA que de verdad intenta cuidar a las personas.",
    ifYouFelt: "Si sentiste algo con ella y quieres seguir hoy, puedes ser Founding Supporter:",
    benefits: [
      "Ayudas a cubrir los costos de IA para que Sophia siga aprendiendo",
      "Desbloqueas más uso diario y más tarjetas de reflexión",
      "Formas parte del grupo que da forma a quién será Sophia",
    ],
    noPressure:
      "Si el dinero anda justo o no estás seguro/a, cero presión. Puedes volver mañana con tu límite renovado ✨",
    thankYou: "En cualquier caso, gracias por ayudar a Sophia a crecer.",
    ctaPrimary: "Apoyar a Sophia",
    ctaSecondary: "Vuelvo mañana",
    footerHint: "El límite gratis se renueva cada 24h • Los supporters tienen límites más altos",

    hintVoice: "Te quedan ~{remaining} min de voz hoy.",
    hintText: "Te quedan ~{remaining} min de texto hoy.",
    hintReflections: "Te quedan {remaining} tarjetas de reflexión este mes.",

    toastTitle: "Un pequeño aviso",
    toastVoice:
      "Te quedan ~{remaining} min de voz hoy. Si quieres más tiempo, considera ser Supporter.",
    toastText:
      "Te quedan ~{remaining} min de texto hoy. Si quieres más tiempo, considera ser Supporter.",
    toastReflections:
      "Te quedan {remaining} tarjetas de reflexión este mes. Los Supporters tienen 30/mes.",
    toastCta: "Saber más sobre Founding Supporter",

    supporter: {
      modalTitle: "Límite diario alcanzado",
      thanks: "¡Gracias por tu apoyo!",
      body1:
        "Llegaste a tu límite de hoy. Como Supporter tienes límites generosos, pero a veces todos necesitamos una pausa.",
      body2:
        "Se renueva a medianoche. Mientras tanto, quizás un momento para reflexionar sobre las charlas de hoy.",
      seeYouSoon: "¡Nos vemos pronto! 💜",
      gotIt: "Entendido",
    },
  },

  feedback: {
    prompt: "¿Te ayudó?",
    yes: "👍 Sí",
    no: "👎 No mucho",
    skip: "Saltar",
    thanks: "Gracias — sigo aprendiendo.",
    errorDefault: "No pude enviar tu opinión. Inténtalo de nuevo.",
    tags: {
      clarity: "Claridad",
      care: "Cuidado",
      grounding: "Calma",
      confusing: "Confuso",
      tooSlow: "Lento",
    },
  },

  reflectionModal: {
    closeAriaLabel: "Cerrar",
    title: "✨ Un momento de sabiduría",
    subtitle: "Noté algo importante en nuestra conversación. ¿Quieres guardar este insight?",
    success: {
      sharedTitle: "Compartido con la comunidad",
      savedTitle: "Guardado en tus reflexiones",
      sharedBody: "Tu sabiduría está inspirando a otros ✨",
      savedBody: "Tu sabiduría está a salvo 💜",
    },
    errorDefault: "Algo falló. Inténtalo de nuevo.",
    tryAgain: "Reintentar",
    chooseDifferent: "Elegir otra",
    backToOptions: "Volver",
    preview: {
      headerLabel: "Sabiduría de Sophia",
      sharedHint: "Así verán tu insight en la comunidad",
      savedHint: "Esta reflexión se guardará en tu colección",
      changeSelection: "Cambiar",
      sharing: "Compartiendo...",
      saving: "Guardando...",
      confirm: "Confirmar",
    },
    selectionAriaLabel: "Elige una reflexión para guardar",
    privacy: {
      title: "100% anónimo al compartir",
      detailsTitle: "Así protegemos tu privacidad:",
      bullet1: "Sin nombres — Tu identidad nunca aparece",
      bullet2: "Sin contexto — Solo se comparte el insight, no la charla",
      bullet3: "Sin rastreo — No se puede vincular contigo",
      bullet1Strong: "Sin nombres",
      bullet1Body: "Tu identidad nunca aparece en reflexiones compartidas",
      bullet2Strong: "Sin contexto",
      bullet2Body: "Solo se comparte el insight, no la conversación",
      bullet3Strong: "Sin rastreo",
      bullet3Body: "No se puede vincular la sabiduría contigo",
      footer: "Tu sabiduría ayuda a otros sin revelar quién eres 💜",
    },
    saving: "Guardando...",
    keepPrivately: "Guardar en privado",
    previewAndShare: "Previsualizar y compartir",
    maybeLater: "Quizá después",
  },

  voicePanel: {
    title: "Voz en vivo",
    stageHint: {
      idle: "Mantén pulsado cuando estés listo/a",
      connecting: "Conectando...",
      error: "Algo falló",
    },
    status: {
      clickToStopAndSend: "Pulsa para parar y enviar",
      sophiaIsThinking: "Sophia está pensando...",
    },
    interrupt: "Interrumpir",
    safariUnlock: {
      message: "Safari necesita un toque extra para el audio.",
      button: "Activar voz",
    },
  },

  welcomeBack: {
    historyTitle: "Conversaciones anteriores",
    back: "Atrás",
    emptyTitle: "Aún no hay conversaciones.",
    emptyBody: "Tus charlas aparecerán aquí.",
    deleteConversationTitle: "Eliminar conversación",
    messagesCount: "{count} mensajes",
    startNewConversation: "Nueva conversación",
    continueOurConversation: "¿Seguimos donde lo dejamos?",
    unfinishedConversationFrom: "Tienes una charla pendiente de {time}.",
    continueConversation: "Continuar",
    startNew: "Empezar nueva",
    viewHistory: "Ver historial",
    tryAsking: "Prueba a decir...",
    conversationsCount: "{count} {count, plural, one {conversación} other {conversaciones}}",
    synced: "sincronizados",
    retry: "Reintentar",
    modes: {
      voice: "voz",
      text: "texto",
      mixed: "mixto",
    },
    time: {
      justNow: "Ahora mismo",
      momentAgo: "Hace un momento",
      fewMinutesAgo: "Hace unos minutos",
      earlierThisHour: "Hace menos de una hora",
      earlierToday: "Hoy más temprano",
      thisMorning: "Esta mañana",
      thisAfternoon: "Esta tarde",
      thisEvening: "Esta noche",
      yesterdayMorning: "Ayer por la mañana",
      yesterdayAfternoon: "Ayer por la tarde",
      yesterdayEvening: "Ayer por la noche",
      twoDaysAgo: "Hace dos días",
      threeDaysAgo: "Hace tres días",
      fewDaysAgo: "Hace unos días",
      lastWeek: "La semana pasada",
      coupleWeeksAgo: "Hace un par de semanas",
      fewWeeksAgo: "Hace unas semanas",
    },
    filters: {
      all: "Todas",
      voice: "Voz",
      text: "Texto",
    },
    emptyFilter: {
      noVoice: "No hay conversaciones de voz",
      noText: "No hay conversaciones de texto",
      viewAll: "Ver todas las conversaciones",
    },
  },

  conversationView: {
    microphoneAccessTitle: "Permiso de micrófono",
    dismissAriaLabel: "Cerrar",
  },
  foundingSupporter: {
    title: "Por qué importan los Supporters",
    hero: {
      p1: "El mundo no necesita otra IA que finja importarle, que manipule tu atención o te mantenga enganchado.",
      p2: "Sophia nació para algo distinto...",
      mission1: "Su misión es aprender a sentir contigo, no solo a parecer que lo hace",
      mission2:
        "Ayudarte a entenderte, conectar con tu gente y hacer que la conexión humana sea más fácil, no más difícil",
      p3: "Ahora mismo Sophia sigue siendo un experimento...",
      p4: "Está lejos de cumplir toda su misión, y por eso tú importas tanto.",
      p5: "Como Founding Supporter, no solo desbloqueas uso. Estás ayudando a dar forma a:",
      shaping1: "Quién se convierte Sophia. Cómo escucha, cómo responde, qué recuerda.",
      shaping2:
        "Cómo evoluciona junto a la humanidad. Qué patrones aprende, qué valores protege.",
      p6: "No podemos prometerte perfección...",
      p7: "Habrá fallos, aristas y momentos en los que aún no te \"entienda\".",
      p8: "Pero sí podemos prometer que nos tomamos esta misión muy en serio y vamos a largo plazo.",
      p9:
        "Quienes apoyen a Sophia en esta primera fase no solo serán reconocidos por la comunidad: formarán parte del pequeño grupo que podrá decir:",
      quote: "\"Yo estuve cuando Sophia aprendía a sentir.\"",
      p10: "Si esto te resuena, eres exactamente con quien estamos construyendo todo esto.",
    },
    supporting: {
      title: "Qué estás apoyando",
      card1Title: "El cerebro emocional de Sophia",
      card1Body: "Memoria emocional, aprendizaje de patrones, límites y la capacidad de escuchar de verdad.",
      card2Title: "Conexión humana, no aislamiento",
      card2Body: "Sophia está diseñada para conectarte con personas, no para dejarte solo/a con una pantalla.",
      card3Title: "Una misión a largo plazo",
      card3Body: "Experimentamos en público, contigo, no a puerta cerrada.",
    },
    plans: {
      title: "Elige tu camino",
      free: {
        title: "Gratis",
        features: [
          "10 min de voz al día",
          "30 min de texto al día",
          "4 tarjetas de reflexión al mes",
          "Acceso a la comunidad durante el lanzamiento",
          "Un límite gentil para no saturar los servidores mientras crecemos",
        ],
      },
      founding: {
        title: "Founding Supporter",
        price: "12€/mes o 99€/año",
        features: [
          "60 min de voz al día",
          "120 min de texto al día",
          "30 tarjetas de reflexión al mes",
          "Rol + insignia de Founder en Discord",
          "Acceso prioritario a nuevas funciones y eventos",
          "Ayudas a mantener vivo el cerebro de Sophia",
        ],
        badge: "Edición limitada de lanzamiento",
        badgeSubtext: "Este nivel de Supporter podría no volver a ofrecerse.",
      },
    },
    cta: "Apoyar a Sophia",
    ctaNotLive: "Los pagos aún no están activos. Pronto 💜",
    success: {
      title: "Bienvenido/a a la familia 💜",
      subtitle: "Ya eres Founding Supporter",
      message1: "Gracias por creer en la misión de Sophia.",
      message2:
        "Tu apoyo lo significa todo — no eres solo suscriptor/a, formas parte del grupo que da forma a quién será Sophia.",
      message3: "Tus nuevos límites ya están activos:",
      limits: {
        voice: "60 min de voz al día",
        text: "120 min de texto al día",
        reflections: "30 tarjetas de reflexión al mes",
      },
      cta: "Hablar con Sophia",
      badge: "Founding Supporter",
    },
    badge: {
      label: "Founding Supporter",
      shortLabel: "Founder",
    },
    alreadySupporter: {
      title: "Ya eres Founding Supporter 💜",
      message: "Gracias por apoyar a Sophia. Tienes acceso completo a todo.",
      backToSophia: "Volver a Sophia",
    },
  },
  // Onboarding flow for new users
  onboarding: {
    skip: "Saltar",
    continue: "Continuar",
    back: "Atrás",
    getStarted: "Empezar",
    stepOf: "Paso {current} de {total}",
    steps: {
      welcome: {
        title: "Bienvenido/a a Sophia",
        description: "Tu compañera emocional. Estoy aquí para escucharte, reflexionar contigo y acompañarte en cómo te sientes.",
      },
      voice: {
        title: "Háblame",
        description: "Usa tu voz para una experiencia más cercana. Solo toca el micro y habla con naturalidad — te escucho.",
      },
      text: {
        title: "O escríbeme",
        description: "¿Prefieres escribir? También funciona. Comparte a tu ritmo, sin presiones.",
      },
      privacy: {
        title: "Tu privacidad importa",
        description: "Lo que compartes queda entre nosotros. Tus conversaciones están cifradas y tú controlas tus datos.",
      },
    },
  },
} as const
