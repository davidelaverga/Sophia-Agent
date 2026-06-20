# Auditoria de carga, cache y navegabilidad: /artifacts, /journal y /session

Fecha: 2026-06-17
Produccion auditada: `https://www.sophia-ei.com`
Deployment verificado: `dpl_L7mWiq6ukjFvgpoBjwLrrdSXMdVZ`
Build verificado: `552ba9a1369f3078f55a9251524f1971659f2862`

## Resumen ejecutivo

El deploy UI-only de coherencia visual esta en produccion y ambos dominios (`www.sophia-ei.com` y `sophia-ei.com`) reportan el build `552ba9a1`.

La auditoria posterior encontro tres areas principales:

1. `/journal` puede quedar en un loading indefinido por al menos 12s sin error, retry ni fallback visible.
2. Las tres rutas HTML y sus APIs privadas se sirven con `no-store`; esto es correcto para datos privados, pero hoy tambien fuerza que el shell de pagina sea siempre dinamico.
3. `/session` concentra el mayor peso inicial: ~2.5 MB JS sin gzip en el build local, principalmente por runtime conversacional, voz y artifact canvas.

No se aplicaron fixes de performance/cache/navegacion en esta fase.

## Evidencia capturada

Carpeta: `docs/audits/evidence/load-cache-navigation-2026-06-17/`

| Archivo | Uso |
| --- | --- |
| `mobile-artifacts.png` | `/artifacts` mobile con artifact visible. |
| `desktop-journal.png` | `/journal` desktop en loading. |
| `mobile-journal.png` | `/journal` mobile en loading. |
| `desktop-session.png` | `/session` desktop con modal multi-tab. |
| `mobile-session.png` | `/session` mobile con modal multi-tab. |
| `navigation-readiness.json` | Tiempos de readiness observados desde navegador autenticado. |
| `measurements.json` | Estado visual, consola y evidencia inicial. |
| `desktop-artifacts.png.capture-error.txt` | Limitacion: screenshot desktop de `/artifacts` fallo por timeout CDP aunque la pagina cargo. |

Limitaciones:
- El runtime del navegador integrado no expuso Resource Timing completo, asi que TTFB/FCP/LCP/CLS/TBT no pudieron medirse con precision desde la sesion autenticada.
- No se extrajeron cookies ni secretos para repetir requests autenticados desde shell.
- Los headers de cache de APIs privadas se verificaron sin autenticar; sirven para confirmar politica de cache/status, no latencia real del usuario autenticado.

## Smoke post-deploy

| Ruta | Resultado |
| --- | --- |
| `/artifacts` | Nuevo copy visible en desktop: "Artifacts Sophia creates or saves for you..."; labels `All artifacts`, `Made with Sophia`, `Recently opened`, `Field`, `List`; sin `/mnt/`; sin errores de consola. |
| `/journal` | Nuevo loading copy visible: "Bringing Sophia's saved memories into view."; en la sesion auditada quedo en loading por 12s sin error visible. |
| `/session` | Nuevo modal multi-tab visible: "Sophia is open in another tab", "Return home", "Take over here"; sin errores de consola. |

## Readiness observado

Medicion wall-clock desde navegador autenticado, sin screenshots.

| Viewport | Ruta | DOM listo | UI lista observada | Estado |
| --- | ---: | ---: | ---: | --- |
| Desktop 1440x900 | `/artifacts` | 1084 ms | 2807 ms | OK; copy principal visible. |
| Desktop 1440x900 | `/journal` | 235 ms | No lista despues de 5s; reconfirmado 12s | Loading persistente. |
| Desktop 1440x900 | `/session` | 463 ms | 838 ms | OK; modal multi-tab visible. |
| Mobile 390x844 | `/artifacts` | 790 ms | Copy descriptivo no visible en primer vistazo | Data visible, pero proposito menos claro. |
| Mobile 390x844 | `/journal` | 196 ms | No lista despues de 5s; reconfirmado 12s | Loading persistente. |
| Mobile 390x844 | `/session` | 941 ms | 1323 ms | OK; modal multi-tab visible. |

