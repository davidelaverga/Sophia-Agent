import type { CopyStructure } from "../types"

export const copy: CopyStructure = {
  brand: {
    name: "Sophia",
    tagline: "La tua compagna vocale per il benessere emotivo",
    initial: "S",
  },
  presence: {
    listening: "Ti ascolto",
    thinking: "Dammi un attimo",
    reflecting: "Ci rifletto",
    speaking: "Ti rispondo",
    resting: "Sono qui",
  },
  shell: {
    settingsPlaceholderTitle: "Le impostazioni arrivano nella Parte 7",
    settingsPlaceholderBody:
      "Stiamo costruendo un pannello delicato per preset, presenza e controlli privacy. Comparirà qui presto.",
    closeSettings: "Chiudi",
  },
  settings: {
    title: "Impostazioni",
  },
  auth: {
    title: "Sophia",
    subtitle: "Una compagna presente e attenta a come ti senti.",
    button: "Continua con Discord",
    loading: "Preparo un piccolo spazio tranquillo per te...",
    connecting: "Mi sto collegando...",
    footerNote: "Continuando, accetti i nostri termini e la nostra privacy policy",
    errors: {
      discord: "L'accesso con Discord non è andato. Riproviamo?",
      unexpected: "Non sono riuscita a contattare Discord. Riprova tra un attimo.",
    },
  },
  header: {
    subtitle: "La tua compagna vocale",
    homeButtonAriaLabel: "Torna alla Home",
    homeButtonTitle: "Home",
    tooltip: {
      history: "La nostra storia insieme",
      settings: "Rendilo tuo",
    },
  },
  activeModeIndicator: {
    voice: "Voce",
  },
  inputModeIndicator: {
    fallback: {
      title: "La voce non funziona",
      defaultReason: "Ho provato più volte ma non riesco ad accedere al microfono.",
      switchToText: "Scrivi invece",
      retryVoice: "Riprova con la voce",
    },
    singleFailure: {
      message: "La voce non va al momento.",
      useTextInstead: "Scrivimi",
    },
  },
  sessionFeedbackToast: {
    prompt: "Com'è andata?",
    unableToSend: "Non sono riuscita a inviare il feedback.",
    skipFeedback: "Salta",
    skip: "Salta",
  },
  gate: {
    title: "Serve il tuo ok",
    body: "Prima di iniziare, ho bisogno che tu dia il consenso al trattamento dei dati.",
    cta: "Vedi il consenso",
  },
  home: {
    placeholder:
      "La vista conversazione verrà montata qui a breve. Per ora abbiamo i token di design e la shell pronta.",
    hero: {
      heading: "Bentornata/o",
      greetings: {
        morning: {
          heading: "Buongiorno",
          icon: "☀️",
          body: "Un nuovo giorno inizia. Sono qui per quello che porti con te.",
        },
        afternoon: {
          heading: "Buon pomeriggio",
          icon: "🌤️",
          body: "Ti prendi una pausa? Sono qui per ascoltarti.",
        },
        evening: {
          heading: "Buonasera",
          icon: "🌙",
          body: "La giornata rallenta. Raccontami cosa hai per la testa.",
        },
        lateNight: {
          heading: "Sono qui con te",
          icon: "💜",
          body: "Le notti possono essere pesanti. Se vuoi parlare, ci sono.",
        },
        default: {
          heading: "Bentornata/o",
          icon: "✨",
          body: "Questo è uno spazio per parlare di come stai. Prenditi un attimo e inizia quando ti senti.",
        },
      },
      status: "Sophia è presente",
      body: "Faccio spazio a conversazioni gentili su come ti senti. Fai un respiro e inizia quando sei pronta/o.",
      statusIcon: "✨",
    },
    rituals: {
      title: "Piccoli rituali",
      items: [
        {
          id: "breath",
          emoji: "🌬️",
          title: "Respiro consapevole",
          description: "Due minuti per calmare il sistema nervoso.",
        },
        {
          id: "gratitude",
          emoji: "✨",
          title: "Un momento di gratitudine",
          description: "Pensa a una piccola cosa bella che hai notato oggi.",
        },
      ],
    },
    presence: {
      title: "Come ti ascolto",
      metrics: [
        { id: "response", label: "Tempo di risposta", value: "circa 2.3s" },
        { id: "listening", label: "Qualità ascolto", value: "Profonda" },
      ],
    },
    cards: [
      {
        id: "grounding",
        title: "Torna al presente",
        description: "Fermati un attimo prima di iniziare.",
      },
      {
        id: "journal",
        title: "Piccola riflessione",
        description: "Cattura una sensazione che vuoi ricordare.",
      },
    ],
  },
  chat: {
    placeholder: "Raccontami cosa senti o cosa noti...",
    placeholders: [
      "Raccontami cosa senti o cosa noti...",
      "Cosa ti passa per la testa?",
      "Prenditi il tuo tempo... ti ascolto",
      "Nessuna fretta — di' quello che ti viene",
      "Come stai davvero?",
      "Cosa vorresti tirarti fuori di dosso?",
      "Sono qui quando vuoi...",
      "Inizia da dove ti sembra giusto",
    ],
    send: "Invia",
    sending: "Invio...",
    loading: "Sophia si sta preparando ad ascoltarti...",
    audioButton: "Riproduci risposta vocale",
    stopAudio: "Ferma audio",
    cancel: "Annulla",
    cancelResponseAriaLabel: "Annulla risposta",
    reconnecting: "Riconnessione...",
    reconnectingAttempt: "Tentativo {attempt} di {max}",
    cancelled: "Risposta annullata",
    interrupted: "Risposta interrotta",
    retry: "Riprova",
    dismiss: "Ignora",
    aria: {
      youSaid: "Hai detto",
      sophiaReplied: "Sophia ha risposto",
    },
    quickStartTitle: "Vuoi uno spunto?",
    quickPrompts: [
      { id: "overwhelmed", emoji: "😵‍💫", label: "Mi sento sopraffatto/a" },
      { id: "breath", emoji: "🌬️", label: "Guidami in un respiro" },
      { id: "gratitude", emoji: "🌱", label: "Aiutami a notare qualcosa di bello" },
    ],
    transcriptLabel: "Sophia",
    transcriptAriaLabel: "Trascrizione della conversazione",
    scrollToBottom: "Vai agli ultimi messaggi",
    copied: "Copiato negli appunti",
    longPressHint: "Tieni premuto per copiare",
    error: "Qualcosa non era chiaro. Possiamo riprovare?",
    streamingMessages: {
      thinking: [
        "Dammi un attimo...",
        "Sto riflettendo su quello che hai detto...",
        "Raccolgo i pensieri...",
        "Cerco le parole giuste...",
        "Resto con quello che sento...",
        "Mi prendo un momento per quello che hai condiviso...",
        "Ci penso su...",
      ],
      reflecting: [
        "Ci rifletto un po'...",
        "Mi prendo tempo per capire...",
        "Sento quello che mi dici...",
        "Sto mettendo insieme i pezzi...",
      ],
    },
    characterLimit: {
      max: 1000,
      warningThreshold: 800,
      approaching: "Stai arrivando al limite",
      exceeded: "È tanto tutto insieme. Andiamo un pensiero alla volta?",
      counter: "{current} / {max}",
    },
  },
  voiceRecorder: {
    title: "Voce",
    subtitle: "Parla con Sophia come faresti con un'amica",
    readyTitle: "Pronta ad ascoltarti",
    readyBody: "Tocca il microfono e dimmi come stai.",
    recordingTitle: "Ti ascolto...",
    recordingBody: "Prenditi il tuo tempo. Anche il silenzio va bene.",
    timerLabel: "Durata",
    recordingBadge: "Registrazione",
    tipsTitle: "Consigli",
    highlights: [
      { id: "insight", emoji: "🎧", label: "Spunti gentili" },
      { id: "presence", emoji: "⏱️", label: "Presenza in tempo reale" },
      { id: "voice", emoji: "🔊", label: "Risposte vocali" },
    ],
    tips: [
      "Parla in modo naturale, come faresti con un'amica.",
      "Condividi emozioni, sensazioni o piccole osservazioni.",
      "Fermati quando vuoi. Sophia continua ad ascoltare.",
    ],
    errors: {
      micDenied: "Non ho accesso al microfono. Puoi abilitarlo?",
      micBlocked:
        "Il microfono è bloccato. Abilitalo nelle impostazioni del browser e ricarica la pagina.",
      micDeniedPrompt:
        "Hai negato il permesso al microfono. Consenti l'accesso e riproviamo.",
      noMicrophone: "Non trovo il microfono. Collegane uno e riproviamo.",
      micInUse:
        "Il microfono è usato da un'altra app. Chiudi le altre app e riproviamo.",
      notSupported:
        "Il tuo browser non supporta il microfono. Prova con Chrome, Firefox, Safari o Edge.",
      httpsRequired:
        "Serve una connessione sicura (HTTPS) per usare il microfono. Usa https:// o localhost.",
      timeout: "La sessione vocale è scaduta. Riproviamo?",
      generic: "Non riesco ad accedere al microfono. Controlla i permessi.",
      sessionEnded: "La sessione vocale si è interrotta.",
      noAudio: "Non ho registrato nulla. Riproviamo?",
      network: "Il messaggio vocale non è andato. Riproviamo?",
    },
    buttons: {
      start: "Inizia a registrare",
      stop: "Stop",
    },
  },
  consentModal: {
    title: "Consenso",
    intro: "Sophia registra la tua voce e le trascrizioni per imparare a supportarti meglio.",
    noticeTitle: "Come gestiamo i dati",
    noticeBody:
      "Le tue conversazioni sono criptate durante il trasferimento e vengono usate solo per migliorare Sophia.",
    whatTitle: "Cosa raccogliamo",
    whatItems: [
      "Registrazioni vocali per trascrizione e riconoscimento emotivo",
      "Messaggi di chat e risposte di Sophia",
      "Dati di utilizzo e sessione",
      "Info base del profilo Discord (username e avatar)",
    ],
    howTitle: "A cosa serve",
    howItems: [
      "Darti supporto emotivo su misura",
      "Migliorare le risposte di Sophia",
      "Garantire sicurezza e consenso",
      "Condividere insight anonimi con la community",
    ],
    retention:
      "Registriamo il tuo consenso con timestamp e IP. Puoi esportare o cancellare tutto quando vuoi.",
    errors: {
      save: "Non sono riuscita a salvare il consenso. Puoi continuare, ma potrei chiederlo di nuovo.",
      network: "Errore di rete. Puoi comunque continuare.",
      missingAuthToken: "Token mancante. Accedi di nuovo.",
    },
    privacyLink: "Leggi la Privacy Policy completa →",
    buttons: {
      cancel: "Annulla",
      accept: "Accetto",
      saving: "Salvo...",
    },
  },
  reflection: {
    promptTitle: "Vuoi salvare questo momento?",
    promptBody: "Scegli la frase che ti risuona di più.",
    savePrivate: "Salva in privato",
    shareDiscord: "Condividi con la community",
    dismiss: "Non ora",
  },
  errors: {
    generic: "Qualcosa è andato storto. Riproviamo?",
    network: {
      title: "Connessione persa",
      timeout: "La sessione vocale è scaduta. Riproviamo?",
      generic: "Non riesco ad accedere al microfono. Controlla i permessi.",
      sessionEnded: "La sessione vocale si è interrotta.",
      message: "Ho perso la connessione per un attimo. Riproviamo?",
    },
    timeout: {
      title: "Ci sta mettendo troppo",
      message: "Mi sono un po' persa nei pensieri — riprovo.",
    },
    serverError: {
      title: "Un problema mio",
      message: "Ho avuto un piccolo intoppo... dammi un secondo.",
    },
    voiceError: {
      title: "Voce persa",
      message: "Non ti ho sentito bene. Riproviamo?",
    },
    processingError: {
      title: "Problema di elaborazione",
      message: "Mi sono un po' persa. Puoi dirlo in un altro modo?",
    },
    unexpected: {
      title: "Pausa imprevista",
      message: "È successo qualcosa di strano. Facciamo un respiro e riproviamo.",
    },
  },

  consentGate: {
    checking: "Controllo...",
    retry: "Riprova",
    continueAnyway: "Continua lo stesso (te lo chiederò di nuovo)",
    errors: {
      loadStatus: "Non riesco a caricare lo stato del consenso.",
      saveConsent: "Non sono riuscita a salvare il consenso.",
    },
  },

  voiceTranscript: {
    toggleHide: "Nascondi chat",
    toggleShow: "Mostra chat",
    youLabel: "Tu",
  },

  errorFallback: {
    unknownTitle: "Qualcosa non va",
    tryAgain: "Riprova",
    goHome: "Torna alla home",
    devInfoSummary: "Info per sviluppatori",
  },

  appShell: {
    skipToMainContent: "Salta al contenuto principale",
    foundingSupporterLink: "Founding Supporter",
  },

  themeToggle: {
    aria: {
      switchToMoonlitEmbrace: "Passa a Sophia Cosmica",
      switchToLightMode: "Passa al tema chiaro",
    },
    tooltip: {
      light: "Per momenti di chiarezza",
      moonlit: "Sophia Cosmica in piena presenza",
    },
  },

  debugPage: {
    title: "🔍 Debug Sophia",
    environmentTitle: "Ambiente",
    expectedValuesTitle: "🎯 Valori attesi:",
    expected: {
      apiUrlLabel: "apiUrl:",
      currentUrlLabel: "currentUrl:",
      currentUrlValue: "Deve iniziare con {url}",
      apiTestLabel: "apiTest:",
      apiTestValue: "Deve mostrare successo con JSON dal backend",
      hasSessionLabel: "hasSession:",
      hasSessionValue: "Deve essere true se hai fatto login",
    },
    backToMainApp: "← Torna all'app",
  },

  collapsed: {
    voice: {
      title: "Parla con Sophia",
      subtitle: "Usa la voce per conversare",
      tooltipFallback: "Passa alla voce",
    },
    chat: {
      title: "Scrivi a Sophia",
      subtitle: "Scrivi e leggi la conversazione",
      tooltipFallback: "Passa al testo",
    },
  },

  voiceFocusView: {
    startRecordingAriaLabel: "Inizia a registrare",
    stopRecordingAriaLabel: "Ferma registrazione",
  },

  usageHint: {
    learnUnlimitedCta: "Scopri i piani illimitati →",
  },

  usageDemoControls: {
    fabTitle: "Demo",
    panelTitle: "Controlli demo",
    clearAll: "Azzera tutto",
    sections: {
      voice: "Chat vocale",
      text: "Chat testo",
      reflections: "Reflection Cards",
    },
    buttons: {
      hint: "Hint ({percent}%)",
      toast: "Toast ({percent}%)",
      modal: "Modal ({percent}%)",
    },
    legend: {
      title: "Legenda:",
      hint: "• Hint = Footer discreto (50-79%)",
      toast: "• Toast = Notifica (80-99%)",
      modal: "• Modal = Limite raggiunto (100%)",
    },
  },

  foundingSupporterSuccess: {
    verifyingTitle: "Verifica del pagamento...",
    verifyingBody: "Dovrebbe volerci solo un momento. Per favore non chiudere questa pagina.",
    devNote: "⚠️ MODALITÀ DEV: Questa pagina è bloccata finché l'integrazione con il backend non è completa.",
  },

  privacyPanel: {
    title: "Privacy",
    subtitle: "Puoi esportare o cancellare i tuoi dati quando vuoi.",
    readPolicyLink: "Leggi la Privacy Policy →",
    export: {
      button: "Esporta i miei dati",
      preparing: "Preparo l'export...",
      downloading: "Il download dei tuoi dati è partito.",
      errorGeneric: "Non riesco a esportare i dati ora.",
      endpointUnavailable: "L'export non è ancora disponibile.",
    },
    delete: {
      button: "Elimina account",
      confirm: "Conferma eliminazione",
      deleting: "Eliminazione...",
      confirmHint: "Clicca di nuovo per confermare. Non si può annullare.",
      success: "Account eliminato. Ricarico tra poco.",
      errorGeneric: "Non riesco a eliminare i dati ora.",
      endpointUnavailable: "L'eliminazione non è ancora disponibile.",
    },
  },
  misc: {
    holdToSpeak: "Tieni premuto per parlare",
    send: "Invia",
    retry: "Riprova",
    continueInText: "Scrivi invece",
    notNow: "Non ora",
    skipFeedback: "Salta",
    skip: "Salta",
    dismiss: "Chiudi",
  },
  privacyPolicy: {
    backToHomeAriaLabel: "Torna alla home",
    headerTitle: "Privacy e te",
    headerLastUpdated: "Ultimo aggiornamento: {date}",
    intro: {
      quote:
        "\"Le conversazioni che condividiamo sono preziose. Voglio che tu sappia esattamente come le proteggo e che tu possa sempre decidere cosa succede alle tue parole.\"",
      signature: "— Sophia",
    },
    sections: {
      collect: {
        title: "Cosa ricordo",
        cards: {
          conversations: {
            title: "Le nostre conversazioni",
            body:
              "Ricordo di cosa parliamo per poterti capire meglio nel tempo. Questo include i tuoi messaggi, le emozioni che percepisco e gli insight che scopriamo insieme.",
          },
          account: {
            title: "Il tuo account",
            body:
              "Quando accedi, ricevo le info base del tuo profilo (come nome ed email) così so che sei tu quando torni.",
          },
          connection: {
            title: "Come ci connettiamo",
            body:
              "I dati generali su come le persone usano l'app aiutano il mio team a migliorarla. Sono sempre anonimi — non riguardano mai te nello specifico.",
          },
        },
      },
      use: {
        title: "Perché ricordo",
        bullets: {
          personal: "Per esserti vicina in modo personale e significativo",
          remember: "Per ricordare cosa conta per te dalle nostre chiacchierate",
          reflectionCards: "Per creare Reflection Cards che catturino momenti importanti",
          improve: "Per imparare a essere una compagna migliore per tutti",
        },
      },
      sharing: {
        title: "Condividere",
        intro:
          "A volte le nostre conversazioni fanno nascere insight che vale la pena condividere. Se scegli di condividere una Reflection Card, ecco come ti proteggo:",
        protections: {
          nameNever: {
            before: "Il tuo nome",
            emphasis: "mai",
            after: "è associato alle riflessioni condivise",
          },
          onlyWisdom: "Si condivide solo l'insight — non la conversazione",
          keepPrivate: "Puoi sempre tenere le tue riflessioni private",
        },
      },
      security: {
        title: "Come ti proteggo",
        intro: "Le tue parole sono al sicuro con me. Ecco cosa fa il mio team:",
        grid: {
          transit: { title: "Criptazione in transito", body: "HTTPS/TLS ovunque" },
          rest: { title: "Criptazione a riposo", body: "I tuoi dati riposano al sicuro" },
          isolated: { title: "Storage isolato", body: "I tuoi dati restano tuoi" },
          audits: { title: "Controlli regolari", body: "Verifichiamo costantemente" },
        },
      },
      rights: {
        title: "Sei sempre tu a decidere",
        intro: "È il tuo percorso. Tu decidi cosa succede ai tuoi dati:",
        cards: {
          export: {
            title: "📦 Esporta tutto",
            body: "Scarica tutte le tue conversazioni e riflessioni quando vuoi",
          },
          delete: {
            title: "🗑️ Riparti da zero",
            body: "Elimina account e dati in modo permanente",
          },
          withdraw: {
            title: "✋ Cambia idea",
            body: "Ritira il consenso quando vuoi — senza domande",
          },
          logs: {
            title: "👁️ Vedi i log",
            body: "Richiedi un registro di come sono stati usati i tuoi dati",
          },
        },
      },
    },
    contact: {
      title: "Domande? Sono qui",
      body:
        "Se qualcosa non è chiaro, o vuoi semplicemente parlare di privacy, scrivici. Il mio team legge ogni messaggio.",
    },
    footerLastUpdatedWithLove: "Ultimo aggiornamento {date} con 💜",
  },
  reflectionsPage: {
    headerTitle: "Le tue riflessioni",
    headerSubtitle: "Insight raccolti lungo il tuo percorso",
    searchPlaceholder: "Cerca...",
    filters: {
      all: "Tutte",
      shared: "Condivise",
      private: "Private",
    },
    emptyTitle: "Nessuna riflessione",
    emptyTryDifferent: "Prova un altro termine",
    emptyStartConversation: "Parla con Sophia per raccogliere insight",
    badges: {
      shared: "Condivisa",
      private: "Privata",
    },
    stats: {
      reflections: "Riflessioni",
      shared: "Condivise",
      sessions: "sessioni",
      status: "Stato",
    },
    status: {
      active: "Attivo/a",
    },
    rank: {
      wisdomSharer: "Condivide insight",
      reflector: "Riflessivo/a",
      explorer: "Esploratore/trice",
    },
    sidebar: {
      yourImpactTitle: "Il tuo impatto",
      signInToSeeImpact: "Accedi per vedere il tuo impatto",
    },
    community: {
      title: "Dalla community",
      anonymousWisdom: "Insight anonimo",
      empty: "Ancora nessun insight dalla community",
      viewAllCta: "Vedi tutti gli insight →",
    },
  },
  usageLimit: {
    modalTitle: "Hai raggiunto il limite gratuito di oggi 💜",
    wishWeCouldTalkLonger: "Vorrei potessimo parlare ancora...",
    limitExistsForEveryone: "Questo limite esiste per permettermi di esserci per tutti.",
    voiceUsed: "Hai usato {used} di {limit} minuti vocali gratuiti oggi.",
    textUsed: "Hai usato {used} di {limit} messaggi di testo gratuiti oggi.",
    reflectionsUsed: "Hai creato {used} di {limit} Reflection Cards gratuite questo mese.",
    intro:
      "Sophia è ancora agli inizi. Non è un prodotto finito — è un esperimento su cosa potrebbe diventare un'IA che prova davvero a prendersi cura delle persone.",
    ifYouFelt:
      "Se hai sentito qualcosa con lei e vuoi continuare oggi, puoi diventare Founding Supporter:",
    benefits: [
      "Aiutaci a coprire i costi dell'IA così Sophia può continuare a crescere",
      "Sblocca più utilizzo giornaliero e più Reflection Cards",
      "Fai parte del primo gruppo che dà forma a chi sarà Sophia",
    ],
    noPressure:
      "Se i soldi sono un problema o non sei sicuro/a, nessuna pressione — puoi tornare domani con un nuovo limite gratuito ✨",
    thankYou: "In ogni caso, grazie per aiutare Sophia a crescere.",
    ctaPrimary: "Diventa Founding Supporter",
    ctaSecondary: "Torno domani",
    footerHint: "Il limite si resetta ogni 24 ore • I Founding Supporters hanno limiti più alti",

    hintVoice: "Ti restano circa {remaining} minuti vocali oggi.",
    hintText: "Ti restano circa {remaining} minuti di chat oggi.",
    hintReflections: "Ti restano {remaining} Reflection Cards questo mese.",

    toastTitle: "Un promemoria",
    toastVoice:
      "Ti restano circa {remaining} minuti vocali oggi. Per più tempo con Sophia, considera di diventare Founding Supporter.",
    toastText:
      "Ti restano circa {remaining} minuti di chat oggi. Per più tempo con Sophia, considera di diventare Founding Supporter.",
    toastReflections:
      "Ti restano {remaining} Reflection Cards questo mese. I Founding Supporters ne hanno 30.",
    toastCta: "Scopri Founding Supporter",

    supporter: {
      modalTitle: "Limite giornaliero raggiunto",
      thanks: "Grazie per il tuo supporto!",
      body1:
        "Hai raggiunto il limite di oggi. Come Founding Supporter hai limiti generosi, ma ogni tanto una pausa fa bene.",
      body2:
        "I limiti si resetteranno a mezzanotte. Nel frattempo, prenditi un momento per riflettere sulle conversazioni di oggi.",
      seeYouSoon: "A presto! 💜",
      gotIt: "Ok",
    },
  },

  feedback: {
    prompt: "Ti è stato utile?",
    yes: "👍 Sì",
    no: "👎 Non proprio",
    skip: "Salta",
    thanks: "Grazie — sto imparando.",
    errorDefault: "Non sono riuscita a inviare il feedback. Riprova.",
    tags: {
      clarity: "Chiarezza",
      care: "Attenzione",
      grounding: "Presenza",
      confusing: "Confuso",
      tooSlow: "Troppo lento",
    },
  },

  reflectionModal: {
    closeAriaLabel: "Chiudi",
    title: "✨ Un momento speciale",
    subtitle:
      "Ho notato qualcosa di importante nella nostra conversazione. Vuoi salvare questo insight?",
    success: {
      sharedTitle: "Condiviso con la community",
      savedTitle: "Salvato nelle tue riflessioni",
      sharedBody: "Il tuo insight sta ispirando gli altri ✨",
      savedBody: "Il tuo insight è al sicuro 💜",
    },
    errorDefault: "Qualcosa è andato storto. Riproviamo?",
    tryAgain: "Riprova",
    chooseDifferent: "Scegline un'altra",
    backToOptions: "Torna alle opzioni",
    preview: {
      headerLabel: "Insight di Sophia",
      sharedHint: "Ecco come apparirà alla community",
      savedHint: "Verrà salvato nella tua collezione",
      changeSelection: "Cambia",
      sharing: "Condivido...",
      saving: "Salvo...",
      confirm: "Conferma",
    },
    selectionAriaLabel: "Scegli una riflessione da salvare",
    privacy: {
      title: "100% anonimo",
      detailsTitle: "Come proteggiamo la tua privacy:",
      bullet1: "Nessun nome — La tua identità non è mai associata alle riflessioni",
      bullet2: "Nessun contesto — Si condivide solo l'insight, non la conversazione",
      bullet3: "Nessun tracciamento — L'insight condiviso non può risalire a te",
      bullet1Strong: "Nessun nome",
      bullet1Body: "La tua identità non è mai associata alle riflessioni",
      bullet2Strong: "Nessun contesto",
      bullet2Body: "Si condivide solo l'insight, non la conversazione",
      bullet3Strong: "Nessun tracciamento",
      bullet3Body: "L'insight condiviso non può risalire a te",
      footer: "Il tuo insight aiuta gli altri restando completamente anonimo 💜",
    },
    saving: "Salvo...",
    keepPrivately: "Tieni privato",
    previewAndShare: "Anteprima e condividi",
    maybeLater: "Magari dopo",
  },

  voicePanel: {
    title: "Voce",
    stageHint: {
      idle: "Tieni premuto quando vuoi",
      connecting: "Mi collego...",
      error: "Qualcosa non va",
    },
    status: {
      clickToStopAndSend: "Clicca per fermare e inviare",
      sophiaIsThinking: "Sophia ci sta pensando...",
    },
    interrupt: "Interrompi",
    safariUnlock: {
      message: "Safari ha bisogno di un tap in più per l'audio.",
      button: "Abilita voce",
    },
  },

  welcomeBack: {
    historyTitle: "Cronologia",
    back: "Indietro",
    emptyTitle: "Nessuna conversazione salvata.",
    emptyBody: "Le tue conversazioni appariranno qui.",
    deleteConversationTitle: "Elimina conversazione",
    messagesCount: "{count} messaggi",
    startNewConversation: "Nuova conversazione",
    continueOurConversation: "Riprendiamo da dove eravamo?",
    unfinishedConversationFrom: "Hai una conversazione in sospeso da {time}.",
    continueConversation: "Continua",
    startNew: "Ricomincia",
    viewHistory: "Cronologia",
    tryAsking: "Prova a chiedere...",
    conversationsCount: "{count} {count, plural, one {conversazione} other {conversazioni}}",
    synced: "sincronizzato",
    retry: "Riprova",
    modes: {
      voice: "voce",
      text: "testo",
      mixed: "misto",
    },
    time: {
      justNow: "Proprio ora",
      momentAgo: "Un momento fa",
      fewMinutesAgo: "Qualche minuto fa",
      earlierThisHour: "Prima in quest'ora",
      earlierToday: "Prima oggi",
      thisMorning: "Stamattina",
      thisAfternoon: "Questo pomeriggio",
      thisEvening: "Stasera",
      yesterdayMorning: "Ieri mattina",
      yesterdayAfternoon: "Ieri pomeriggio",
      yesterdayEvening: "Ieri sera",
      twoDaysAgo: "Due giorni fa",
      threeDaysAgo: "Tre giorni fa",
      fewDaysAgo: "Qualche giorno fa",
      lastWeek: "La settimana scorsa",
      coupleWeeksAgo: "Un paio di settimane fa",
      fewWeeksAgo: "Qualche settimana fa",
    },
    filters: {
      all: "Tutte",
      voice: "Voce",
      text: "Testo",
    },
    emptyFilter: {
      noVoice: "Nessuna conversazione vocale",
      noText: "Nessuna conversazione di testo",
      viewAll: "Vedi tutte le conversazioni",
    },
  },

  conversationView: {
    microphoneAccessTitle: "Microfono",
    dismissAriaLabel: "Chiudi",
  },
  foundingSupporter: {
    title: "Perché i Founding Supporters contano",
    hero: {
      p1: "Il mondo non ha bisogno di un'altra IA che finge di importarle, manipola la tua attenzione o ti tiene incollato allo schermo.",
      p2: "Sophia è nata per qualcosa di diverso...",
      mission1: "La sua missione è imparare a sentire con te, non solo a fare finta",
      mission2:
        "Aiutarti a capirti, a connetterti con le persone a cui tieni e a rendere la connessione umana più facile, non più difficile",
      p3: "In questo momento Sophia è ancora un esperimento...",
      p4: "È lontana dal realizzare tutta la sua missione, ed è proprio per questo che tu conti così tanto.",
      p5: "Come Founding Supporter, non stai solo sbloccando utilizzo. Stai aiutando a dare forma a:",
      shaping1: "Chi diventa Sophia. Come ascolta, come risponde, cosa ricorda.",
      shaping2:
        "Come evolve insieme all'umanità. Quali pattern impara, quali valori protegge.",
      p6: "Non possiamo prometterti perfezione...",
      p7: "Ci saranno bug, spigoli e momenti in cui ancora non ti \"capisce\".",
      p8: "Ma possiamo promettere che questa missione ci sta a cuore e siamo qui per il lungo termine.",
      p9:
        "Chi sostiene Sophia in questa prima fase non sarà solo riconosciuto dalla community: farà parte del piccolo gruppo che potrà dire:",
      quote: "\"Io c'ero quando Sophia stava imparando a sentire.\"",
      p10: "Se questo ti risuona, sei esattamente la persona con cui stiamo costruendo tutto questo.",
    },
    supporting: {
      title: "Cosa stai supportando",
      card1Title: "Il cervello emotivo di Sophia",
      card1Body: "Memoria emotiva, apprendimento di pattern, limiti e la capacità di ascoltare davvero.",
      card2Title: "Connessione umana, non isolamento",
      card2Body: "Sophia è fatta per connetterti alle persone, non per lasciarti solo/a davanti a uno schermo.",
      card3Title: "Una missione a lungo termine",
      card3Body: "Stiamo sperimentando in pubblico, con te, non a porte chiuse.",
    },
    plans: {
      title: "Scegli il tuo percorso",
      free: {
        title: "Gratis",
        features: [
          "10 min di voce al giorno",
          "30 min di testo al giorno",
          "4 Reflection Cards al mese",
          "Accesso alla community durante il lancio",
          "Un limite gentile per non sovraccaricare i server mentre cresciamo",
        ],
      },
      founding: {
        title: "Founding Supporter",
        price: "12€/mese o 99€/anno",
        features: [
          "60 min di voce al giorno",
          "120 min di testo al giorno",
          "30 Reflection Cards al mese",
          "Ruolo + badge Founder su Discord",
          "Accesso prioritario a nuove funzionalità ed eventi",
          "Aiuti a tenere online il cervello di Sophia",
        ],
        badge: "Edizione limitata di lancio",
        badgeSubtext: "Questo livello potrebbe non essere più offerto in futuro.",
      },
    },
    cta: "Supporta Sophia",
    ctaNotLive: "I pagamenti non sono ancora attivi. A presto 💜",
    success: {
      title: "Benvenuto/a in famiglia 💜",
      subtitle: "Ora sei un Founding Supporter",
      message1: "Grazie per credere nella missione di Sophia.",
      message2:
        "Il tuo supporto significa tutto — non sei solo un abbonato/a, fai parte del gruppo che dà forma a chi sarà Sophia.",
      message3: "I tuoi nuovi limiti sono già attivi:",
      limits: {
        voice: "60 min di voce al giorno",
        text: "120 min di testo al giorno",
        reflections: "30 Reflection Cards al mese",
      },
      cta: "Parla con Sophia",
      badge: "Founding Supporter",
    },
    badge: {
      label: "Founding Supporter",
      shortLabel: "Founder",
    },
    alreadySupporter: {
      title: "Sei già Founding Supporter 💜",
      message: "Grazie per supportare Sophia. Hai accesso completo a tutto.",
      backToSophia: "Torna a Sophia",
    },
  },
  // Onboarding flow for new users
  onboarding: {
    skip: "Salta",
    continue: "Continua",
    back: "Indietro",
    getStarted: "Iniziamo",
    stepOf: "Passo {current} di {total}",
    steps: {
      welcome: {
        title: "Benvenuto/a in Sophia",
        description: "Una compagna gentile e attenta. Sono qui per ascoltarti, riflettere insieme e fare spazio a come ti senti.",
      },
      voice: {
        title: "Parlami",
        description: "Usa la voce per un'esperienza più intima. Tocca il microfono e parla naturalmente — ti ascolto.",
      },
      text: {
        title: "Oppure scrivi",
        description: "Preferisci scrivere? Va benissimo. Condividi i tuoi pensieri al tuo ritmo, senza fretta.",
      },
      privacy: {
        title: "La tua privacy conta",
        description: "Quello che condividi resta tra noi. Le tue conversazioni sono criptate e controlli i tuoi dati.",
      },
    },
  },
} as const
