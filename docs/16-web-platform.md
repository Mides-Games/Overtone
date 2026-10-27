# 16 — Overtone en Mides: la plataforma web de timings

Escrito el 2026-10-26. Es el plan del giro: Overtone pasa de ser una app de escritorio
personal a un sitio de **Mides Projects** cuyo foco es entregar timings, con cuentas
de Mides, perfiles y una capa social. El repositorio se muda a la organización
`Mides-Projects` y se publica como open source.

Este documento es la fuente de verdad del giro, como `roadmap/` lo es en Cavernia.
Ninguna fase arranca sin su fila acá, y las decisiones de arquitectura se escriben
antes de aplicarse.

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
  - el **engine** y la **app de escritorio** siguen sin red;
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
  - La app de escritorio sigue funcionando para el uso offline.

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

### Fase W5 — Social v1

Publicar timings, página de canción, estrellas, reacciones, "usar/importar" con su
contador, comentarios, la pestaña Timings en el perfil, fork con crédito,
notificaciones.

### Fase W6 — Social v2

Colecciones, ranking de timers (por usos y estrellas), la insignia Ranked-match,
reportes y panel de moderación con los roles de Mides, posts en el Feed de Mides,
metadatos de osu! (beatmapset).

### Fase W7 — Editor en el navegador

Portar la edición de la sección Timing de la app de escritorio: mover, fijar,
partir/unir, compás, offset lab, metrónomo sobre el audio local. El audio nunca sale
del navegador del usuario.

### Fase W8 — Vuelven las piezas estacionadas, bien hechas

Hitsounds primero, con su propia puerta de calidad antes de mostrarse. Después Train
y Compile, si tienen sentido en web. Rust en el worker cuando Corpus B lo justifique.

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
8. **La app de escritorio:** ¿sigue distribuyéndose (MSI) o pasa a ser solo
   herramienta de desarrollo?

## 8. Lo que depende de otras personas

- **Dueño de Mides-Dev-Web:** aprobar el PR de W3.2. El perfil público y el posteo
  al muro ya existen. La estética ya se puede leer del repo (acceso dado el
  2026-10-26).
- **Admin de Reviactyl:**
  - crear los servers en Custom Engine con tope de CPU;
  - dar dos puertos en NA-01;
  - decir dónde vive el proxy TLS que publica `api.midesprojects.com`.