## Cache observado

Headers publicos/unauthenticated:

| URL | Status | Cache-Control | Vercel cache |
| --- | ---: | --- | --- |
| `/artifacts` | 200 | `no-store, must-revalidate, no-cache, max-age=0, private` | MISS |
| `/journal` | 200 | `no-store, must-revalidate, no-cache, max-age=0, private` | MISS |
| `/session` | 200 | `no-store, must-revalidate, no-cache, max-age=0, private` | MISS |
| `/api/artifacts` | 401 unauth | `no-store, max-age=0` | MISS |
| `/api/journal` | 401 unauth | `no-store, max-age=0` | MISS |
| `/api/app-version` | 200 | `no-store, max-age=0` | MISS |
| `/_next/static/...css` | 200 | `public, max-age=31536000, immutable` | HIT |

Interpretacion:
- Los assets estaticos tienen cache correcto.
- Los datos privados deben permanecer `no-store`.
- Oportunidad: separar shell cacheable o partially static de datos privados client-side para no pagar HTML dinamico completo en cada navegacion.

## Peso de rutas en build local

Fuente: manifests de `.next/server/app/*/page_client-reference-manifest.js` y `.next/static`.

| Ruta | JS inicial sin gzip | CSS sin gzip | Observacion |
| --- | ---: | ---: | --- |
| `/artifacts` | ~729 KB | ~295 KB | Carga renderer WebGL/canvas y UI completa de biblioteca desde el primer paint. |
| `/journal` | ~640 KB | ~288 KB | Carga memoria visual/canvas aunque puede quedar bloqueada en fetch inicial. |
| `/session` | ~2529 KB | ~263 KB | Ruta mas pesada; incluye voz, realtime, artifact canvas/PDF/coreview y paneles secundarios. |

## Mapa tecnico relevante

| Superficie | Archivo / punto | Observacion |
| --- | --- | --- |
| `/artifacts` | `frontend/src/app/components/dashboard/ArtifactLibraryPanel.tsx:162` | Lista global llama `fetchArtifactRegistryList(filters)` al montar. |
| `/artifacts` | `frontend/src/app/lib/artifact-registry.ts:122` | Fetch usa `/api/artifacts` con `cache: 'no-store'`. |
| `/artifacts` | `frontend/src/app/components/dashboard/artifact-observatory-renderer.ts:572` | Inicializa WebGL2 en mount. |
| `/artifacts` | `frontend/src/app/components/dashboard/artifact-observatory-renderer.ts:657` | Usa `requestAnimationFrame` continuo. |
| `/journal` | `frontend/src/app/journal/JournalPageClient.tsx:478` | Fetch inicial `GET /api/journal` con `cache: 'no-store'`. |
| `/journal` | `frontend/src/app/journal/JournalPageClient.tsx:830` | Inicializa WebGL + canvases 2D para memory pool. |
| `/journal` | `frontend/src/app/journal/JournalPageClient.tsx:1544` | Loop de `requestAnimationFrame` para render visual. |
| `/session` | `frontend/src/app/hooks/useStreamVoiceSession.ts:2460` | EventSource/realtime voice path disponible en la ruta. |
| `/session` | `frontend/src/app/hooks/useBuilderCanvas.ts:381` | Snapshot builder canvas usa `cache: 'no-store'`. |
| `/session` | `frontend/src/app/components/session/ArtifactCanvasViewport.tsx:1539` | Preview de artifact hace fetch de contenido. |
| `/session` | `frontend/src/app/components/session/ArtifactPdfPreview.tsx:196` | PDF preview hace fetch de PDF/worker-related path. |

## Hallazgos

### P0: `/journal` no sale de loading ni muestra recuperacion

Problema:
`/journal` permanecio en "Loading journal" por 12s en desktop y mobile, sin error visible ni consola.

