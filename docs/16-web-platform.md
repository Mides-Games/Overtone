# 16 — Overtone en Mides: la plataforma web de timings

Escrito el 2026-10-26. Es el plan del giro: Overtone pasa de ser una app de escritorio
personal a un sitio de **Mides Projects** cuyo foco es entregar timings, con cuentas
de Mides, perfiles y una capa social. El repositorio se muda a la organización
`Mides-Projects` y se publica como open source.

Este documento es la fuente de verdad del giro, como `roadmap/` lo es en Cavernia.
Ninguna fase arranca sin su fila acá, y las decisiones de arquitectura se escriben
antes de aplicarse.

> **2026-10-26 — La app de escritorio se estacionó.** Decisión del dueño: Overtone es
> solo web. La ventana web (pywebview, `app/`, `overtone_web.py`,
> `overtone_webhost.py`), la ventana Tk clásica, `Overtone.bat` y el instalador
> (`installer/`) salieron de `master` y viven enteros en la rama protegida
> `parked/desktop-app` y el tag `v3-desktop-app`. El sitio (`site/`) es la única
> interfaz; las herramientas de edición vuelven en la web en W7. El engine, el CLI y
> el servidor de medición (`overtone_server.py`, ahora sin interfaz) se quedan. Lo
> que este documento dice de la app de escritorio más abajo es el plan tal como se
> escribió; esta nota lo corrige (decisión abierta 8, §7).

---

## 0. Lo que se encontró (base del plan)

### Mides Projects hoy

| Pieza | Qué es | Qué significa para Overtone |
|---|---|---|
| **Mides-Dev-Web** (midesprojects.com, `Mides-Projects/Mides-Dev-Web`) | La identidad de todo el ecosistema: Flask + MySQL + Redis, React 18 + Tailwind 3, docker compose en una VPS propia (no en Reviactyl). Se despliega con un workflow por cada push a `main` y no tiene staging. Tiene cuentas, Discord/Google, 2FA, verificación por IP, perfiles, muro, feed, mensajes, roles por módulo y moderación. El SSO está documentado en `docs-sso.md`. | Es el **proveedor de login**. Overtone no guarda contraseñas: se registra como una app más del SSO, igual que `cavernia` (detalle en §1, ADR-W2). |
| **cavernia-api** (Mides-Games) | Express 5 + PostgreSQL sin ORM, con un `schema.sql` idempotente. Hace de proxy del login de Mides (`src/services/mides.service.js`), usa una sesión HMAC propia (`session.service.js`) y guarda el refresh token cifrado (`mides-token.service.js`, `utils/secret-box.js`). | Es la **plantilla de la API**. Esos cuatro archivos y `middlewares/` se copian casi tal cual. |
| **cavernia-web** (Mides-Games) | React 19, Vite 8, Tailwind 4, Redux Toolkit, i18next EN/ES, PWA. Componentes en `src/components/ui/`. | Es la **plantilla del frontend**. Pero su estética copia VeltPvP/MineHQ, no midesprojects.com, así que los tokens visuales se toman de Mides-Dev-Web. |
| **Edge** (api.midesprojects.com) | El backend Ktor de la red Minecraft: Lumen, Cinder, Wind, etc. | **No hace falta.** Overtone no toca Minecraft. |
| **Ramas** | `master` = producción, `experimental` = staging (Harbor/Tempest las mapea así), `feat/<area>-<tema>` = trabajo en curso. Merge sin squash, commits ≤ ~400 líneas, conventional commits en inglés, sin `Co-Authored-By`, sin GitHub Actions. | Overtone ya cumple casi todo. Diferencias: el tipo es `feat`, no `feature`, y hoy no existe una rama `experimental`. |
| **Reviactyl** (console.midesprojects.com) | Un solo nodo, **NA-01**: unos 29,5 GB de RAM, 477 GB de disco, 38 servers. Hay 5 nests: Minecraft (37 servers), **Custom Engine** (1), Source, Voice y Rust. **No hay database hosts.** Lo único que no es Minecraft es **Edge**, con su egg "Edge Backend": `ghcr.io/pterodactyl/yolks:java_21`, `bash bin/edge`, 2 GB de RAM, CPU sin límite. Cavernia y midesprojects.com despliegan por SSH a VPS propias. | Overtone sería el **primer sitio web en Reviactyl**. Su precedente es el egg de Edge, en el nest Custom Engine (§5). |
| **Open source** | Ningún repo de las organizaciones tiene licencia, SECURITY.md ni plantillas. | Overtone fija la convención para el resto. |

### Overtone hoy

- **Lo que sirve:** el núcleo de timing funciona y está medido (24/24 en el benchmark,
  27/27 golden). Es la parte que el sitio entrega.
- **La precisión real:** en mapas rankeados (Corpus B) solo el 16,8 % (Python) y el
  5,2 % (Rust) de las red lines caen dentro de 5 ms. **El sitio no puede prometer
  "timing perfecto".** Muestra confianza, invita a corregir, y la capa social
  (estrellas, "usado N veces") es justamente lo que separa un timing bueno de uno
  dudoso. Esto es la regla 2 del repo aplicada al producto.
- **Lo que no está terminado:** los hitsounds (clap F1 0,59, finish 0,42; perfiles a
  medias), Compile, Train, Library y el hotkey global. Se estacionan (§3).
- **Costo por canción:** con Beat This! en CPU, unos 7 s de reloj (40 s de CPU) en un
  fixture corto y 34 s (173 s de CPU) en uno de 6 minutos. Beat This! es lo que
  define cuántos análisis simultáneos aguanta el servidor.
- **Ya hay un servidor** en la rama `feature/library-api` (27 commits sin mergear a
  `master`, al 2026-10-26; el detalle está en `docs/server.md` de esa rama):
  - `python/overtone_server.py` sirve la app entera por navegador, con login por token;
  - `python/overtone_runs.py` es una cola de corridas, una a la vez y cada una en su
    proceso, que corre mediciones, puertas y suite en el servidor;
  - `python/overtone_webhost.py` y `app/web.js` reemplazan a pywebview en el navegador;
  - `deploy/overtone-update.sh` y su timer hacen fast-forward de una rama cada 5
    minutos, recompilan `overtone-cli` si cambió Rust y reinician el servicio;
  - corre en una VPS con systemd y Caddy.

  Memoria medida en esa rama: Rust + voto de Beat This!, 1,46 GB y 50 s; Rust sin
  voto, 101 MB y 2,3 s; v3 Python, 1,78 GB y 42 s (fixture de 90 s). Además, la rama
  **sí** usa un workflow (`.github/workflows/deploy.yml`) que dispara la
  actualización por SSH. Eso choca con la regla del repo y de la org (§2).

---

## 1. Arquitectura objetivo

```
navegador ──► overtone-web (estático, Vite build)
                 │  /api/v1 (mismo origen)
                 ▼
             overtone-api (Express 5) ──► Mides-Dev-Web (/auth/*, /authorize, perfiles)
                 │            │
                 │            └──► PostgreSQL (usuarios, canciones, timings, social, cola)
                 ▼
             overtone-worker (Python v3; Rust después)
                 toma trabajos de la cola, analiza, borra el audio, guarda el resultado
```

### Decisiones (ADR) propuestas

- **ADR-W1 — Monorepo.** El engine, el worker, la API y la web viven en el mismo repo
  `Mides-Projects/Overtone`:
  ```
  python/  crates/  bench/  tests/   (como hoy: el engine)
  worker/                            el proceso que consume la cola
  site/api/                          Express 5 + pg
  site/web/                          React 19 + Vite + Tailwind 4
  deploy/eggs/                       los eggs de Reviactyl
  ```
  **Por qué:** el worker tiene que correr el engine del mismo commit que la API (la
  caché de análisis se indexa por hash de audio + hash de engine, como ya hace
  `corpus_b.py`). Además, un solo repo público es más creíble que tres a medias.
  Cavernia separó web y API (su ADR-003) porque no comparten nada; acá sí comparten.
