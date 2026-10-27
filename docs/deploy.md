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
   vienen: `GIT_ADDRESS` apunta a `https://github.com/Mides-Projects/Overtone.git`.
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
| `overtone-api` | `<bridge-ip>:<api-port>` | `overtone-web` (con `PROXY_SECRET`) y `overtone-worker` (con `WORKER_TOKEN`) |
| `overtone-api-exp` | `<bridge-ip>:<api-exp-port>` | `overtone-web-exp` y `overtone-worker-exp`, igual |
| `overtone-worker` | `<bridge-ip>:<worker-port>` | nadie: no escucha. El panel pide una allocation igual. |
| `overtone-worker-exp` | `<bridge-ip>:<worker-exp-port>` | nadie |
| `overtone-db` | `<bridge-ip>:<db-port>` | las dos APIs (el worker no habla con la base: es cliente HTTP de la API) |

**Admin → Nodes → NA-01 → Allocation:** crear `<bridge-ip>` con los cinco puertos
de la API, el worker y la base (los dos entornos). Los de las dos webs van en la IP
pública, en puertos que estén libres.

Si no se quieren allocations en el bridge, se pueden usar puertos de la IP
pública. En ese caso hay que cerrarlos en el firewall del nodo para todo lo que no
sea Docker, porque si no, la base y la API quedan expuestas a internet.

### Cómo se hablan de verdad en NA-01 (medido el 2026-10-27)

Lo de arriba es el plan. Al levantar experimental en NA-01 salió distinto, y esto es
lo que funciona:

- **El bridge de Wings no es el de Docker por defecto.** Un contenedor de NA-01 ve su
  interfaz en `172.22.x.x`: la red de Wings es `172.22.0.0/16` y su puerta de enlace,
  `<bridge-ip>`, es `172.22.0.1`, no la `172.18.0.1` de la configuración por defecto.
  Para verlo sin entrar al nodo, alcanza con arrancar cualquier server con
  `node -e "console.log(require('os').networkInterfaces())"` como comando.
- **Ningún contenedor llega a `<bridge-ip>`.** El firewall del host descarta lo que
  entra por la puerta de enlace: desde la API, `<bridge-ip>:<db-port>` da *timeout*
  aunque la base escuche ahí. La allocation en el bridge sigue haciendo falta (el
  panel exige una, y así el puerto no queda en la IP pública), pero no sirve de
  dirección.
- **Lo que sí funciona es el nombre del contenedor.** La red de Wings es una red de
  Docker definida por el usuario, así que su DNS resuelve cada contenedor por su
  nombre, que es el UUID completo del server (**Admin → Servers → el server**, o
  `uuid` en la API de aplicación). El tráfico va de contenedor a contenedor, al puerto
  en el que escucha el proceso (el de su allocation), sin pasar por el host:

  | Variable | Valor |
  |---|---|
  | `DATABASE_URL` de cada API | `postgres://<rol>:<pw>@<uuid-de-overtone-db>:<db-port>/<base>` |
  | `API_UPSTREAM` de cada web | `http://<uuid-de-su-api>:<api-port>` |
  | `OVERTONE_API` de cada worker | `http://<uuid-de-su-api>:<api-port>` |

  El UUID no cambia mientras el server exista. Si se borra y se recrea, hay que
  actualizar estas variables.
- **Desde afuera quedó cerrado:** `<node-ip>:<db-port>` y `<node-ip>:<api-port>` no
  responden, y la web contesta `/api/v1/health` con `database: ok`.

Dos arreglos de los eggs salieron de esto mismo (rama `fix/egg-install`):

- **`git-lfs` ya no se instala con apt.** La imagen instaladora (Debian 11) pedía al
  mirror de seguridad un paquete que ya no existe (404), y la instalación de la web y
  la API terminaba con el server vacío y sin decirlo en la lista de servers. Ahora
  solo el worker lo baja, del release de git-lfs, con la versión fija y su SHA-256.