Impacto:
El usuario no sabe si la memoria esta vacia, si fallo auth/API, si debe esperar o si puede volver a home.

Recomendacion:
- Agregar timeout UX de 8-10s para separar "still loading" de "unable to load".
- Mostrar retry visible y una explicacion no fatal.
- Registrar duracion y status del fetch de `/api/journal` sin contenido sensible.

Microcopy sugerido:
- Loading extendido: "Still looking for saved memories..."
- Error: "We couldn't load your saved memories. Try again, or return to Sophia."
- Empty real: "No saved memories yet. Memories you keep after sessions will appear here."

Criterio de aceptacion:
- Si `/api/journal` no responde en 10s, la UI muestra accion `Try again`.
- Empty state solo aparece cuando la API responde exitosamente con `entries: []`.
- Error auth/API no se presenta como memoria vacia.

### P1: Cache demasiado global para shells privados

Problema:
Las paginas completas `/artifacts`, `/journal` y `/session` se sirven como `no-store`. Los datos privados deben ser no-store, pero el shell visual/navegacional podria beneficiarse de segmentacion.

Impacto:
Cada navegacion paga HTML dinamico y miss de Vercel, incluso cuando gran parte del shell es estable.

Recomendacion:
- Mantener APIs privadas con `no-store`.
- Evaluar shell server/client split: layout y chrome estables cacheables, datos cargados client-side o server action privada.
- Para `/artifacts` y `/journal`, considerar stale client cache local de ultima respuesta segura por usuario para navegacion instantanea, con revalidacion en background.

Criterio de aceptacion:
- Datos privados siguen sin cache compartida.
- Navegacion back/forward muestra contenido previo inmediatamente y revalida.
- Headers de APIs privadas siguen `no-store`.

### P1: `/session` tiene el mayor peso inicial

Problema:
El build local asocia `/session` con ~2.5 MB JS sin gzip. La ruta incluye runtime de voz, realtime, artifact canvas, PDF preview y coreview aunque el primer vistazo puede ser solo conversacion/modal.

Impacto:
Mayor coste de parse/hydration, especialmente mobile.

Recomendacion:
- Dividir artifact canvas/PDF/coreview en imports dinamicos cargados solo cuando hay artifact seleccionado o panel abierto.
- Diferir telemetry/debug panels hasta interaccion.
- Revisar si voz/realtime debe inicializarse solo despues de intencion explicita o preconnect controlado.

Criterio de aceptacion:
- JS inicial de `/session` baja al menos 30%.
- Empty/conversation shell interactivo antes de cargar artifact/PDF modules.
- No regresion en canvas cuando se abre un artifact.

### P1: Animaciones canvas arrancan antes de confirmar necesidad visual

Problema:
`/artifacts` y `/journal` inicializan WebGL/canvas y loops `requestAnimationFrame` en mount.

Impacto:
CPU/GPU activa aun en estados loading, tabs en background, reduced-motion o mobile de baja potencia.

Recomendacion:
- Gate por `prefers-reduced-motion`, visibilidad de documento e IntersectionObserver.
- Pausar RAF cuando la pagina esta oculta o cuando el panel principal no esta visible.
- En `/journal`, no iniciar memory pool completo hasta tener datos o empty/error decidido.

Criterio de aceptacion:
- RAF pausado en `document.hidden`.
- Reduced motion usa fondo estatico.
- `/journal` loading no activa renderer pesado hasta resolver estado.

### P1: `/artifacts` mobile pierde la promesa de primer vistazo

Problema:
En mobile se ve "Artifact Observatory", search, chips y artifact card, pero el texto descriptivo "Artifacts Sophia creates or saves for you..." no queda visible en el primer viewport. Los chips tambien se cortan horizontalmente.

Impacto:
La pagina funciona, pero el usuario nuevo entiende menos rapido que esta viendo historia global durable.

Recomendacion:
- Mantener una linea compacta de proposito en mobile.
- Cambiar chips a wrap controlado o scroll con affordance clara.
- Reducir decoracion/overlap del mapa estelar cuando una card esta seleccionada.