- **ADR-W2 — Login solo con Mides, como app `web`.**
  - **Registro.** Las apps del SSO están escritas en el código, no en una tabla:
    1. `SSO_APPS` en `backend/app/config.py` (~línea 86) recibe
       `"overtone": {"type": "web", "name": "Overtone", "redirect_origins": (prod, experimental), "redirect_paths": ("/login/callback",)}`;
    2. `frontend/src/pages/Authorize.jsx` (`APPS`, líneas 32–41) recibe el nombre visible.

    Es un PR chico a Mides-Dev-Web, y mergear a `main` lo despliega solo.
  - **Flujo:**
    1. `/authorize?app=overtone&redirect_uri=…&provider=discord|google` va directo
       al OAuth del proveedor;
    2. vuelve con `#code=` (un JWT de 60 s, de un solo uso);
    3. el código se canjea **servidor a servidor** en `POST /api/auth/sso/exchange`,
       que devuelve access (30 min), refresh (7 días, sin rotar) y el usuario completo.
  - **De cavernia-api se copia:**
    - el `redirect_uri` lo arma el servidor;
    - una cookie firmada protege contra CSRF;
    - la sesión es una cookie HMAC propia;
    - ~~el refresh token se guarda cifrado con AES-GCM~~: desde el 2026-10-27 no se guarda ningún token de Mides (ver abajo).
  - **El costo de `web`** (resuelto el 2026-10-27: Mides-Dev-Web `feat/web-sso-scoped` le da a Overtone un secreto de canje, un access con audiencia `app:overtone`, sin refresh, y el perfil mínimo; Cavernia sigue con el modo viejo): el token era una sesión completa de Mides. Puede postear en
    el muro y ver email y teléfono. Por eso **nunca sale de overtone-api**: el
    navegador solo ve la cookie de Overtone, y de `/me` se guardan solo los campos
    públicos. El tipo `spa` está acotado, pero ignora `provider=` y no deja postear.
    Más adelante se puede proponer un tipo `web` con `aud` y una lista de endpoints
    permitidos (W6).
- **ADR-W3 — El perfil es el de Mides.**
  - **Qué se lee:** foto, banner, @username, país, bio, titles, `featured_badges`,
    `accent_color` y seguidores. Salen de `GET /api/profile/<username>`, que es
    público y se llama servidor a servidor: el CORS de Mides solo deja su propio
    origen. La presencia de Discord sale de `GET /api/profile/<username>/discord`
    (Water Bot), con caché de 30 s.
  - **La clave es `mides_user_id`.** Como Mides no busca por id, el username se
    refresca en cada login. Un `GET /api/profile/by-id/<id>` sería un PR chico a
    Mides-Dev-Web.
  - **Qué agrega Overtone:** solo la pestaña **Timings** y sus estadísticas, sin una
    red social paralela. "Compartir en mi muro" usa
    `POST /api/profile/<username>/wall` con el token `web` del usuario (límite de
    10/min). Eso ya existe; no hace falta pedirlo.
  - **Mides no tiene webhooks ni eventos.** Los avisos de "alguien usó tu timing"
    quedan en Overtone.
- **ADR-W4 — El audio no se guarda.** Se sube, se analiza y se borra. Quedan el SHA-1,
  la huella, la duración, los metadatos y el resultado. **Por qué:** la música tiene
  copyright y el repo es público. Guardar MP3 ajenos es un riesgo legal que un sitio
  de timings no necesita: el usuario ya tiene el audio, lo que le falta es el timing.
- **ADR-W5 — Análisis en cola, nunca dentro del request.**
  - La cola es una tabla `jobs` en Postgres, tomada con `SELECT … FOR UPDATE SKIP LOCKED`.
  - El navegador sigue el progreso por SSE o polling.
  - Concurrencia inicial: 1 análisis a la vez por cada 4 núcleos (Beat This! ocupa ~5 núcleos de CPU por segundo de reloj).
- **ADR-W6 — Sin cuenta se puede timear.** El análisis anónimo tiene límite por IP
  hasheada. Lo que da la cuenta está en §4.
- **ADR-W7 — La regla 6 se parte en dos.** Hoy dice "offline only". Queda así:
  - el **engine** sigue sin red (la app de escritorio, que también, se estacionó el
    2026-10-26);
  - el **sitio** habla solo con Mides (identidad) y, opcionalmente, con la API v2 de
    osu! para metadatos de beatmaps;
  - sin telemetría de terceros.
  Hay que escribirlo en `CLAUDE.md`.
- **ADR-W8 — Base de datos: PostgreSQL**, como un server más en Reviactyl (egg
  propio en Custom Engine, imagen oficial `postgres`). El panel no tiene database
  hosts configurados, así que usar MySQL tampoco sale gratis.
  **Por qué Postgres:**
  - la plantilla de cavernia-api (`schema.sql`, `pg`) es Postgres;
  - la cola usa `SKIP LOCKED`.

  **Por qué no MySQL**, aunque Mides-Dev-Web lo use: compartir su servidor uniría
  la caída de uno a la del otro. Queda como decisión abierta (§7).
- **ADR-W9 — Estética: la de midesprojects.com, copiada desde Mides-Dev-Web.**
  - **La fuente de verdad** es su `design-system.md`, con los tokens de
    `frontend/tailwind.config.js` y `frontend/src/styles/index.css`.
  - **Tipografía:** los titulares usan **Horizon** (`public/fonts/horizon.otf`; antes
    de publicar el repo hay que confirmar que su licencia permite redistribuirla) y
    el texto, el stack de sistema Apple.
  - **Color:** acento `#0a84ff`, que pasa a `#4d9fff` en oscuro; fondo oscuro
    `#0a0a0f`; el nav en píldora usa `.pill-gradient`.
  - **Tema e idioma:** el modo oscuro va por clase, y tema e idioma se guardan como
    `mides.theme` y `mides.lang`.
  - **Componentes que se portan:** `Navbar`, `TickerBar`, `Logo`, `Layout`, `Footer`,
    `Avatar`, `BrandLoader` y `Modal`.
  - **Stack:** el de Cavernia (React 19, Tailwind 4), con los tokens de Mides pasados
    a `@theme`.
  - **En midesprojects.com, Overtone va en el lanzador del ecosistema**
    (`src/constants/ecosystem.js`), **no en MAPPING**. `/mapping` es la página de
    construcción de mapas de Minecraft.

---

## 2. Ramas, entornos y releases

| Rama | Entorno | Quién la usa |
|---|---|---|
| `master` | **producción** (`overtone.midesprojects.com` o el dominio que se elija) | público |
| `experimental` | **staging** (`experimental.overtone…`) | testers: el rol "Overtone Testers" de Mides, como "Cavernia Testers" |
| `feat/<area>-<tema>`, `fix/…`, `chore/…` | local, o en una máquina ajena | quien desarrolla |

- **Flujo:**
  1. `feat/*` → PR a `experimental` (merge sin squash) → reiniciar el server de staging
     (hace `git pull` solo, §5) → probar.
  2. PR `experimental` → `master` → reiniciar producción.
- **Convenciones:**
  - Push a GitHub nunca despliega solo: el reinicio en el panel es el gesto de
    release, como en Tempest.
  - El tipo de commit pasa de `feature` a `feat`, alineado con Mides. Se actualiza
    `CLAUDE.md`/`AGENTS.md` en el mismo cambio.
- **Las puertas siguen siendo locales** (sin GitHub Actions). Se suman las del sitio:
  - `pnpm --dir site/web verify` (lint, build y chequeo de textos);
  - `pnpm --dir site/api check` (OpenAPI y `schema.sql` contra un Postgres efímero);
  - un smoke del worker: un fixture de `bench/golden` tiene que dar la misma BPM que
    `bpm_snapshot.json`.
- **Probarlo en una máquina ajena**, "como ahora":
  ```bash
  git clone … && pnpm install && pnpm dev
  ```
  - Levanta la web, la API y un worker.
  - Con `MIDES_DEV_LOGIN=1` hay un login simulado, así un tester no necesita
    secretos ni que su origen esté registrado en el SSO.
  - ~~La app de escritorio sigue funcionando para el uso offline.~~ Se estacionó el
    2026-10-26 (`parked/desktop-app`); para uso offline queda el CLI del engine.

---

## 3. Qué se estaciona y cómo

Antes de borrar nada, se marca el estado completo con el tag `v3-desktop-full` y se
empuja una rama `parked/desktop-extras`, que no se mergea. Desde ahí se recupera cada
pieza cuando vuelva bien hecha.

