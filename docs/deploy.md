# Despliegue en Reviactyl

Cómo se publica Overtone en el panel de Mides (`console.midesprojects.com`, un
fork de Pterodactyl), en el nodo **NA-01**. El plan general está en
`docs/16-web-platform.md` §2 (ramas) y §5 (despliegue). Este documento es el
manual: lo que un admin del panel hace, en orden.

Nada de esto corrió todavía en el panel. Lo que sí se probó está en
[Qué se verificó](#qué-se-verificó-y-qué-no).

## Qué hay en `deploy/`

| Archivo | Qué es |
|---|---|
| `deploy/eggs/egg.py` | Genera los cuatro eggs. `--check` falla si los JSON no coinciden con los scripts. |
| `deploy/eggs/egg-overtone-{web,api,worker,db}.json` | Los eggs, listos para **Import Egg**. Generados: no se editan a mano. |
| `deploy/eggs/install.sh` | Instalación de web, api y worker: clona el repo (y el modelo, en el worker). |
| `deploy/eggs/install-db.sh` | Instalación de la base: no baja nada, solo avisa si ya hay un cluster. |
| `deploy/eggs/start.sh` | El arranque de web, api y worker: actualiza, prepara dependencias y arranca. |
| `deploy/web/serve.mjs` | El servidor de `overtone-web`: estáticos de `site/web/dist` y `/api` hacia la API. |

Para regenerar los eggs después de tocar un script:

```bash
python deploy/eggs/egg.py
```

### Por qué un estático en Node y no nginx

`overtone-web` sirve `site/web/dist` con `deploy/web/serve.mjs`, unas 150 líneas
sin dependencias, y reenvía `/api/*` a `overtone-api`:

- **Un solo origen.** El navegador habla solo con la web, así que no hace falta
  CORS, y la API no necesita hostname público. El proxy TLS publica un puerto por
  entorno y nada más.
- **Node ya está en la imagen**, porque hace falta para el build. Con nginx serían
  dos procesos en un contenedor, o un server más por entorno.
- **Los headers de caché van en el código:** `/assets/*` (con hash de Vite) se
  cachea un año, e `index.html` nunca. Así un release se ve en la próxima carga.
- **Los cuerpos pasan en streaming**, sin buffer. Un audio subido llega entero a
  la API, que es la que pone el límite.

Si algún día hace falta compresión o HTTP/2, eso lo hace el proxy TLS de adelante,
no este proceso.

### Imágenes

| Egg | Imagen | Por qué |
|---|---|---|
| web, api | `ghcr.io/parkervcp/yolks:nodejs_24` | Debian, con git y corepack (pnpm). |
| worker | `ghcr.io/parkervcp/yolks:python_3.14` | Debian. Las imágenes Python de `reviactyl/images` son Alpine (musl), y numpy, numba, scipy y onnxruntime solo publican wheels manylinux. |
| db | `postgres:18` (oficial) | Corre tal cual. Wings arranca el entrypoint de la imagen y nunca evalúa la línea de startup del egg, así que todo se configura por variables de entorno. |

Wings (el daemon) no reemplaza el entrypoint, y corre el contenedor con el uid del
panel. Esto se leyó en su código: `environment/docker/container.go`. La imagen
oficial de postgres soporta un uid arbitrario: crea el cluster con `nss_wrapper`,
y `/var/run/postgresql` es escribible por todos.

## 1. Importar los eggs

1. **Admin → Nests → Custom Engine** (el nest de Edge) → **Import Egg**. Repetir
   con cada uno de `deploy/eggs/egg-overtone-web.json`, `-api`, `-worker` y `-db`.
   Si se prefiere un nest propio, primero **Create New** "Overtone" y se importan
   ahí.
2. En cada egg importado, revisar la pestaña **Variables**. Los defaults ya
   vienen: `GIT_ADDRESS` apunta a `https://github.com/githaltwastaken/Overtone.git`.
   Si el repo se transfiere a `Mides-Projects` (W0.8), se cambia ahí o en cada
   server.

## 2. Puertos y allocations

Hacia afuera solo se publican las dos webs. El resto de los servers se habla por la
red de Docker del nodo: allocations en la IP del bridge de Wings, `<bridge-ip>`
(es la `docker.network.interface` de `/etc/pterodactyl/config.yml`; hay que
confirmarla en NA-01). Un puerto en esa IP no se ve desde internet, pero sí lo
alcanza cualquier contenedor del nodo.

Este documento no publica direcciones ni puertos: `<node-ip>` es la IP pública del
nodo, `<bridge-ip>` la del bridge, y cada `<…-port>` el puerto de la allocation de
ese server. Los valores concretos viven en el panel (**Admin → Nodes → NA-01 →
Allocation** y la pestaña **Network** de cada server), no en el repo.

| Server | Allocation | Quién llega |
|---|---|---|
| `overtone-web` (master) | `<node-ip>:<web-port>` | el proxy TLS |
| `overtone-web-exp` (experimental) | `<node-ip>:<web-exp-port>` | el proxy TLS |
| `overtone-api` | `<bridge-ip>:<api-port>` | `overtone-web` |
| `overtone-api-exp` | `<bridge-ip>:<api-exp-port>` | `overtone-web-exp` |
| `overtone-worker` | `<bridge-ip>:<worker-port>` | nadie: no escucha. El panel pide una allocation igual. |
| `overtone-worker-exp` | `<bridge-ip>:<worker-exp-port>` | nadie |
| `overtone-db` | `<bridge-ip>:<db-port>` | las dos APIs y los dos workers |

**Admin → Nodes → NA-01 → Allocation:** crear `<bridge-ip>` con los cinco puertos
de la API, el worker y la base (los dos entornos). Los de las dos webs van en la IP
pública, en puertos que estén libres.

Si no se quieren allocations en el bridge, se pueden usar puertos de la IP
pública. En ese caso hay que cerrarlos en el firewall del nodo para todo lo que no
sea Docker, porque si no, la base y la API quedan expuestas a internet.

Lo mismo vale para los puertos de las webs: quien les pegue directo se salta el
TLS. Lo ideal es que el firewall los abra solo para el proxy (ver
[§9](#9-tls-la-pregunta-abierta)).

## 3. Los siete servers

Todos van en **NA-01**. Los tamaños salen de lo medido el 2026-10-25 (`docs/server.md`):
un análisis con el voto de Beat This! llega a 1,46 GB de RAM y ocupa unos cinco
núcleos. Sin el voto son 101 MB.

| Server | Egg | Branch | RAM | CPU limit | Threads (pinning) | Disco | Block IO | OOM killer |
|---|---|---|---|---|---|---|---|---|
| `overtone-web` | web | master | 1024 MB | 100 % | — | 3 GB | 500 | on |
| `overtone-api` | api | master | 512 MB | 100 % | — | 2 GB | 500 | on |
| `overtone-worker` | worker | master | 2048 MB | **400 %** | **4 núcleos propios** | 8 GB | **100** | on |
| `overtone-web-exp` | web | experimental | 1024 MB | 100 % | — | 3 GB | 500 | on |
| `overtone-api-exp` | api | experimental | 512 MB | 100 % | — | 2 GB | 500 | on |
| `overtone-worker-exp` | worker | experimental | 2048 MB | **200 %** | **2 núcleos propios** | 8 GB | **100** | on |
| `overtone-db` | db | — | 1024 MB | 100 % | — | 10 GB | 500 | on |

En total son **8 GB de RAM** y, en el peor caso, 10 núcleos (6 de ellos de los
workers). Swap en 0 en todos.

- **Por qué la web pide 1 GB:** es el pico del `vite build` en el arranque que
  trae código nuevo. Sirviendo usa menos de 100 MB.
- **RAM del worker:** se calcula como `WORKER_CONCURRENCY × 1,5 GB + 0,5 GB`. Con
  `WORKER_CONCURRENCY=1` son 2 GB. Cada análisis simultáneo más suma 1,5 GB, y CPU
  en proporción. Si se arranca sin el voto (decisión abierta 3 del plan), alcanza
  con 512 MB, pero las red lines pueden diferir de la app.
- **El CPU limit no alcanza solo.** Con el límite, el worker no pasa de cuatro
  núcleos de cuota, pero esa cuota la toma de cualquier núcleo, incluidos los que
  usan los servers de Minecraft en ese momento. El **pinning** (el campo
  *Threads*, un cpuset como `28-31`) lo encierra en núcleos fijos. Así, lo peor que
  puede pasar es que esos núcleos se llenen, y no que se produzca lag en el resto:
  - En NA-01, `nproc` dice cuántos hay. Se toman los últimos: prod `N-4` a `N-1`,
    y staging los dos anteriores.
  - Los servers de Minecraft no van pinneados, así que pueden seguir usando esos
    núcleos. El pinning protege en un sentido: que el worker no salga de los suyos.
- **`WORKER_THREADS`** es igual al CPU limit dividido por 100 (4 en prod, 2 en
  staging). Las librerías numéricas dimensionan su pool por los núcleos de la
  máquina, no por el límite: sin esto, el worker arranca decenas de hilos que se
  pelean por cuatro núcleos de cuota.
- **OOM killer encendido:** si un análisis se pasa de la RAM, el kernel mata el
  proceso y el panel lo reinicia (crash detection). Con el OOM killer apagado, el
  contenedor se queda congelado en el tope.
- **Block IO 100** en los workers: decodificar audio no tiene que competir con
  los mundos de Minecraft escribiendo a disco.

### Variables por server

En todos: `BRANCH` según la tabla, `AUTO_UPDATE=1`, `USER_UPLOAD=0` y
`ROLLBACK_COMMIT` vacío. `GIT_TOKEN` se completa mientras el repo sea privado, con
un fine-grained token de solo lectura (*Contents: read*) sobre el repo. Cuando el
repo es público, se deja vacío.

| Server | Variables propias |
|---|---|
| `overtone-web` | `API_UPSTREAM=http://<bridge-ip>:<api-port>` |
| `overtone-web-exp` | `API_UPSTREAM=http://<bridge-ip>:<api-exp-port>` |
| `overtone-api` | `DATABASE_URL=postgres://<rol-prod>:<pw>@<bridge-ip>:<db-port>/overtone`, `SITE_URL=https://overtone.midesprojects.com`, `TRUST_PROXY=2`, `SESSION_SECRET`, `TOKEN_KEY`, `MIDES_AUTH_URL`, `MIDES_WEB_URL`, `MIDES_APP`, `ANON_DAILY_LIMIT`, `MAX_AUDIO_SECONDS` |
| `overtone-api-exp` | Las mismas. `DATABASE_URL=…<rol-staging>:<pw>@<bridge-ip>:<db-port>/overtone_experimental`, `SITE_URL` de staging, y **secretos distintos** de los de prod. |
| `overtone-worker` | `DATABASE_URL` (la de prod), `WORKER_CONCURRENCY=1`, `MAX_AUDIO_SECONDS`, `WORKER_THREADS=4` |
| `overtone-worker-exp` | `DATABASE_URL` (la de staging), `WORKER_CONCURRENCY=1`, `MAX_AUDIO_SECONDS`, `WORKER_THREADS=2` |
| `overtone-db` | `PGPORT=<db-port>`, igual al puerto de la allocation. `POSTGRES_PASSWORD`: 24 caracteres o más. `POSTGRES_USER=postgres`, `POSTGRES_DB=overtone` y `PGDATA` vienen por defecto. |

Los secretos se generan con `openssl rand -hex 32`. Viven solo en las variables
del panel, nunca en el repo. Las variables secretas del egg están marcadas como no
visibles para el dueño del server: solo un admin las lee.

## 4. Primer arranque

El orden importa la primera vez: **db → api → worker → web**.

1. **`overtone-db`.** La primera vez crea el cluster en `/home/container/pgdata` y
   termina con `database system is ready to accept connections`. Después se crean
   el rol de cada entorno y la base de staging. La consola del panel no sirve para
   esto, porque postgres no lee lo que se le escribe ahí. Se hace desde NA-01, como
   root. `<uuid>` es el UUID del server (Admin → Servers → overtone-db); Wings
   nombra así su contenedor.

   ```bash
   docker exec -i <uuid> psql -U postgres -d overtone -v ON_ERROR_STOP=1 -c "CREATE ROLE <rol-prod> LOGIN PASSWORD '<pw-prod>'" -c "CREATE ROLE <rol-staging> LOGIN PASSWORD '<pw-staging>'" -c "ALTER DATABASE overtone OWNER TO <rol-prod>" -c "ALTER SCHEMA public OWNER TO <rol-prod>" -c "CREATE DATABASE overtone_experimental OWNER <rol-staging>" -c "REVOKE ALL ON DATABASE overtone FROM PUBLIC" -c "REVOKE ALL ON DATABASE overtone_experimental FROM PUBLIC"
   ```

   ```bash
   docker exec -i <uuid> psql -U postgres -d overtone_experimental -v ON_ERROR_STOP=1 -c "ALTER SCHEMA public OWNER TO <rol-staging>"
   ```

   `<rol-prod>` y `<rol-staging>` son los nombres de rol que se elijan; se anotan,
   como las contraseñas, solo en las variables del panel.

   Así staging no puede leer ni tocar la base de producción. Cada base se puede
   volcar, restaurar o borrar por separado. El plan decía "dos schemas en una
   base", y dos bases cumplen lo mismo con un límite más fuerte.

2. **`overtone-api`.** El primer arranque instala las dependencias de producción
   de `site/api` con pnpm, desde `pnpm-lock.yaml` (sin lockfile no arranca). Corre
   `node site/api/src/db/migrate.js` y después el server.
3. **`overtone-worker`.** El primer arranque crea `.venv` e instala
   `python/requirements.lock`, sin su última sección, que es la de pywebview para
   Windows. Puede tardar varios minutos. El modelo de Beat This! ya lo bajó la
   instalación con `git lfs pull`.
4. **`overtone-web`.** El primer arranque hace `pnpm install` y `pnpm --dir site/web build`,
   y después sirve `site/web/dist`.

Hay que esperar a que la rama tenga `site/`, `worker/main.py`, `pnpm-lock.yaml` y
este `deploy/`. Hasta entonces, cada server dice qué le falta y no arranca.

### Lo que `start.sh` espera de la API y del worker

Estos son contratos para quien escribe `site/api` y `worker/main.py`:

- **La API** escucha en `PORT` sobre `HOST` (el script los exporta desde la
  allocation, con `HOST=0.0.0.0`). Cuando está lista, imprime
  `overtone-api: listening on <puerto>`: esa línea es la que el panel usa para
  marcarla como encendida. `migrate.js` se puede correr en cada arranque sin
  efecto si no hay nada nuevo, y las migraciones son aditivas: un worker viejo
  sigue funcionando un rato contra el schema nuevo.
- **El worker** imprime `overtone-worker: ready` cuando empieza a tomar trabajos.
  Al recibir `SIGINT` (el stop del panel) deja de tomar trabajos, y termina o
  devuelve a la cola el que tiene. Wings espera hasta **10 minutos** antes de
  matarlo. La sesión de onnxruntime usa `WORKER_THREADS` hilos (`intra_op_num_threads`).
  Las otras librerías ya los toman de `OMP_NUM_THREADS` y similares, que el script
  exporta.

## 5. Cómo es un release

En el panel, el release es reiniciar. Push a GitHub no despliega nada solo.

1. `feat/*` → PR a `experimental` → merge.
2. En el panel, reiniciar `overtone-api-exp`, `overtone-worker-exp` y
   `overtone-web-exp`, en ese orden: la migración va primero.
3. Probar en staging.
4. PR `experimental` → `master` → merge → reiniciar `overtone-api`,
   `overtone-worker` y `overtone-web`.

Esto hace `start.sh` en cada arranque, con `AUTO_UPDATE=1`. Es la lógica que
tenía `deploy/overtone-update.sh` en la VPS:

- **Solo fast-forward a `origin/$BRANCH`.** Si la rama se reescribió, si alguien
  editó un archivo versionado en el server, o si el checkout está en otra rama, se
  deja como está, se dice en la consola, y arranca con el código que tiene. Nunca
  hace merge ni reset.
- **Si GitHub no responde,** arranca con el código actual.
- **El código nuevo nunca corre con dependencias viejas.** Las dependencias de
  cada rol (el `node_modules` de la API, el build de la web, el `.venv` del
  worker) se identifican por un hash de los archivos de los que salen:
  - si el hash cambió, se reinstalan;
  - si no cambió, el arranque es inmediato;
  - si la reinstalación falla, el server **no arranca**, en vez de quedar con una
    mitad de cada release.
- **Si el update trae un `start.sh` nuevo,** se ejecuta el nuevo.
- **Un análisis en curso no se corta por un update.** El update ocurre después de
  que el panel paró el proceso anterior, y el stop le da tiempo al worker (ver el
  contrato de arriba).
- **Cada movimiento queda en `.overtone/deployed.log`** (fecha, qué pasó, commit,
  rama), visible desde el file manager del panel.

Para cambiar un server de rama: cambiar `BRANCH` y hacer **Reinstall**. La
reinstalación cambia el clon de rama y no borra lo que git no versiona. Un arranque
nunca cambia de rama solo.

## 6. Rollback

- **Lo normal:** se revierte en GitHub (`git revert` del merge), se mergea a la rama
  y se reinicia. La historia queda lineal y `AUTO_UPDATE` sigue funcionando.
- **Urgente, sin esperar un PR:**
  1. En el file manager, leer `.overtone/deployed.log` y copiar el commit anterior.
  2. Ponerlo en la variable `ROLLBACK_COMMIT` del server (Startup) y reiniciar.
  3. El server arranca en ese commit, reinstala lo que haga falta, y no se
     actualiza mientras la variable esté puesta.

  `ROLLBACK_COMMIT` solo acepta commits que el server ya tuvo en su rama. Cuando el
  arreglo está en la rama, se vacía la variable y se reinicia: vuelve a la rama y
  hace fast-forward.
- **Las migraciones no vuelven atrás.** Por eso tienen que ser aditivas: así el
  código viejo funciona contra el schema nuevo. Si una migración rompió datos, se
  restaura un backup (§7).

## 7. Backups

Los servers web, api y worker no necesitan backup: el código sale de git y las
dependencias se reconstruyen. Solo importa `overtone-db`.

1. **Backup del panel, diario y en frío.** En `overtone-db` → Schedules → New:
   todos los días a las 04:30 UTC, con tres tareas:
   - *Power: stop*;
   - *Create backup*, con offset de 30 s;
   - *Power: start*, con offset de 30 s.

   Con postgres parado, el tar de `/home/container` es un cluster consistente. Se
   pierden unos segundos de API a esa hora (la API tiene que reintentar la
   conexión). El límite de backups del server va en 7. Hay que confirmar que la
   versión de Reviactyl rota el más viejo cuando se llega al límite: si no lo hace,
   la tarea falla y hay que borrarlo a mano.
2. **`pg_dump` lógico, diario, desde el host.** El panel no puede programarlo: sus
   tareas solo mandan comandos a la consola, y postgres no la lee. Va en el crontab
   de root en NA-01:

   ```bash
   30 4 * * * mkdir -p /var/backups/overtone && docker exec <uuid> pg_dump -U postgres -Fc overtone > /var/backups/overtone/overtone-$(date +\%F).dump && find /var/backups/overtone -name '*.dump' -mtime +14 -delete
   ```

   Staging no se respalda: se puede recrear. Los dumps tienen que salir del nodo
   (a un bucket o a otra máquina). Un backup que vive en el mismo disco no
   protege del disco.
3. **Probar la restauración** una vez, y después de cada cambio grande de schema:

   ```bash
   docker exec -i <uuid> sh -c 'createdb -U postgres restore_test && pg_restore -U postgres -d restore_test' < /var/backups/overtone/overtone-<fecha>.dump
   ```

## 8. Actualizar PostgreSQL

Wings vuelve a bajar `postgres:18` en cada arranque, así que las versiones menores
(18.x) llegan solas. Pasar a la 19 es otra cosa: cambia el formato del data dir.
Se hace con `pg_dump` → un server nuevo con la 19 → `pg_restore`. Nunca se cambia
la imagen de un server con datos.

## 9. TLS: la pregunta abierta

El panel no termina TLS y el daemon de NA-01 no usa SSL. Edge ya está publicado
en `api.midesprojects.com` a través de **algún proxy**, y no se sabe todavía cuál.
Overtone tiene que ir detrás de ese mismo proxy:

| Hostname | Destino |
|---|---|
| `overtone.midesprojects.com` | `<node-ip>:<web-port>` |
| `experimental.overtone.midesprojects.com` | `<node-ip>:<web-exp-port>` |

La API no necesita hostname propio: entra por la web en `/api`. Lo que cambia
según el proxy:

- **Cloudflare (DNS con proxy naranja):**
  - Cloudflare solo proxea ciertos puertos (80, 443, 8080, 8443, 2052…). Para
    llegar a `<web-port>` hace falta una *Origin Rule* que reescriba el puerto, o un
    Cloudflare Tunnel.
  - El certificado universal cubre `*.midesprojects.com`, **pero no
    `*.overtone.midesprojects.com`**. Para `experimental.overtone…` hace falta
    *Advanced Certificate Manager* o *Total TLS*. Si no, se usa un nombre de un
    solo nivel, como `overtone-experimental.midesprojects.com`.
  - Conviene limitar los puertos de las webs en el firewall a los rangos de IP de Cloudflare.
- **nginx o Caddy en el host de NA-01:** sin límite de puertos ni de niveles
  (certbot o Caddy emiten el certificado). Las allocations de las webs pueden ir
  en `127.0.0.1`, y entonces ni siquiera quedan expuestas.

En los dos casos, el proxy tiene que mandar `X-Forwarded-Proto: https` y
`X-Forwarded-For`. `serve.mjs` pasa `X-Forwarded-Proto` tal como llega, para que la
API sepa que la cookie de sesión va por HTTPS. `X-Forwarded-For` no: se queda con
las últimas `TRUSTED_PROXY_HOPS` entradas (las que agregó el proxy; 1 por defecto)
más la dirección de la conexión, y descarta lo que el cliente haya escrito antes.
La API confía en esos saltos con `TRUST_PROXY=2` (el proxy TLS y `serve.mjs`), y
así el rate limit cuenta por visitante y no por `serve.mjs`. Si delante hay dos
proxies (Cloudflare y además nginx), son `TRUSTED_PROXY_HOPS=2` y `TRUST_PROXY=3`.
Quien llegue directo al puerto podría falsificarlos, y por eso el firewall importa.

`serve.mjs` manda en cada página `Content-Security-Policy` (solo el propio origen;
imágenes también de `https:`, por los avatares y banners de Mides; el script
inline de `index.html` se permite por su hash, calculado del build),
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` y,
con `HSTS=1` (el default del egg), `Strict-Transport-Security: max-age=31536000`.
`HSTS=0` solo si el sitio se sirve por http.

**Falta que el admin de Reviactyl diga dónde corre ese proxy.** Con eso, este
apartado pasa a ser un paso más.

## Qué se verificó y qué no

Se verificó, el 2026-10-26, en Windows con Git Bash:

- **Los eggs:**
  - `python deploy/eggs/egg.py --check` pasa: los cuatro JSON coinciden con los
    scripts, y tienen la forma PTDL_v2 de un egg real.
  - Las claves y los tipos se compararon con el `eggs/egg.js` de Cinder y con los
    eggs *Node.js generic* y *PostgreSQL 16* de `parkervcp/eggs`. La única
    diferencia son los nombres de las imágenes.
- **Los scripts:** pasan `sh -n` y `bash -n` (`install.sh`, `install-db.sh`,
  `start.sh` y el script embebido en cada egg).
- **`start.sh` contra un origin de prueba:**
  - casos probados: fast-forward, rama reescrita, archivo versionado editado,
    origin inalcanzable, `start.sh` que cambia y se re-ejecuta, `ROLLBACK_COMMIT`
    puesto, vaciado e inválido;
  - el caché de dependencias, con un `corepack` falso: compila una vez, recompila
    cuando cambia `site/web`, e ignora `dist/`.

No se verificó:

- Nada corrió en el panel ni en NA-01 (esta sesión no tiene acceso).
- `deploy/web/serve.mjs` no se ejecutó: esta máquina no tiene Node.
- Que los eggs importen sin errores en Reviactyl.
- Que la imagen oficial de postgres arranque con el uid de Wings.
- Que `<bridge-ip>` sea de verdad la interfaz de Docker de NA-01.
- Que `site/api` y `worker/main.py` cumplan los contratos de §4: todavía no
  existen en `master`.