Microcopy sugerido:
- "Your saved Sophia artifacts, across sessions."

Criterio de aceptacion:
- En 390px, proposito, search y primer artifact no se superponen.
- Filtros muestran affordance horizontal o wrap sin cortar labels importantes.

### P2: Navegacion de regreso/home es inconsistente por superficie

Problema:
`/journal` usa botones `router.push('/')`; `/session` modal usa `Return home`; `/artifacts` prioriza open/download. No hay una regla comun visible de "back to Sophia/home/history".

Impacto:
El usuario puede sentirse en tres productos distintos.

Recomendacion:
- Estandarizar nav rail/header: Home, Session, Journal, Artifacts.
- Usar labels consistentes: "Return home", "Open in canvas", "Download".
- Prefetch de rutas hermanas despues de idle.

Criterio de aceptacion:
- Cada ruta tiene regreso/home claro en desktop y mobile.
- Navegar entre `/session`, `/journal`, `/artifacts` no produce blank/loading innecesario si ya fue visitada.

### P2: Observabilidad de performance insuficiente

Problema:
No hay una forma simple de leer Web Vitals por ruta en produccion desde logs existentes.

Impacto:
Las mejoras futuras dependeran de mediciones manuales.

Recomendacion:
- Activar Vercel Speed Insights o instrumentation propia de Web Vitals por ruta.
- Loggear solo metricas agregadas: route, viewport bucket, LCP, CLS, INP, hydration ready; sin contenido de usuario.

Criterio de aceptacion:
- Dashboard por ruta con p75 LCP/INP/CLS.
- Alertas cuando `/journal` loading >10s o `/api/journal` tarda >5s.

## Backlog priorizado

| Prioridad | Item | Ruta | Riesgo | Criterio de aceptacion |
| --- | --- | --- | --- | --- |
| P0 | Separar loading/error/empty prolongado de journal. | `/journal` | Bajo-medio; UI/state only si no cambia API. | Retry visible tras timeout; empty solo con respuesta exitosa vacia. |
| P1 | Dynamic import para artifact/PDF/coreview panels. | `/session` | Medio; requiere regresion visual de canvas. | JS inicial -30%; artifact canvas abre igual. |
| P1 | Pausar/gatear RAF canvas por visibility/reduced-motion/data-ready. | `/artifacts`, `/journal` | Medio; riesgo visual bajo si fallback estatico. | RAF no corre en hidden/reduced-motion; journal loading no enciende pool. |
| P1 | Cache UX privada: stale local per-user + background revalidate. | `/artifacts`, `/journal` | Medio; cuidar privacidad y logout. | Back/return instantaneo; no cache compartida; clear on logout. |
| P1 | Mobile first-glance cleanup de `/artifacts`. | `/artifacts` | Bajo; CSS/layout. | Proposito visible y chips no ambiguos a 390px. |
| P2 | Prefetch rutas hermanas despues de idle. | Las tres | Bajo. | Transiciones entre superficies mas rapidas sin request storm. |
| P2 | Web Vitals por ruta. | Las tres | Bajo-medio; observabilidad. | p75 LCP/CLS/INP disponible por ruta. |

## Plan de pruebas para fixes futuros

- Lighthouse authenticated o Playwright con estado seguro de login para `/artifacts`, `/journal`, `/session`.
- Mobile 390x844, tablet 768x1024, desktop 1440x900.
- Verificar `prefers-reduced-motion`.
- Verificar tab hidden/visible para RAF pause/resume.
- Unit tests:
  - `/journal` timeout muestra retry, no empty.
  - `/artifacts` mobile mantiene labels visibles.
  - dynamic import no carga PDF/canvas antes de abrir artifact.
- Smoke:
  - artifact open/download siguen usando `/api/artifacts/{artifactId}/content` y `/download`.
  - no raw `/mnt` visible.
  - auth failure muestra login/unauthorized, no empty history.