| Se estaciona | Dónde vive hoy | Cómo sale |
|---|---|---|
| Hitsounds | `overtone.py` 8651–10026 y 7005–7626 (contexto de objetos); `crates/overtone-hitsound`; `profiles/`; `assets/kits.json`, `assets/samples*`; bench `genre_*`, `fit_kits`, `sample_banks`, `eval_*`, `templates_on_real_audio`, `labels*`; docs 06 y 15 | Se cortan los bloques del engine, y la feature `hitsound` del CLI queda apagada por defecto. Los tests de hitsound (~15 clases + 5 web) se van con ellos. |
| Compile | `overtone_combine.py`, gate `combine` | Sale entero (solo depende de `overtone`). |
| Train | `overtone_train.py`, `overtone_hotkey.py` | Sale entero. |
| Library | `overtone_library.py`, `library.sql` | Sale entero; `facts.py` deja de chequear su esquema. |

- **Se queda:** Timing, Export, Map check, Audio y Structure. Mapset se queda sin el
  copiador de hitsounds.
- **El costo real:** `overtone_web.py` importa todo (líneas 33–39). Hay que partirlo
  o volverlo lazy antes de cortar.
- **Al final:** se re-basan el conteo de tests y `bench/facts.py`, y se anota en
  `timeline.md` con su sección *Rejected / tried and dropped*, sin re-basar ninguna
  puerta de precisión.

---

## 4. Producto

### Sin cuenta

- Subir un audio (y opcionalmente un `.osu`).
- Ver el análisis: BPM, offset, red lines, compases, confianza por sección y
  evidencia.
- Descargar:
  - el bloque `[TimingPoints]`;
  - el `.osu` con el timing inyectado (atómico; los campos que no se tocan salen
    byte a byte);
  - CSV y click track.
- Buscar y ver timings publicados.
- Límite: N análisis por día por IP, audio de hasta 10 minutos.

### Con cuenta Mides (los beneficios)

- **Historial** de análisis propios, con el resultado guardado aunque el audio no.
- **Más cuota** (análisis por día, duración máxima) y prioridad en la cola.
- **Publicar** un timing: público, no listado o privado; con notas, la versión del
  engine y las correcciones manuales hechas encima.
- **Reaccionar** (emoji), **calificar** de 1 a 5 estrellas y **comentar** (en hilo).
- **Usar / importar** un timing ajeno, lo que suma al contador "usado N veces" del
  autor. Es la métrica de reputación más honesta.
- **Fork:** importar un timing, corregirlo y republicarlo, con crédito al original.
- **Colecciones** (por ejemplo "timings de mi mapset").
- **El perfil de Mides** muestra la pestaña Timings: publicados, estrellas promedio,
  usos totales e insignias (por ejemplo "coincide con el mapa rankeado").
- Notificaciones (alguien usó o calificó tu timing) y, más adelante, un post en el
  Feed de Mides.

### Identidad de una canción

- `songs` se indexa por el SHA-1 del audio, igual que el `.osz` lo trae. Un mismo MP3
  de un beatmapset lleva siempre a la misma página.
- Opcionalmente se vincula al `beatmapset_id` de osu!.
- Si dos usuarios suben el mismo audio, ven los timings de los demás. Ese es el
  corazón del sitio.

### Verificación contra el mapa rankeado

- Si la canción tiene un mapa rankeado, el sitio compara el timing publicado con el
  de ese mapa. Usa `reference timing` / `mod report`, que ya existen en el engine.
- Un timing que coincide gana la insignia **Ranked-match**, una prueba medida y no
  una opinión.

### Modelo de datos (borrador de `site/api/src/db/schema.sql`)

```
accounts(id, mides_user_id UNIQUE, username, avatar_url, banner_url, discord_id, mides_role, cached_at)
mides_tokens(account_id, refresh_token_enc, …)                      -- copiado de Cavernia
songs(id, audio_sha1 UNIQUE, duration_ms, title, artist, beatmapset_id NULL)
analyses(id, song_id, account_id NULL, engine, engine_hash, result JSONB, confidence, created_at)
jobs(id, analysis_id, state, attempts, locked_at, error)            -- la cola
timings(id, song_id, account_id, analysis_id NULL, forked_from NULL, red_lines JSONB,
        visibility, notes, ranked_match BOOL, created_at, deleted_at)
timing_ratings(account_id, timing_id, stars 1..5, PK(account_id,timing_id))
timing_reactions(account_id, timing_id, emoji, PK(account_id,timing_id,emoji))
timing_uses(account_id NULL, timing_id, ip_hash, used_at)           -- "usado N veces"
timing_comments(id, timing_id, account_id, parent_id NULL, body, score, deleted_at)
collections(id, account_id, name) / collection_items(collection_id, timing_id)
reports(id, target_kind, target_id, account_id, reason, state)      -- moderación
notifications(id, account_id, kind, payload JSONB, read_at)
```

- La moderación usa los roles de Mides: Admin y Moderación ya existen en el menú de
  midesprojects.com.
- El puntaje que se muestra combina estrellas y usos con un promedio bayesiano, para
  que un 5★ con un voto no gane a un 4,6★ con doscientos.

---

## 5. Despliegue en Reviactyl

Todo va al nodo **NA-01**, en el nest **Custom Engine** (donde vive Edge). Hay tres
servers por entorno (×2: `master` y `experimental`), más una base de datos
compartida con dos schemas.

**El riesgo propio de este nodo:** comparte la máquina con 37 servers de Minecraft, y
Edge corre con CPU sin límite. Beat This! consume unos 5 núcleos por análisis, y un
worker sin tope le mete lag a los servers de juego. Por eso el worker lleva **CPU
Limit** (por ejemplo 400 %, cuatro núcleos) y, si hace falta, **CPU Pinning** a
núcleos que los servers de juego no usen. Su RAM sale de la cuenta de abajo
(~1,5 GB por análisis simultáneo con el voto).

**HTTPS:** el panel no termina TLS para apps web.
Edge ya está publicado en `api.midesprojects.com` a través de algún proxy. Overtone
usa el mismo proxy: `overtone.midesprojects.com` → `<ip-del-nodo>:<puerto de
overtone-api>`. Falta averiguar dónde corre ese proxy (nginx en el host, o
Cloudflare).

| Server | Imagen | Arranque |
|---|---|---|
| `overtone-web` | Node 24 (yolk de Node de Pterodactyl/Reviactyl) | `git pull` de `$BRANCH` → `pnpm install` → `pnpm --dir site/web build` → servir `dist/` con un estático mínimo (o detrás del nginx/Cloudflare existente) |
| `overtone-api` | Node 24 | `git pull` → `pnpm install --prod` → `node site/api/src/db/migrate.js` → `node site/api/src/server.js` |
| `overtone-worker` | Python 3.14 (yolk de Python) | `git pull` → `pip install -r python/requirements.lock` → `git lfs pull` (modelo Beat This!) → `python worker/main.py` |
| `overtone-db` | egg de PostgreSQL | — |

- **Eggs:** se escriben en `deploy/eggs/` y se generan con un script, como
  `Cinder/eggs/egg.js`. Variables: `GIT_ADDRESS`, `BRANCH` (`master` o
  `experimental`), `AUTO_UPDATE=1` y las del `.env`.
- **La VPS actual** sigue como máquina de mediciones (corridas de `bench/stages.py`
  sobre su carpeta Songs) hasta que Reviactyl esté arriba; después se decide si
  queda solo para eso. Su `overtone-update.sh` ya resuelve "una rama, solo
  fast-forward, no cortar una corrida": el egg del worker reusa esa lógica.
- **Memoria del worker:** con el voto de Beat This!, ~1,5 GB por análisis
  simultáneo. Sin él, ~100 MB, pero cambian las red lines. El tamaño del server en
  el panel sale de esta cuenta.
- **Releases:** el gesto de release es reiniciar el server en el panel; el egg hace
  `git pull` al arrancar. Así producción sigue a `master` y staging a `experimental`,
  sin GitHub Actions.
- **Secretos:**
  - viven en las variables del panel, nunca en el repo;
  - `.env.example` lista solo los nombres: `DATABASE_URL`, `SESSION_SECRET`,
    `MIDES_AUTH_URL`, `MIDES_WEB_URL`, `MIDES_APP`, `SITE_URL`, `MIDES_CLIENT_SECRET`,
    `ANON_DAILY_LIMIT`, `MAX_AUDIO_SECONDS`, `WORKER_CONCURRENCY`.
