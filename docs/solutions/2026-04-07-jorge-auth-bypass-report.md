# Reporte para Jorge: bypass temporal del flujo de auth

Fecha: 2026-04-07

## Resumen ejecutivo

Ahora mismo el frontend tiene un bypass de autenticacion activo para desarrollo. Eso significa que, fuera de `production`, la app puede comportarse como si hubiera un usuario autenticado sin pasar por Better Auth ni por Discord.

La identidad real que usa el frontend en este workspace no es una cuenta externa real. Es una identidad sintetica con estos datos:

- `id`: `dev-user`
- `email`: `dev@localhost`
- `name`: `Dev User`

Ese `id` no sale de Discord ni de Better Auth en el flujo actual de desarrollo. Sale de la variable de entorno `NEXT_PUBLIC_SOPHIA_USER_ID` definida en `frontend/.env`.

## Estado exacto hoy

### 1. El bypass esta encendido localmente

En `frontend/.env` tenemos:

```env
NEXT_PUBLIC_DEV_BYPASS_AUTH=true
NEXT_PUBLIC_SOPHIA_USER_ID=dev-user
```

Ademas, el codigo lo deja activado por defecto en cualquier entorno que no sea `production`, salvo que se fuerce explicitamente `NEXT_PUBLIC_DEV_BYPASS_AUTH=false`.

## 2. La identidad efectiva actual es `dev-user`

Aunque el fallback neutral en codigo ahora es `local-dev-user`, en esta maquina ese fallback no entra en juego porque `frontend/.env` ya fija `NEXT_PUBLIC_SOPHIA_USER_ID=dev-user`.

Entonces, en este workspace, el usuario efectivo del bypass sigue siendo `dev-user`.

## 3. Ese usuario ya tiene runtime artifacts en el repo

Existe el arbol:

- `users/dev-user/identity.md`
- `users/dev-user/handoffs/`
- `users/dev-user/recaps/`
- `users/dev-user/traces/`

Eso quiere decir que cuando trabajamos localmente con el bypass actual, las sesiones, recaps, handoffs y trazas pueden terminar cayendo sobre el usuario `dev-user` que ya tiene artefactos presentes.

## Como funciona tecnicamente

## A. Punto de activacion del bypass

Archivo: `frontend/src/app/lib/auth/dev-bypass.ts`

La logica actual es:

```ts
const explicitAuthBypass = process.env.NEXT_PUBLIC_DEV_BYPASS_AUTH

export const authBypassEnabled =
  explicitAuthBypass === 'true' ||
  (process.env.NODE_ENV !== 'production' && explicitAuthBypass !== 'false')

export const authBypassUserId = process.env.NEXT_PUBLIC_SOPHIA_USER_ID || 'local-dev-user'
```

Implicaciones:

- Si `NEXT_PUBLIC_DEV_BYPASS_AUTH=true`, el bypass queda forzado.
- Si no se define nada y no estamos en `production`, el bypass tambien queda activo.
- El `user_id` sintetico sale de `NEXT_PUBLIC_SOPHIA_USER_ID`.
- Si esa variable no existe, el codigo cae a `local-dev-user`.

## B. Que ve el frontend como usuario autenticado

Archivo: `frontend/src/app/providers.tsx`

Cuando el bypass esta activo, `authClient.useSession()` ni siquiera se usa. En su lugar se fabrica un usuario local:

```ts
user: { id: authBypassUserId, email: 'dev@localhost', name: 'Dev User' }
```

Ademas:

- `loading` pasa a `false`
- `signOut` es un no-op

En la practica, el frontend cree que ya hay sesion resuelta.

## C. Que partes del flujo se saltan

### AuthGate

Archivo: `frontend/src/app/components/AuthGate.tsx`

Con bypass activo:

- entra directamente en estado `authenticated`
- dispara `onAuthenticated()` sin esperar a Better Auth
- no muestra el boton de login con Discord

### ConsentGate

Archivo: `frontend/src/app/components/ConsentGate.tsx`

Con bypass activo:

- entra como `ready`
- llama `onReady()` sin consultar el backend
- no bloquea la entrada por consentimiento pendiente

Esto no significa que el consentimiento quede persistido en backend. Significa que el gate del frontend se salta temporalmente en desarrollo.

## D. Como llega ese usuario al backend Sophia

Archivo: `frontend/src/app/api/_lib/sophia.ts`

La funcion `resolveSophiaUserId()` hace esto:

1. Si el request ya trae `user_id`, usa ese valor.
2. Si no trae `user_id` y el bypass esta activo, devuelve `authBypassUserId`.
3. Solo si no hay bypass intenta resolver la sesion real via Better Auth.

Eso hace que muchas server routes del frontend terminen usando el `user_id` sintetico.

Ejemplos:

- `frontend/src/app/api/sophia/end-session/route.ts`
- `frontend/src/app/api/sophia/sessions/[sessionId]/recap/route.ts`
- `frontend/src/app/api/memory/recent/route.ts`
- `frontend/src/app/api/memory/save/route.ts`
- `frontend/src/app/api/memory/feedback/route.ts`
- `frontend/src/app/api/memory/commit-candidates/route.ts`

En otras palabras: el bypass no se queda solo en UI. Tambien define el `user_id` con el que se consultan y persisten datos de Sophia.

## E. Matiz importante: bypass de identidad no significa ausencia total de auth servidor-servidor

Archivo: `frontend/src/app/lib/auth/server-auth.ts`

Las llamadas server-side desde Next hacia el backend siguen montando un header `Authorization` usando cookie o `BACKEND_API_KEY`.