- **El socket de PostgreSQL va a `/tmp`.** Wings monta la imagen de solo lectura, y
  Postgres no podía crear su lock en `/var/run/postgresql` ("could not create lock
  file"). El egg hace que Wings reescriba `unix_socket_directories` en
  `pgdata/postgresql.conf` antes de cada arranque. El primer arranque, que crea ese
  archivo, todavía se cae una vez; el segundo ya corre. La imagen oficial ignora el
  comando de arranque del panel, así que el arreglo no puede ir ahí.

Lo mismo vale para los puertos de las webs: quien les pegue directo se salta el
TLS. Lo ideal es que el firewall los abra solo para el proxy (ver
[§9](#9-tls-la-pregunta-abierta)).

### El puerto de la API se da por público (`PROXY_SECRET`)

La revisión del despliegue (2026-10-26) encontró que en Reviactyl todo puerto de
allocation es público. Si la API queda alcanzable desde internet, un cliente le
puede pegar directo, sin pasar por `serve.mjs`, y escribir su propio
`X-Forwarded-For`: elige la dirección con la que cuentan el rate limit y la cuota
anónima. Por eso la API no confía en que su puerto esté escondido:

- `overtone-web` y `overtone-api` comparten `PROXY_SECRET` (32+ caracteres,
  `openssl rand -hex 32`, uno por entorno). `serve.mjs` lo agrega como
  `X-Overtone-Proxy` a todo lo que reenvía, y descarta el que traiga el cliente.
- La API responde **404** a cualquier pedido sin ese header (comparación en tiempo
  constante), como si ahí no escuchara nada. En producción no arranca sin él; en
  desarrollo es opcional, porque el navegador llega por el proxy de Vite.
- La excepción son las rutas del worker, `/api/internal/*`: piden su propio
  `Authorization: Bearer <WORKER_TOKEN>`, y `serve.mjs` **no las reenvía nunca**
  (404, se escriban como se escriban: decodificadas, con barras dobles o en
  mayúsculas). El worker le habla a la API directo, a su allocation.

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
- **RAM del worker:** un worker analiza de a un trabajo, y pide 1,5 GB + 0,5 GB =
  2 GB. Más análisis simultáneos son más servers worker (cada uno 2 GB y su CPU),
  no una variable: `WORKER_CONCURRENCY` se retiró con el worker real (2026-10-26). Si se arranca sin el voto (decisión abierta 3 del plan), alcanza
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
| `overtone-web` | `API_UPSTREAM=http://<uuid-de-overtone-api>:<api-port>`, `PROXY_SECRET` (el de la API de prod) |
| `overtone-web-exp` | `API_UPSTREAM=http://<uuid-de-overtone-api-exp>:<api-exp-port>`, `PROXY_SECRET` (el de la API de staging) |
| `overtone-api` | `DATABASE_URL=postgres://<rol-prod>:<pw>@<uuid-de-overtone-db>:<db-port>/overtone`, `SITE_URL=https://overtone.midesprojects.com`, `TRUST_PROXY=2`, `SESSION_SECRET`, `MIDES_CLIENT_SECRET` (el mismo valor que `SSO_SECRET_OVERTONE` en Mides), `PROXY_SECRET`, `WORKER_TOKEN`, `MIDES_AUTH_URL`, `MIDES_WEB_URL`, `MIDES_APP`; con valores por defecto: `ANON_DAILY_LIMIT` (5), `USER_DAILY_LIMIT` (50), `MAX_AUDIO_SECONDS` (600), `MAX_UPLOAD_MB` (40), `JOB_TIMEOUT_S` (900), `SPOOL_DIR` (`/home/container/.overtone/spool`), `SPOOL_MAX_MB` (1280: el disco del server es de 2 GB, y `QUEUE_MAX × MAX_UPLOAD_MB` = 30 × 40 entra), `QUEUE_MAX` (30) |
| `overtone-api-exp` | Las mismas. `DATABASE_URL=…<rol-staging>:<pw>@<uuid-de-overtone-db>:<db-port>/overtone_experimental`, `SITE_URL` de staging, y **secretos distintos** de los de prod. |
| `overtone-worker` | `OVERTONE_API=http://<uuid-de-overtone-api>:<api-port>`, `WORKER_TOKEN` (el de la API de prod), `WORKER_POLL_S=2`, `WORKER_THREADS=4`; con valores por defecto: `WORKER_MEMORY_MB` (1800), `WORKER_TIMEOUT_MIN_S` (120), `WORKER_TIMEOUT_FACTOR` (3) |
| `overtone-worker-exp` | `OVERTONE_API=http://<uuid-de-overtone-api-exp>:<api-exp-port>`, `WORKER_TOKEN` (el de staging), `WORKER_POLL_S=2`, `WORKER_THREADS=2`; los mismos valores por defecto |
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
  **Hecho así (2026-10-26):** el primer `^C` deja terminar el trabajo en curso y
  publicar su resultado; un segundo sale en el acto, y la API devuelve ese trabajo a
  la cola pasado `JOB_TIMEOUT_S` (dos intentos en total). El worker no tiene
  driver de base: toma trabajos de `/api/internal` con `WORKER_TOKEN`.
- **Cada análisis corre en un proceso hijo** (`worker/isolate.py`, 2026-10-27). Un
  audio es entrada no confiable: unos KB de header pueden anunciar horas de audio a
  cualquier frecuencia. Por eso:
  - antes de decodificar, se rechaza (`too_heavy`) un header que diga más de
    192 kHz, más de 8 canales o más de `max_seconds × 192000` frames;
  - el motor corre en un hijo que se arranca una vez y queda caliente entre
    trabajos. Cada trabajo tiene un límite de reloj de
    `max(WORKER_TIMEOUT_MIN_S, WORKER_TIMEOUT_FACTOR × duración)` (120 s y 3× por
    defecto); pasado eso, el hijo se mata y el trabajo falla con `timeout`;
  - en Linux, el hijo tiene `RLIMIT_AS` de `WORKER_MEMORY_MB` (1800 por defecto; 0
    lo apaga) y `MALLOC_ARENA_MAX=2`. Si se queda sin memoria, o si el OOM killer
    lo mata, el trabajo falla con `too_heavy`. En Windows no hay rlimit y se avisa;
  - el worker sigue atendiendo: el siguiente trabajo arranca un hijo nuevo. Mientras
    espera, reenvía el último progreso cada 60 s, así el barrido de `JOB_TIMEOUT_S`
    de la API no confunde un análisis largo con uno muerto.

  **Lo que cuesta:** el hijo importa el motor, carga el modelo y analiza 8 s de
  clicks (con el voto) antes de decir que está listo. Eso prueba que el límite de
  memoria deja lugar para un análisis y compila numba antes del primer trabajo real.
  Medido en Windows el 2026-10-27, con un track de 120 s y el voto: el arranque pasó
  de 24,9 s (en proceso, sin autoprueba) a 42,8–55,5 s; cada análisis tardó lo mismo
  dentro del ruido de esta máquina (en el hijo, medianas de 45,4 y 59,3 s; en
  proceso, 46,8 s, y 56–84 s en otra corrida). Un hijo que se mató paga ese arranque
  otra vez antes del siguiente trabajo. El primer arranque en Linux imprime el pico
  de espacio de direcciones después de la autoprueba: si queda cerca de
  `WORKER_MEMORY_MB`, hay que subirlo. Si la autoprueba no entra en el límite, el
  worker no arranca y lo dice.

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
Para la API eso ya no depende del firewall: sin `PROXY_SECRET` responde 404
([§2](#el-puerto-de-la-api-se-da-por-público-proxy_secret)).

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
- Que los eggs importen sin errores en Reviactyl.
- Que la imagen oficial de postgres arranque con el uid de Wings.
- ~~Que `<bridge-ip>` sea de verdad la interfaz de Docker de NA-01.~~ Lo es (`172.22.0.1`), pero los contenedores no la alcanzan: ver "Cómo se hablan de verdad en NA-01".

Agregado el 2026-10-26, con el worker y el flujo de análisis (Node 24.22, Windows):

- `serve.mjs` corrió delante de la API con `PROXY_SECRET`: la API directa sin el
  header, o con otro valor, da 404; con él, 200; por `serve.mjs`, 200.
  `/api/internal/jobs/claim`, `/api/%69nternal/…` y `/api//internal/…` por
  `serve.mjs` dan 404 (y `/API/Internal/…` no es `/api`: 405 del estático). Las
  rutas internas, directas y sin token, dan 401.
- `pnpm --dir site/api test`: los guardias de `PROXY_SECRET` y de `WORKER_TOKEN`.
- `worker/main.py` imprime `overtone-worker: ready` y analizó de punta a punta;
  el `^C` en dos tiempos y `WORKER_THREADS` no se probaron en Linux.