- **Dominio:** un subdominio de midesprojects.com detrás de Cloudflare, como los
  demás. CORS no hace falta, porque web y API comparten origen (`/api/v1` por proxy).
- **Backups:** `pg_dump` diario desde el panel (tarea programada del server de base
  de datos).
- **Rust, más adelante:** cuando el engine Rust alcance a v3 en Corpus B, el worker
  pasa a `overtone-cli`. Para no compilar en cada arranque, el binario Linux se
  compila en un server `overtone-build` y se sirve por URL con token, como
  `CINDER_BUNDLE_URL`.

---

## 6. Roadmap

Cada fila es una rama y un PR. Los números siguen el estilo `W<fase>.<n>`.

### Fase W0 — Preparar la mudanza y el open source (antes de todo)

| # | Tarea | Hecho cuando |
|---|---|---|
| W0.1 | Cerrar el trabajo en curso (`fix/local-tempo-octave` y sus hermanas) | No queda nada sin mergear ni sin decidir |
| W0.2 | Tag `v3-desktop-full` en `master` | El estado completo es recuperable |
| W0.3 | Purgar del historial `2410bc50-…-a8a159b5bcf4.data` (77 MB) y `sym_shape_infer_temp.onnx` con `git filter-repo` | El pack baja de ~91 MB a ~12 MB |
| W0.4 | El email personal de 652 commits se reescribe a la dirección noreply de GitHub en el repo nuevo (decidido el 2026-10-26). Los commits nuevos del repo nuevo usan `user.email` noreply a nivel de repo | Cero commits con el Gmail en `Mides-Projects/Overtone` |
| W0.5 | Sacar del repo los datos de la biblioteca local: `bench/corpus_b.json`, `genre_corpus.json`, `labels.json`, `health_sample.*`, `real_audio_snapshot.json`. Pasan a `*.local.json` ignorados, con un `*.example.json` versionado | Ninguna carpeta de Songs ni ningún mapa propio en el árbol público |
| W0.6 | Decidir qué pasa con `.claude/`, `.agents/` y `graphify-out/`: el primero se queda sin rutas personales (`SKILL.md:34`); el último se va | `git grep 'C:\\Users'` vacío |
| W0.7 | `LICENSE` (MIT, titular a definir), `README` público, `SECURITY.md`, `CONTRIBUTING.md`, plantillas de issue/PR | Plantillas que puede copiar el resto de la org |
| W0.8 | **Repo nuevo `Mides-Projects/Overtone`**, no una transferencia (decidido el 2026-10-26). Los miembros de la org pueden crear repos y el nombre está libre. **Por qué:** GitHub guarda para siempre los `refs/pull/*` de los 128 PRs del repo actual, y nadie los puede borrar; esos refs siguen apuntando a los commits viejos, con el blob de 77 MB y el Gmail. Un repo nuevo recibe solo el historial ya limpio (W0.3–W0.4). Pasos: limpiar un `git clone --mirror` con `filter-repo` → crear el repo **privado** → `git push` de `master`, `experimental` y las ramas vivas, más `git lfs push --all` (el modelo de 83 MB; la cuota LFS gratis de la org es 1 GB) → verificar → `githaltwastaken/Overtone` queda archivado y privado, como respaldo con los PRs viejos | `gh repo view Mides-Projects/Overtone` |
| W0.9 | Crear `experimental` desde `master`; `CLAUDE.md` adopta `feat` y el modelo de ramas de §2 | Las dos ramas existen |
| W0.10 | Pasarlo a **público** | Escaneo de secretos limpio sobre el historial ya reescrito |

### Fase W1 — Estacionar lo incompleto

| # | Tarea |
|---|---|
| W1.1 | Rama `parked/desktop-extras` empujada |
| W1.2 | `overtone_web.py`: imports lazy o partidos por sección |
| W1.3 | Sacar Compile, Train, Library y el hotkey (módulos, tests, la puerta `combine`, docs) |
| W1.4 | Cortar los hitsounds del engine y del bridge; la feature `hitsound` del CLI queda apagada por defecto |
| W1.5 | Re-basar el conteo de tests y `facts.py`; correr todas las puertas; entrada en `timeline.md` |

**Hecho el 2026-10-26** en la rama `chore/park-desktop-extras`, con dos cambios sobre lo
planeado arriba: el crate `overtone-hitsound` salió del workspace en vez de quedar como
feature apagada (borrar es más honesto que apagar, y todo vive en `parked/desktop-extras`);
y de Library sale solo la página. `overtone_library.py` y `library.sql` se quedan, porque
`overtone_server.py`, `bench/stages.py`, `single_bpm.py`, `health_sample.py` y
`mapper_agreement.py` los leen, y `facts.py` sigue chequeando su esquema. Con Compile y
Train fuera, `overtone_web.py` ya no importa nada estacionado y W1.2 no hizo falta. El
detalle y las puertas están en `timeline.md`.

### Fase W2 — El engine como servicio

| # | Tarea |
|---|---|
| W2.0 | Mergear `feature/library-api` a `master`, sin `.github/workflows/deploy.yml`: con el timer alcanza, y la org no usa Actions. `overtone_server.py` y `overtone_runs.py` son la base del worker: su cola, su caché por `engine_hash` y su tope de memoria se reusan; lo que cambia es que los trabajos llegan de la API pública y no de una carpeta Songs |
| W2.1 | Contrato `timing-result v1` (JSON con esquema): red lines, compases, confianza, evidencia, versión y hash del engine. Lo emiten tanto v3 como `overtone-cli` |
| W2.2 | `worker/`: toma un job, analiza con v3, escribe el resultado y borra el audio; reintenta con tope y tiene timeout por duración |
| W2.3 | Correrlo en Linux (WSL o el server de staging): las 24/24 lecturas de `bpm-snapshot` iguales a Windows |
| W2.4 | Puerta `perf` del worker: costo por minuto de audio, que fija `WORKER_CONCURRENCY` |

**W2.1, W2.2 y W3.4 hechos el 2026-10-26** en la rama `feat/site-analysis`, con estos
cambios sobre lo planeado (el detalle está en `docs/site.md` y `timeline.md`):
- El worker no toma la cola de Postgres: es cliente HTTP de rutas internas de la API
  (`/api/internal`, con `WORKER_TOKEN`). Así no lleva driver de base ni dependencias
  nuevas, y la API es dueña de todo el estado. El `SKIP LOCKED` vive en la API.
- No se partió de `overtone_server.py`/`overtone_runs.py` (W2.0 sigue sin mergear): el
  worker llama a `python/overtone.py` directo, con los parámetros por defecto escritos
  en `worker/timing_result.py`, porque la shell de escritorio se va del repo.
- Un worker analiza de a un trabajo; `WORKER_CONCURRENCY` no existe. Más análisis a la
  vez son más servers worker.
- `timing-result v1` lo emite v3; `overtone-cli` todavía no. W2.3 y W2.4 siguen abiertos.
- **2026-10-27** (rama `feature/cli-timing-result`): `overtone-cli analyze --timing-result`
  escribe el mismo documento con `engine` "v4". Difiere a propósito en tres cosas: no
  trae `findings` (v4 no valida los puntos todavía, y una lista vacía diría "revisado, nada"),
  `beat_vote` es false (el voto no está portado) y donde v3 cae a su beat tracker, v4
  rechaza. `tests/test_worker.py` lo comprueba sobre el fixture golden `change-128-142`:
  mismas claves y tipos, mismas red lines (128 y 142) y mismos niveles.

**W2.3, a medias (2026-10-27, rama `bench/worker-parity`).** La puerta existe y pasa en
Windows; en Linux no se corrió. `bench/worker_parity.py` pasa los 24 casos por
`worker/timing_result.py` con el voto, como un trabajo, y compara cada `timing-result v1`
con `bench/bpm_snapshot.json` (0.01 BPM, mismas red lines, compás y camino del engine):
**24/24 en Windows**. No hay Linux donde correrla: esta máquina no tiene distro de WSL (y
activarla pide admin y reiniciar) ni Docker, y el server de medición sigue en
`feature/library-api`, sin `worker/`. Los pasos para el VPS, en un clon aparte que no toca
al server, están en `timeline.md`. W2.3 se cierra cuando esa corrida diga 24/24.