O sea:

- La identidad de usuario esta sintetizada por el bypass.
- La llamada al backend igual puede ir autenticada a nivel servidor con token tecnico.

Ahora mismo no hay una asociacion fuerte entre cuenta externa real y `user_id` efectivo en desarrollo. Lo que manda es el `user_id` resuelto por el frontend.

## Que cuenta se esta usando realmente

Hay que distinguir tres cosas:

### 1. Cuenta real de login

En bypass local: ninguna.

No hay Discord real ni sesion real de Better Auth participando en el flujo normal del frontend cuando el bypass esta encendido.

### 2. Identidad sintetica que ve la app local ahora mismo

`dev-user`

Con shape de usuario:

```json
{
  "id": "dev-user",
  "email": "dev@localhost",
  "name": "Dev User"
}
```

### 3. Usuario neutral de fallback en codigo

`local-dev-user`

Ese es el fallback actual si se elimina `NEXT_PUBLIC_SOPHIA_USER_ID`, pero hoy no es el efectivo porque el `.env` local lo sobreescribe con `dev-user`.

### 4. Usuario usado por E2E/CI frontend

`e2e-user`

En `frontend/playwright.config.ts` y en el workflow de E2E se define:

```ts
NEXT_PUBLIC_DEV_BYPASS_AUTH: 'true'
NEXT_PUBLIC_SOPHIA_USER_ID: 'e2e-user'
```

Eso evita que las pruebas E2E usen el usuario local de desarrollo.

## Inconsistencias actuales que Jorge deberia conocer

## 1. El codigo y la configuracion local no estan alineados

Se hizo un cambio para que el fallback de codigo dejara de ser `dev-user` y pasara a `local-dev-user`, con la idea de no caer por defecto sobre artefactos runtime versionados.

Pero siguen existiendo estos dos puntos que fuerzan `dev-user`:

- `frontend/.env`
- `frontend/.env.example`

Entonces el cambio a fallback neutral existe, pero en la practica local seguimos operando como `dev-user` si alguien copia la config o usa este workspace tal cual.

## 2. Hay riesgo de mezclar sesiones de desarrollo con datos runtime ya presentes

Como `users/dev-user/` existe y tiene artefactos, cualquier flujo local con bypass puede:

- leer memorias ya existentes de `dev-user`
- escribir nuevos recaps/handoffs/traces sobre ese mismo arbol
- dar la falsa impresion de estar trabajando con una cuenta limpia cuando en realidad se esta reciclando estado previo

## 3. El backend valida formato de `user_id`, no identidad real

El backend de Sophia valida que el `user_id` tenga formato seguro, pero no puede distinguir si vino de una sesion real o de un bypass de frontend.

Eso esta bien como solucion temporal de desarrollo, pero es importante que Jorge no asuma que hoy existe binding fuerte entre auth real y datos de usuario en local.

## Manejo temporal actual

Hoy el manejo temporal es este:

1. En local se evita Discord OAuth para poder iterar rapido en frontend.
2. El frontend sintetiza una sesion autenticada.
3. El `user_id` efectivo se define por env var.
4. Las server routes usan ese `user_id` para hablar con el gateway Sophia.
5. El backend acepta ese `user_id` si pasa la validacion de formato.

Operativamente: estamos usando un bypass de identidad de usuario, no un login real.

## Lo que Jorge deberia pasarle a su agente

Mensaje corto recomendado:

> El frontend tiene un dev auth bypass activo. Fuera de production, y con `NEXT_PUBLIC_DEV_BYPASS_AUTH=true`, se fabrica una sesion local y no se usa Discord/Better Auth para resolver el usuario. En este workspace el usuario efectivo actual es `dev-user` porque `frontend/.env` fija `NEXT_PUBLIC_SOPHIA_USER_ID=dev-user`, aunque el fallback de codigo ya es `local-dev-user`. Las API routes de Sophia y memory usan ese `user_id` sintetico para leer/escribir datos. El backend solo valida formato del `user_id`; no hay binding fuerte con una cuenta real en local. E2E usa `e2e-user` para no colisionar con desarrollo. Revisar cualquier cambio de auth, memory, recap o traces teniendo presente esa capa de bypass.`

## Recomendacion tecnica

Si queremos mantener el bypass un poco mas sin contaminar datos, la forma menos riesgosa es:

1. Dejar `NEXT_PUBLIC_DEV_BYPASS_AUTH=true` solo en local.
2. Cambiar `NEXT_PUBLIC_SOPHIA_USER_ID` local a un usuario neutral no versionado, por ejemplo `local-dev-user`.
3. Dejar `e2e-user` reservado para Playwright/CI.
4. Cuando Jorge toque auth real, revisar junto con su agente todas las rutas que usan `resolveSophiaUserId()` antes de asumir que el `user_id` viene de Better Auth.

## Archivos clave

- `frontend/src/app/lib/auth/dev-bypass.ts`
- `frontend/src/app/providers.tsx`
- `frontend/src/app/components/AuthGate.tsx`
- `frontend/src/app/components/ConsentGate.tsx`
- `frontend/src/app/api/_lib/sophia.ts`
- `frontend/src/app/api/sophia/end-session/route.ts`
- `frontend/src/app/api/memory/recent/route.ts`
- `frontend/src/app/session/useSessionPageContext.ts`
- `frontend/src/app/lib/auth/server-auth.ts`
- `frontend/.env`
- `frontend/.env.example`
- `frontend/playwright.config.ts`
- `users/dev-user/`