**W2.4 medido el 2026-10-27** (rama `bench/worker-perf`, `bench/worker_perf.py`): cada
trabajo en un proceso nuevo, con 4 hilos como el worker de prod, en Windows (12 núcleos,
una pasada por caso). Dos corridas: la primera con la máquina cargada por otras
sesiones y antes del arreglo del loader del worker (abajo); la segunda, tranquila y con
el arreglo:

| Audio | Voto | s por minuto, cargada | Pico, antes | s por minuto, tranquila | Pico, con el arreglo |
|---|---|---|---|---|---|
| 1 min | sí | 34,1 | 1628 MB | 8,2 | 1002 MB |
| 1 min | no | 10,6 | 291 MB | 2,1 | 292 MB |
| 6 min | sí | 15,5 | 1738 MB | 5,4 | 1113 MB |
| 6 min | no | 3,3 | 445 MB | 0,9 | 444 MB |
| 10 min | sí | 20,7 | 1824 MB | 5,4 | 1200 MB |
| 10 min | no | 4,7 | 565 MB | 0,9 | 566 MB |

La carga del engine y del modelo (2-38 s) se paga una vez al arrancar, no por trabajo.
El costo no es lineal: un tema corto paga una parte fija, y por eso el peor caso por
minuto es el de 1 minuto. La carga de la máquina pesa más que el código: entre las dos
corridas, los tiempos se dividen por cuatro. Para W3.16, la estimación conservadora es
**35 s por minuto de audio con el voto** (11 sin él), la de la máquina cargada, hasta
medir el contenedor. La puerta exige menos de 45 s por minuto (un tema de 600 s en la
mitad de `JOB_TIMEOUT_S`) y el pico dentro del contenedor (2048 MB con voto, 768 sin):
pasa en las dos. **Arreglo:** el loader del worker con hilos acotados (el de todo worker
desplegado) armaba su propia sesión de ONNX Runtime sin el `enable_mem_pattern = False`
de #20; con él, el pico con voto a 10 minutos baja de 1824 a 1200 MB (848 MB de margen). `WORKER_CONCURRENCY`
sigue sin existir (un worker, un trabajo); el número que fija W2.4 es cuántos workers
hacen falta, no cuántos hilos. Falta repetirlo en el contenedor Linux, con los mismos
pasos que W2.3.

### Fase W3 — El sitio, mínimo usable (MVP)

| # | Tarea |
|---|---|
| W3.1 | `site/api`: esqueleto copiado de cavernia-api (env, middlewares, `schema.sql` + migrate, OpenAPI) |
| W3.2 | **PR a Mides-Dev-Web** (rama `feat/overtone-sso`; mergear a `main` despliega solo):<br>• `"overtone"` en `SSO_APPS` (`backend/app/config.py`) con los orígenes de producción y de experimental y `/login/callback`;<br>• el nombre en `APPS` de `Authorize.jsx`;<br>• Overtone en `src/constants/ecosystem.js`;<br>• opcional: `GET /api/profile/by-id/<id>`.<br>Necesita el OK del dueño de Mides-Dev-Web |
| W3.3 | Login con Discord/Google por Mides, sesión, `/me`; modo `MIDES_DEV_LOGIN` para desarrollo |
| W3.4 | Subida, job, progreso y resultado; descarga de `[TimingPoints]`, `.osu` inyectado, CSV y click |
| W3.5 | `site/web`: tokens visuales de midesprojects.com (§8), layout con la cinta, el nav en píldora y el menú de usuario; páginas Inicio, Analizar, Resultado, Login |
| W3.6 | Cuotas: anónimo vs. cuenta; rate limit por IP hasheada |
| W3.7 | i18n EN/ES desde el día uno; la app ya es bilingüe |
| W3.8 | **Cola visible en la página** (pedido del dueño, 2026-10-26). Una página `/queue` muestra, en vivo (SSE o polling), cada análisis pendiente y reciente: posición, quién lo subió (avatar y @ de Mides, o "anónimo"), canción (artista y título de los tags del audio; si no hay, el nombre del archivo limpio), estado (en cola, analizando con su progreso, listo, rechazado, falló) y cuánto tardó. Desde ahí se abre el resultado si es de uno o si se publicó. **Privacidad:** el nombre de archivo y el uploader se ven solo si quien subió no marcó "privado"; la ruta nunca, y el audio nunca se sirve |
| W3.9 | **Subida múltiple.** Se pueden mandar varias canciones a la vez (arrastrar varios archivos o una carpeta). Cada una es un trabajo propio en la cola, con su propia tarjeta de progreso. Límites: cuántas a la vez por persona (anónimo menos que con cuenta), el cupo diario de siempre, y un tope total de la cola para que nadie la llene. El orden es justo entre usuarios (round-robin por persona, no FIFO puro), para que un lote de 30 no deje esperando al que subió una |
| W3.10 | **Más de un worker.** La cola ya se reparte con `SKIP LOCKED`: escalar es levantar otro server de worker en el panel. Medir cuántos análisis simultáneos aguanta el nodo NA-01 sin lag en los servers de Minecraft, y fijar `WORKER_CONCURRENCY` con ese número |
| W3.11 | **Preguntar antes de subir.** El navegador calcula el SHA-1 del audio y llama a `POST /analyses/lookup` con ese hash: si el mismo audio ya se analizó con el engine actual, la respuesta es el resultado guardado y el archivo no se sube. Hoy el caché solo se ve después de mandar el archivo entero, y ese envío cuenta para el tope de pendientes (W3.9) aunque no genere trabajo. Hecho cuando una canción repetida no gasta ni un byte de subida ni un lugar en la cola |
| W3.12 | **Cancelar lo propio.** Quien subió una canción que sigue en cola puede sacarla desde su tarjeta, su página o `/queue`: el trabajo se borra, el audio del spool también, y no cuenta para la cuota del día. Una que ya se está analizando no se cancela (el worker no tiene cómo enterarse a mitad de etapa) |
| W3.13 | **Tags de M4A y WAV.** `lib/tags.js` lee ID3v2 y Vorbis; faltan los átomos `©nam`/`©ART` de MP4 (M4A) y el chunk `LIST/INFO` de WAV. Con fixtures chicos generados en el test, no con canciones de la biblioteca |
| W3.14 | **Avisar cuando termina un lote.** El título de la pestaña lleva la cuenta ("2/5 listas") y, si la persona lo permite, una notificación del navegador al terminar la última. Nada sale del navegador |
| W3.15 | **Bajar un lote entero.** Desde las tarjetas de una subida múltiple: un ZIP con el `timing.txt` de cada canción lista, armado en el navegador con los resultados que ya trae. Sin dependencia nueva si alcanza con un ZIP sin compresión |
| W3.16 | **Tiempo estimado en la cola.** Con el costo por minuto de audio que mida W2.4, cada fila de `/queue` dice cuánto falta, aproximado y marcado como estimación. Antes de W2.4 no se muestra: no se inventa precisión |
| W3.17 | **Un rate limit que sobreviva a dos procesos.** `middlewares/rate-limit.js` cuenta en memoria y lo dice: el día que haya dos procesos de API, pasa a Postgres (o a la misma tabla que las cuotas). Hecho cuando dos APIs detrás del proxy comparten el conteo |
| W3.18 | **La cola, moderada.** Quien tenga rol de staff en Mides ve en `/queue` un botón para sacar un trabajo o devolverlo a la cola, con registro de quién lo hizo. Es la primera pieza del panel de moderación de W6 |
| W3.19 | **Las pruebas del sitio en la lista de verificación.** `node --test` de `site/api` y `vite build` de `site/web` entran en la sección Verification de `CLAUDE.md`/`AGENTS.md`, con su conteo, y `bench/facts.py` chequea ese conteo como hace con la suite de Python |
| W3.20 | **Más descargas.** Además de `[TimingPoints]` y CSV:<br>• el `.osu` con el timing inyectado (la persona sube su `.osu`, el navegador lo parchea con el resultado y lo descarga; el server nunca lo guarda; los campos que no se tocan salen byte a byte, regla 5);<br>• un `.osz` mínimo para empezar un mapa;<br>• click track WAV (la canción del navegador más el metrónomo, renderizado con `OfflineAudioContext`);<br>• JSON `timing-result` completo;<br>• formatos de otros juegos que el engine ya exporta (Quaver, StepMania, Etterna);<br>• opciones de exportación: decimales del offset, solo la primera red line, BPM redondeado, ×2/÷2 |
| W3.21 | **Opciones antes de analizar**, todas opcionales y con un valor por defecto que no hace falta tocar:<br>• modo (W11.1);<br>• "la canción tiene un solo BPM" o "cambia de tempo";<br>• rango de BPM esperado o un BPM aproximado;<br>• compás;<br>• analizar solo un tramo (inicio y fin).<br>Una pista mal puesta no puede empeorar el resultado sin avisar: si el audio la contradice, el resultado lo dice |
| W3.22 | **La bandeja de análisis.** Un panel fijo (esquina o barra) visible en todas las páginas, con cada canción propia en curso: nombre, estado, % y posición. Se puede navegar el sitio mientras tanto; al recargar, los ids guardados en el navegador la reconstruyen. Al terminar, la tarjeta lleva al resultado |
| W3.23 | **Avisos** (amplía W3.14): notificación del navegador por canción y por lote, sonido opcional, contador en el título de la pestaña y una bandeja de avisos dentro del sitio. Con cuenta, también por DM de Discord cuando exista el bot (W9.4). Todo opt-in y apagable |
| W3.24 | **Volver a analizar en otro modo** sin volver a subir (el navegador todavía tiene el archivo, o se lo vuelve a elegir y se compara el SHA-1), y **comparar dos resultados** lado a lado: dónde coinciden y dónde no |
| W3.25 | **"Revisá acá".** El resultado marca los tramos con baja confianza, o donde dos métodos no coinciden (W11), con un botón que reproduce ese tramo con el metrónomo |
| W3.26 | **Historial con cuenta:** todo lo que analizaste, buscable y con filtros (fecha, BPM, estado), y borrar lo propio |
| W3.27 | **Página de cada timing** con URL propia: el resultado completo, el gráfico, quién lo subió y la tarjeta Open Graph (imagen del gráfico) para compartirlo en Discord y redes. Base del posteo que enlaza el bot (W9.3) |

**W3.8 hecha el 2026-10-27** en la rama `feature/queue-page`: `/queue` consulta
`GET /api/v1/analyses/queue` cada 3 s (polling y no SSE: una foto por segundo sirve
a todos los que miran). Los tags se leen en el navegador, no en el server. La casilla
"privado" está en el formulario de subida. Detalle en `docs/site.md` y `timeline.md`.

**W3.9 hecha el 2026-10-27** en la rama `feature/multi-upload`: varios archivos o una
carpeta, una tarjeta por canción; topes `ANON_MAX_PENDING`/`USER_MAX_PENDING` (3/10) y
`QUEUE_MAX` (200); orden por turnos entre personas, y a igual turno primero quien hace
más que no recibe un análisis. Probado contra PostgreSQL (PGlite). Detalle en
`docs/site.md` y `timeline.md`.

**W3.2, estado al 2026-10-27:** la rama `feat/overtone-sso` de Mides-Dev-Web ya tiene
los tres cambios: `"overtone"` en `SSO_APPS` como web registrada (orígenes
`overtone.midesprojects.com` y `overtone-experimental.midesprojects.com`, camino
`/login/callback`), el nombre en `APPS` de `Authorize.jsx` y Overtone en
`ecosystem.js` marcado `soon` hasta que el sitio esté arriba; también `docs-sso.md` y
el smoke de CI. Está al día con `main` y sin mergear: falta abrir el PR y mergearlo,
que despliega solo. `GET /api/profile/by-id/<id>` (opcional) se sumó a esa rama el
mismo día: nombre, foto y banner por id, con su caso en el smoke.

**W3.11 hecha el 2026-10-27** en la rama `feature/cache-lookup`: `POST /analyses/lookup`
con el SHA-1 que calcula el navegador; una canción ya analizada no se sube.

**W3.19 hecha el 2026-10-27** en la rama `feature/site-checks-verification`: la sección
Verification de `CLAUDE.md`/`AGENTS.md` suma `pnpm --dir site/api test` (31 pruebas) y
`pnpm --dir site/web build`, y `bench/facts.py` cuenta las llamadas `test(` de
`site/api/test` y `site/web/test` contra el número escrito. Al mergearse con el resto de
W3 los conteos quedaron en 44 (API) y 27 (web), con la línea de `site/web test` sumada.
**W3.5, W3.6 y W3.7 revisadas contra el código el 2026-10-27** (rama
`feature/site-checks-w3-5-7`):
- **W3.5 hecha, con dos desvíos.** Están la cinta, el menú de usuario y las páginas
  Inicio, Analizar, Resultado y Login (más Cola y Perfil). Los colores y la tipografía
  son los de la app de escritorio ("Console"), no los de midesprojects.com: su fuente
  Horizon no tiene licencia conocida y el repo es público (`docs/site.md`, "Look").
  El nav son pestañas subrayadas, no una píldora, y se queda así (decidido el
  2026-10-27 con la delegación del dueño): las pestañas son parte del look de la app
  que el sitio ya adoptó, funcionan en móvil y con teclado, y cambiarlas sería solo
  estética sin ganancia de uso.
- **W3.6 hecha.** Las cuotas separan anónimo y cuenta (`ANON_DAILY_LIMIT`,
  `USER_DAILY_LIMIT`), con la dirección guardada como HMAC del día. El rate limit
  contaba por la dirección en memoria; W3.17 (rama `feature/shared-rate-limit`) lo
  pasa a un HMAC.
- **W3.7 hecha.** Le faltaba algo que la sostenga: `site/web/test/i18n.test.js`
  falla si una clave está en un idioma y no en el otro, si los `{{placeholders}}`
  no coinciden, si un plural queda sin su par o si el código pide una clave que no
  existe.
**W3.18 hecha el 2026-10-27** en la rama `feature/queue-moderation`: un moderador de
Mides (`is_moderator`, guardado como `mides_role`) ve en `/queue` "Sacar" en cada fila
viva y "Devolver a la cola" en la que se está analizando, con un motivo opcional. Cada
acción queda en `moderation_log` (quién, qué, cuándo, por qué) en la misma transacción,
y el registro se ve debajo de la cola. Una fila privada le sigue sin mostrar canción ni
uploader. El usuario de prueba de Google del login de desarrollo es moderador.
**W3.17 hecha el 2026-10-27** en la rama `feature/shared-rate-limit`: con base de datos,
el rate limit cuenta en la tabla `rate_limits` (un upsert por pedido), así que dos
APIs detrás del proxy comparten la cuenta; sin base sigue en memoria. La clave es un
HMAC de la dirección, nunca la dirección. Probado con dos procesos contra PostgreSQL
(PGlite): diez subidas pasaron alternando entre los dos y la undécima recibió 429 en
cualquiera de ellos.
**W3.22 hecha el 2026-10-27** en la rama `feature/site-tray`: una bandeja en todas las
páginas con cada canción propia en curso (nombre, estado, posición, etapa y %, enlace al
resultado, cancelar mientras espera). El seguimiento pasó a un solo store
(`site/web/src/lib/tracker.js`) que leen la página de subida, la del resultado y la
bandeja, así que cada id se consulta una vez; se frena con la antigüedad, la posición,
la cantidad en curso, los errores y la pestaña oculta. Los ids viven en
`sessionStorage` y una recarga la reconstruye. En el celular el botón va en la barra de
arriba y el panel se abre como hoja inferior solo si se pide.
**W3.23 hecha en parte el 2026-10-27** en la misma rama: notificación del navegador por
canción y por lote (opt-in, solo con la pestaña sin foco), sonido opcional hecho con Web
Audio (apagado por defecto), contador en el título en cualquier página y bandeja de
avisos que la persona limpia; las dos opciones quedan en `localStorage`. Falta el aviso
por DM de Discord, que espera al bot (W9.4).
**W3.14 hecha el 2026-10-27** en la rama `feature/batch-notice`: mientras corre un
lote, el título de la pestaña dice "2/5 listas", y una casilla pide permiso para
una notificación del navegador que sale una sola vez, al terminar la última. Usa
los estados que las tarjetas ya consultan: nada nuevo sale del navegador.
**W3.12 hecha el 2026-10-27** en la rama `feature/cancel-own-analysis`:
`DELETE /analyses/:id` borra el trabajo, la fila y el audio mientras sigue en cola,
y la canción no cuenta para la cuota del día. El botón está en la tarjeta, en la
página del análisis y en `/queue`; una ya tomada por el worker contesta 409.
**W3.13 hecha el 2026-10-27** en la rama `feature/m4a-wav-tags`: `lib/tags.js` lee
`©nam`/`©ART` de M4A y `LIST/INFO` (o un chunk `id3 `) de WAV, recorriendo cajas y
chunks aunque estén después del audio; 13 tests con fixtures armados en el test.

**W3.15 hecha el 2026-10-27** en la rama `feature/batch-zip` (sobre W3.14): un botón
debajo de las tarjetas baja un ZIP con el `timing.txt` de cada canción lista, armado
en el navegador con los resultados que ya trajo. ZIP sin compresión y sin dependencia
nueva (`lib/zip.js`, unas cien líneas con su CRC-32).

Las filas W3.11–W3.19 se agregaron el 2026-10-27, después de W3.8 y W3.9: son lo que
esas dos dejaron a la vista (el caché que se ve tarde, la cola que no se puede
corregir, los tags que faltan, los límites que hoy viven en un solo proceso). Ninguna
necesita a otra persona; W3.16 espera la medición de W2.4.

### Fase W4 — Reviactyl

| # | Tarea |
|---|---|
| W4.1 | Eggs de web, API, worker y base de datos en `deploy/eggs/` |
| W4.2 | Entorno `experimental` levantado; los testers entran con el rol de Mides |
| W4.3 | Entorno `master` levantado; subdominio, Cloudflare, backups |
| W4.4 | `deploy/README.md`: cómo se hace un release y un rollback (volver al commit anterior y reiniciar) |
| W4.5 | **Términos y condiciones** (antes de abrir producción), en EN/ES:<br>• Overtone **no está afiliado** a osu! ni a ppy Pty Ltd; "osu!" es marca de sus dueños;<br>• Overtone forma parte de **Mides Projects** y fue fundado por **githalt**;<br>• el código es open source (MIT) y está en `Mides-Projects/Overtone`;<br>• uso aceptable: solo audio que la persona tiene derecho a usar, sin abuso de la cola;<br>• el audio no se guarda; los resultados sí, y pueden mostrarse en la cola o en Community según lo que elija quien sube;<br>• la cuenta es la de Mides, con sus propios términos;<br>• cambios a los términos, contacto y jurisdicción (a definir con Mides Projects LLC)<br>**Borrador hecho el 2026-10-27** (`feature/site-legal`): `/terms` en EN/ES con todo lo de arriba, marcado como borrador en la página. **Falta:** que el dueño lo revise y complete los marcadores (responsable legal y dirección, jurisdicción, contacto) |
| W4.6 | **Disclaimer**, visible en el resultado y en una página propia: el análisis es confiable y repetible, pero **no es 100 % preciso**. Es un punto de partida que se revisa a oído; la confianza que muestra es la del engine, no una precisión medida. Los números de Corpus B y de los stages se publican tal cual, sin redondear para arriba. Sin garantías: los mapas que se rankean siguen siendo responsabilidad del mapper<br>**Hecho el 2026-10-27** (`feature/site-legal`): `/disclaimer` en EN/ES, y el "Revisar a oído" del resultado enlaza ahí. Cita solo el benchmark sintético; los números de Corpus B no están publicados en el sitio todavía |
| W4.7 | **Privacidad:** qué se guarda (SHA-1, metadatos, resultado, hash de IP con sal, cookies), qué no (el audio), por cuánto tiempo y cómo borrarlo. Aviso de cookies solo esenciales, sin banner de consentimiento porque no hay rastreo<br>**Borrador hecho el 2026-10-27** (`feature/site-legal`): `/privacy` en EN/ES, leído del código (schema, servicios, cookies, `localStorage`). **Falta:** plazos de guarda (hoy no hay ningún job que borre análisis, cuentas ni el registro de moderación), el contacto para pedir el borrado y los proveedores de hosting, marcados para el dueño |
| W4.8 | **Créditos y licencias:** Beat This! (MIT), librosa, numpy y las demás dependencias con sus licencias, generadas desde los locks, más el equipo y los contribuidores<br>**Hecho el 2026-10-27** (`feature/site-legal`): `/credits`, generado por `site/web/scripts/credits.mjs` desde `requirements.lock`, los `package.json` y los metadatos instalados. **Falta:** las crates de Rust, que el sitio no usa todavía |
| W4.9 | **Branches protegidas de verdad:** quien pushea a `master` o `experimental` ejecuta código en los servers. Exigir PR (también a los admins) y, mejor, un segundo par de ojos para `master` |

### Fase W5 — Social v1 y Community

Publicar timings, página de canción, estrellas, reacciones, "usar/importar" con su
contador, comentarios, la pestaña Timings en el perfil, fork con crédito,
notificaciones. Y una sección **Community**:

| # | Tarea |
|---|---|
| W5.1 | **Recientes de todos:** las canciones timeadas por cualquiera (salvo las privadas), con portada, título, BPM, quién las subió y cuándo. Filtros (BPM, un solo tempo o variable, fecha), búsqueda por artista o título, y "más usados" o "mejor puntuados" cuando existan las estrellas |
| W5.2 | **Sugerencias**, con estado visible:<br>• estados: abierta → en revisión → aceptada / planeada → en progreso → hecha, o rechazada (siempre con motivo);<br>• votos (uno por cuenta), comentarios y duplicados que se unen;<br>• **el staff de Mides** (roles de Mides, no una lista propia) las toma, cambia su estado, responde y las enlaza al roadmap o al changelog;<br>• cada cambio de estado avisa a quien la propuso |
| W5.3 | **Reseñas del sitio:** estrellas de 1 a 5 más texto, con la cuenta de Mides o anónimas (anónimas con rate limit por IP hasheada y una verificación anti-spam; pesan menos en el promedio y lo dicen). Respuesta pública del staff, reporte y moderación, y edición o borrado de la propia |
| W5.4 | **Moderación común** a sugerencias, reseñas, comentarios y nombres en la cola: reportar, ocultar, registro de quién hizo qué y filtro de palabras. Reusa los roles y sanciones de Mides |
| W5.5 | **Changelog en el sitio**, generado de `docs/timeline.md`: qué cambió y qué sugerencias cerró cada versión |
| W5.6 | **Perfiles:** la pestaña Timings en el perfil de Mides (ADR-W3), con estadísticas (canciones timeadas, usos, estrellas) e insignias (primer timing, Ranked-match, sugerencia aceptada) |

### Fase W6 — Social v2

Colecciones, ranking de timers (por usos y estrellas), la insignia Ranked-match,
reportes y panel de moderación con los roles de Mides, posts en el Feed de Mides,
metadatos de osu! (beatmapset).

### Fase W7 — Editor en el navegador

Portar la edición de la sección Timing de la app de escritorio: mover, fijar,
partir/unir, compás, offset lab, metrónomo sobre el audio local. El audio nunca sale
del navegador del usuario. La app de escritorio se estacionó el 2026-10-26: su código
de referencia (`app/app.js`, `overtone_web.py`) está en `parked/desktop-app`, y las
funciones puras de edición que llamaba (`add_timing_point`, `nudge_timing_point`,
`split_section`, `merge_sections`, `set_meter`…) siguen en `python/overtone.py`.

### Fase W8 — Vuelven las piezas estacionadas, bien hechas

Hitsounds primero, con su propia puerta de calidad antes de mostrarse. Después Train
y Compile, si tienen sentido en web. Rust en el worker cuando Corpus B lo justifique.

### Fase W9 — Discord, osu! y el bot

| # | Tarea |
|---|---|
| W9.1 | **Vincular Discord:** si la cuenta de Mides ya tiene Discord vinculado, se usa; si no, el sitio ofrece vincularlo con el flujo de Mides (`connections/discord/link-token` con `return_to` al sitio), sin un OAuth propio |
| W9.2 | **Vincular osu!:** OAuth de la API v2 de osu! (scope `identify`, nada más), registrada como app de Mides Projects. Muestra el perfil de osu! en el de Overtone y permite, más adelante, relacionar un timing con un beatmapset. Leer y cumplir las reglas de la API de osu! antes de pedir la key |
| W9.3 | **Bot de Discord** en el monorepo (`bot/`, mismo stack que cavernia-bot), con el comando `/time-song`:<br>• recibe un adjunto de audio y lo encola en la misma cola que el sitio, con los mismos límites; el dueño es la cuenta vinculada (sin vincular: el cupo anónimo, o directamente no, a decidir);<br>• responde con un embed: BPM, offset, red lines y confianza;<br>• adjunta una imagen del gráfico, renderizada en el worker con el mismo diseño que el sitio;<br>• enlaza a la página del timing (W3.27);<br>• el audio sigue la misma regla: se borra después de analizar |
| W9.4 | **Avisos por DM** del bot cuando termina un análisis (opt-in, W3.23) |
| W9.5 | **Más comandos:**<br>• `/timing <link>` muestra un timing publicado;<br>• `/queue` muestra el estado de la cola;<br>• `/compare` compara dos timings;<br>• un comando para ver los últimos timings de alguien |
| W9.6 | **Sin bajar audio de osu!.** Analizar un beatmapset directo desde su link exigiría bajar el `.osz`; no se hace sin confirmar que las reglas de osu! lo permiten. Hasta entonces, la persona sube su archivo |

### Fase W10 — Calidad, rendimiento y profesionalismo

| # | Tarea |
|---|---|
| W10.1 | **Presupuestos de rendimiento** medidos con Lighthouse local y Web Vitals: LCP < 2,5 s, CLS < 0,1, JS inicial < 200 kB comprimido. Code splitting por ruta, carga diferida del gráfico y del lector de tags, fuentes del sistema, compresión brotli o gzip y caché larga para los assets con hash. Cada número se mide y se anota (regla 1) |
| W10.2 | **Accesibilidad WCAG 2.2 AA:** teclado completo, foco visible, contraste, `aria-live` para el progreso y texto alternativo del gráfico (tabla de red lines) |
| W10.3 | **SEO e imagen:** meta y Open Graph por página, `sitemap.xml`, `robots.txt` y el favicon y manifest de la PWA<br>**Hecho el 2026-10-27** (`feature/site-legal`): título y descripción por página (`usePageMeta`), Open Graph y Twitter en `index.html`, `robots.txt`, `sitemap.xml`, manifest e íconos PNG generados desde `favicon.svg` sin dependencia nueva. **Falta:** Open Graph por página para los crawlers (hoy leen el `index.html` de todas las rutas) y un `robots.txt` que cierre staging |
| W10.4 | **Robustez de la interfaz:** error boundaries, estados vacíos y de carga en todas las vistas, reintento con backoff y página de estado del servicio (se suma a `/status` de Mides)<br>**Hecho en parte el 2026-10-27** (`feature/site-legal`): error boundaries, `/status` (API, base de datos y worker desde `GET /api/v1/health`) con reintento y backoff. Las vistas que había ya tenían sus estados de carga y vacíos. **Falta:** el backoff en las otras vistas que sondean (cola, resultado) y sumarse al `/status` de Mides |
| W10.5 | **Skills del proyecto** en `.claude/skills/`, para que cualquier sesión trabaje igual:<br>• `site-ui-check`: levanta `pnpm dev`, recorre las páginas, saca capturas y revisa consola, EN/ES, oscuro/claro y 375 px;<br>• `perf-audit`: Lighthouse y tamaño del bundle;<br>• `security-review`: las 5 áreas de la revisión del 2026-10-27;<br>• `release`: experimental → master con las puertas |
| W10.6 | **Pruebas de punta a punta** del sitio (Playwright local, sin CI): subir, cola, resultado, descargas y login de prueba, una sola línea en la sección Verification |
| W10.7 | **Revisión de seguridad periódica,** con las mismas 5 áreas, antes de cada release a `master` y después de cada feature que toque la API, la subida o el despliegue |

### Fase W11 — Precisión: modos de análisis y un engine que elige

El objetivo es acercarse más a los timings que ponen los mappers. La meta es **+5
puntos o más** en las métricas held-out de los stages (tempo ok, octava, beats dentro
de 10 ms, red lines dentro de 5 ms), sin romper ninguna puerta de precisión.

| # | Tarea |
|---|---|
| W11.1 | **Modos de análisis**, elegidos por el tiempo que la persona quiere esperar y no por el engine. Tiempos de referencia en esta PC (2026-10-27, canción de 4:36), a medir de nuevo en el server (W2.4):<br>• **Rápido**, unos 10 s: el engine v3 sin el voto de Beat This! ni los jueces de octava (10,6 s medidos);<br>• **Normal**, menos de 2 min: el análisis actual, con el voto de Beat This! y los jueces (49–66 s medidos);<br>• **Estricto**, de 3 a 5 min: el ensamble de W11.3, con revisión por tramos y todo lo que mejore el held-out aunque cueste tiempo.<br>Cada resultado dice con qué modo se hizo; la caché se separa por modo |
| W11.2 | **Estudio oráculo primero, antes de construir nada.** Correr K configuraciones sobre los stages:<br>• v3 con y sin voto;<br>• Rust;<br>• Beat This! solo;<br>• los variantes de octava (fold, halve, judge);<br>• el tracker local.<br>Después medir, en held-out, cuánto se gana si para cada canción se eligiera la mejor. Si ese techo no supera en 5 puntos a la mejor configuración sola, el ensamble no vale la pena y se dice. Todo con `bench/stages.py` y las corridas del server (`bench/remote.py`) |
| W11.3 | **El engine que elige (router)**, si el oráculo da margen:<br>• **Rasgos baratos de la canción:** variabilidad del tempo local (tracker), BPM base y su rango, densidad de onsets, fuerza del pulso, acuerdo o desacuerdo entre métodos, confianza y género si se infiere.<br>• **Elección:** con esos rasgos, elige por canción, y mejor por tramo, qué método manda: reglas simples o un árbol chico.<br>• **Entrenamiento y evaluación:** se entrena solo en dev y se juzga solo en held-out, para no sobreajustar a Corpus B (20 canciones).<br>• **Consenso:** donde dos métodos coinciden, se toma su consenso; donde no, el que mejor explica los ataques de la canción (como ya hace el voto) y el tramo queda marcado "revisá acá" (W3.25) |
| W11.4 | **Pulido de fase en el modo estricto:** re-timing fino de cada red line contra los ataques (la métrica más baja hoy es la fase: S1 37,5 % dentro de 5 ms), con la convención de osu! aplicada al final |
| W11.5 | **Pistas de la persona como restricción** (W3.21): un solo BPM, un rango o un compás reducen el espacio que el router explora, y se mide cuánto mejora el held-out con pistas correctas |
| W11.6 | **Aprender de los mappers:** con permiso, los timings que la gente corrige (W7) y publica son datos nuevos para los stages, nunca para entrenar a ciegas; cada uno con su SHA-1 y su licencia clara |

---

## 7. Decisiones abiertas (las toma el dueño)

1. **Dominio:** `overtone.midesprojects.com` (recomendado) o uno propio.
   `mapping.` queda descartado: MAPPING es la página de mapas de Minecraft.
2. **Postgres en un egg** (recomendado), o configurar un database host MySQL en el
   panel.
3. **Cuánto CPU y RAM le da el nodo NA-01 al worker**, y si se activa el voto de
   Beat This! (~1,5 GB por análisis) o se arranca sin él (~100 MB).
4. **Historial:** reescribir el email de los commits, o aceptarlo.
5. **Titular de la licencia:** githaltwastaken o Mides Projects LLC. MIT en los dos
   casos.
6. **Cuota anónima:** análisis por día y duración máxima.
7. **¿Se guarda el audio?** Este plan dice que no (ADR-W4).
8. ~~**La app de escritorio:** ¿sigue distribuyéndose (MSI) o pasa a ser solo
   herramienta de desarrollo?~~ **Decidido el 2026-10-26:** ni una cosa ni la otra; se
   estaciona entera en `parked/desktop-app` (tag `v3-desktop-app`) y Overtone es solo
   web.

## 8. Lo que depende de otras personas

- **Dueño de Mides-Dev-Web:** aprobar el PR de W3.2. El perfil público y el posteo
  al muro ya existen. La estética ya se puede leer del repo (acceso dado el
  2026-10-26).
- **Admin de Reviactyl:**
  - crear los servers en Custom Engine con tope de CPU;
  - dar dos puertos en NA-01;
  - decir dónde vive el proxy TLS que publica `api.midesprojects.com`.
