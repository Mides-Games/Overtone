# Servidor de la biblioteca (API)

`python/overtone_server.py` sirve el índice de una carpeta Songs y su caché de
BPM por HTTP. Está pensado para una máquina que guarda la carpeta y la analiza
sola, por ejemplo una VPS. La caché vive en el índice SQLite de la
biblioteca (`library.sqlite3`, esquema v3, tabla `analysis`). Cada audio se analiza
una sola vez y se vuelve a analizar solo si cambia el archivo o el código del
motor (`engine_hash`).

Qué hace y qué no:

- Solo escucha. No hace conexiones salientes ni manda telemetría.
- Por defecto escucha en `127.0.0.1`: se usa con un túnel SSH o detrás de un
  proxy con TLS. **Nunca** lo publiques sin TLS, porque el token viajaría en
  claro.
- Cada petición lleva `Authorization: Bearer <token>`.
- Una conexión que no manda nada en 30 s se cierra. Atiende 64 a la vez; a
  la siguiente le contesta `503` y la cierra, sin darle un hilo.
- Tokens equivocados (cabecera o `/login`): 20 por minuto en todo el
  servidor, porque detrás de Caddy todos llegan desde la misma dirección.
  Pasado eso no comprueba ningún token, tampoco el bueno, y contesta `429`
  con `Retry-After` hasta que el fallo más viejo cumple un minuto. Una
  sesión del navegador ya abierta sigue valiendo.
- Un audio sin pulso (ruido, pads, silencio) queda como `refused`, con el
  motivo del motor y sin BPM. No se inventa nada.

## Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/status` | Índice, conteos de la caché, trabajos en curso, motor |
| POST | `/api/scan` | Escanea la carpeta Songs en segundo plano |
| POST | `/api/analyze` | Analiza lo que falta en la caché (`{"limit": n}` opcional) |
| POST | `/api/stop` | Pide parar el análisis en curso (lo terminado se guarda) |
| GET | `/api/songs?q=texto&limit=n` | Búsqueda; cada mapa trae su `analysis` |
| GET | `/api/analysis?path=<audio>` | El análisis guardado de un audio |
| GET | `/api/v1/runs` | Las corridas de medición, la cola y las etapas |
| POST | `/api/v1/runs` | Encola una corrida (`{"tool": "stages", "stage": ...}`) |
| GET | `/api/v1/runs/<id>` | Una corrida y el final de su log |
| GET | `/api/v1/runs/<id>/result` | El informe JSON del tool |
| GET | `/api/v1/runs/<id>/log` | El log entero, texto plano |
| POST | `/api/v1/runs/<id>/stop` | Cancela la corrida o la corta si corre |
| GET/POST | `/login` | La página de entrada (token → cookie de sesión) |
| GET | `/` | La página de tests (con sesión) |

Solo puede correr un escaneo y un análisis a la vez. Si se pide otro mientras
corre uno, la respuesta es `409`. El progreso se lee en `status.jobs`.

## Instalación en una VPS (Ubuntu o Debian)

Se necesitan unos 5 GB libres más lo que ocupe la carpeta Songs.

**Quién ejecuta qué.** El checkout (`/opt/overtone`) es del usuario
`overtone`, que es quien lo actualiza. root nunca ejecuta nada de ahí: ni
un script, ni una compilación, ni `git`. Un archivo de una carpeta que otro
usuario puede escribir, ejecutado por root, es root para quien la escriba;
y `git` lee la configuración y los hooks del repositorio, que también son de
`overtone`. Por eso cada paso sobre el checkout va con `sudo -u overtone -H`,
y nunca hace falta `safe.directory`.

1. Paquetes del sistema (sin escritorio ni ffmpeg: el motor Rust decodifica
   solo):

   ```bash
   apt-get install -y --no-install-recommends build-essential curl git ca-certificates libsndfile1
   ```

2. El usuario del servicio y el código, clonado por ese usuario:

   ```bash
   useradd --system --create-home --home-dir /var/lib/overtone --shell /bin/sh overtone && install -d -o overtone -g overtone /opt/overtone
   ```

   ```bash
   sudo -u overtone -H git clone https://github.com/Mides-Projects/Overtone.git /opt/overtone
   ```

3. Python 3.14 con `uv` y las dependencias del motor, como `overtone`:

   ```bash
   sudo -u overtone -H sh -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'
   ```

   ```bash
   sudo -u overtone -H sh -c 'cd /opt/overtone && ~/.local/bin/uv venv --python 3.14 .venv && ~/.local/bin/uv pip install --python .venv/bin/python -r python/requirements.lock'
   ```

   Las versiones salen de `python/requirements.lock`, las mismas que midió
   el benchmark. `uv` y el intérprete quedan en la carpeta de `overtone`
   (`/var/lib/overtone`), donde el servicio los alcanza.

4. El motor Rust, que es el que hace rápido el análisis, también como
   `overtone` (así el actualizador puede recompilarlo):

   ```bash
   sudo -u overtone -H sh -c "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"
   ```

   ```bash
   sudo -u overtone -H sh -c 'cd /opt/overtone && ~/.cargo/bin/cargo build --release -p overtone-cli'
   ```

   Compilar en release puede pedir más de 1 GB de RAM. Si la VPS tiene poca,
   añade swap antes o compila en otra máquina Linux y copia solo
   `target/release/overtone-cli`. Después se puede borrar `target/` salvo ese
   binario, apuntando `OVERTONE_CLI` a donde lo dejes.

5. La carpeta Songs, en por ejemplo `/srv/osu/Songs`.

6. Comprobar que el motor y la API funcionan ahí:

   ```bash
   sudo -u overtone -H sh -c 'cd /opt/overtone && .venv/bin/python -m unittest tests.test_overtone.LibraryServerTests tests.test_overtone.LibraryIndexTests'
   ```

7. Arrancarlo a mano una vez, como `overtone`. La primera vez escribe un
   token en `/var/lib/overtone/Overtone/api-token`:

   ```bash
   sudo -u overtone -H sh -c 'cd /opt/overtone && .venv/bin/python python/overtone_server.py --songs /srv/osu/Songs --every 60'
   ```

   `--every 60` escanea y analiza lo nuevo cada 60 minutos. `--jobs N` fija
   cuántos audios analiza Rust a la vez (2 por defecto, solo sin el voto).

   **Memoria: el voto de Beat This!.** El motor, por defecto, deja que Beat
   This! vote sobre las red lines. Ese voto carga la canción en Python y corre
   un modelo ONNX. Medido en un fixture de 90 s (2026-10-25):

   | Camino | RAM pico | Tiempo |
   |---|---|---|
   | Rust + voto (por defecto) | 1.46 GB | 50 s |
   | Rust sin voto (`--no-beat-vote`) | 101 MB | 2.3 s |
   | v3 Python (`--engine python`) | 1.78 GB | 42 s |

   En una VPS con 1 GB, usa `--no-beat-vote`. Las red lines quedan como las
   ajusta el motor, y pueden diferir de las del voto donde este las habría
   cambiado. La caché guarda con qué modo se hizo cada análisis, así que
   cambiar de modo vuelve a analizar todo en vez de mezclar resultados.

## Dejarlo como servicio (systemd)

`/etc/systemd/system/overtone-api.service`:

```ini
[Unit]
Description=Overtone library API
After=network.target

[Service]
User=overtone
WorkingDirectory=/opt/overtone
ExecStart=/opt/overtone/.venv/bin/python python/overtone_server.py --songs /srv/osu/Songs --every 60 --no-beat-vote
Restart=on-failure
Nice=10
MemoryMax=1G

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now overtone-api
```

El checkout es de `overtone` y la actualización automática
(`deploy/overtone-update.service`) también corre como `overtone`, nunca
como root: root ejecutando código de una carpeta que otro usuario puede
escribir le daría root a quien la escriba. Su único paso con privilegios,
reiniciar el servicio, pasa por una regla de sudo solo para ese comando, que
instala `deploy/setup-deploy-user.sh`. Para que pueda recompilar
`overtone-cli`, Rust tiene que estar al alcance de `overtone` (el paso 4 lo
instala como ese usuario; si no, apuntá `OVERTONE_CARGO` a un `cargo` que
pueda ejecutar); si no, el binario anterior sigue y el log lo dice.

Si un proceso del servicio llega al tope de memoria, systemd para el
servicio entero salvo que se le diga lo contrario. Para que una medición o
un test que se pase muera solo, sin llevarse el servidor ni la página:

```bash
mkdir -p /etc/systemd/system/overtone-api.service.d && printf '[Service]
OOMPolicy=continue
' > /etc/systemd/system/overtone-api.service.d/oom.conf && systemctl daemon-reload && systemctl restart overtone-api
```

`Nice=10` y `MemoryMax` hacen que no le quite recursos a lo demás que corra en
la máquina. `MemoryMax=1G` vale con el motor Rust y `--no-beat-vote`. Con el voto o con `--engine python`, un
solo análisis pasa de 1.4 GB (tabla de arriba), así que ese límite
lo mataría.

## La página de tests

El servidor es una API de medición, sin interfaz propia: la interfaz de
Overtone es la web (`site/`, ver `docs/site.md`). La app de escritorio que
este servidor servía en `/` se archivó el 2026-10-26 (rama
`parked/desktop-app`, etiqueta `v3-desktop-app`).

La única página que queda es la de tests, en `/`
(`python/server_page/runs.html`). Se entra en `/login` con el token. La
sesión es una cookie firmada con el token: sobrevive a reinicios del
servidor, y cambiar el token cierra todas las sesiones. Con la cookie sola
no se puede cambiar nada: la página manda además la cabecera `X-Overtone`,
que un formulario de otro sitio no puede poner. Los scripts siguen usando
`Authorization: Bearer <token>`.

Para entrar desde fuera sin túnel, pon Caddy delante. Pide y renueva solo
el certificado HTTPS.
Hace falta un dominio que apunte a la VPS; uno gratuito tipo DuckDNS sirve.

`/etc/caddy/Caddyfile`:

```
overtone.tu-dominio.com {
    reverse_proxy 127.0.0.1:8765
}
```

```bash
apt-get install -y caddy && systemctl reload caddy
```

El servidor sigue escuchando solo en `127.0.0.1`. Caddy es lo único
expuesto, y siempre con HTTPS.

## Tests del algoritmo en el servidor

El servidor corre las mediciones de `bench/stages.py` (la carpeta por
etapas, cada canción en *dev* o en *held out*) y `bench/single_bpm.py` (los
mapas de un solo tempo) sobre su propia carpeta Songs. Las corridas van de
una en una, cada una en su propio proceso, y quedan guardadas en
`/var/lib/overtone/Overtone/runs/<id>/`:

- `meta.json`: qué se pidió, el commit del código que respondió, el
  estado, la duración y el resumen;
- `log.txt`: la salida del tool;
- `result.json`: el informe completo, con una fila por mapa.

Se lanzan de tres formas:

- **Desde el navegador:** la página de tests, en `/`.
- **Desde tu PC**, con el túnel abierto:
  ```bash
  python bench/remote.py --token-file token.txt run anime-single --split dev --jobs 2 --wait
  ```
  `status`, `runs`, `show <id>`, `result <id>` y `stop <id>` completan el
  resto.
- **Por la API:** `POST /api/v1/runs` (ver el inicio de
  `python/overtone_server.py`).

**Solo mapas ranked y loved.** Si junto a la carpeta Songs está
`osu!.db` (`/srv/osu/osu!.db`, o donde diga `--osu-db`), las corridas de
etapas cuentan por defecto solo los mapas que esa base marca como ranked,
approved o loved. Sus red lines están verificadas; las de un mapa
graveyard pueden estar mal y harían pasar por error del motor lo que es del
mapa. En la página Tests es la casilla "Ranked and loved maps only"; en
`bench/remote.py`, `--all-maps` la desactiva. Cada modo guarda su propio
informe y su propio baseline.

**Motor.** `rust` mide el motor Rust solo; `app` mide Rust, y v3 donde
Rust se niega o falla (lo que hacía la app de escritorio, y lo que
`bench/corpus_b.py --engine app` sigue midiendo); `python` mide v3 solo.

**Memoria.** Las corridas cuentan dentro del `MemoryMax` del servicio. Sin
el voto de Beat This!, un análisis con Rust usa unos 100 MB, así que
`--jobs 2` cabe en 1 GB. **Con el voto**, cada análisis pasa de 1.4 GB:
sube antes `MemoryMax` a `3G` en el servicio y usa `--jobs 1`. Lo mismo
con el motor `app`: donde Rust se niega, v3 llegó a 1.78 GB por canción.

Las cachés de las corridas van separadas por modo (`runs/cache/vote` y
`runs/cache/novote`), porque la clave de caché de los tools no incluye el
voto. Una lectura con voto nunca se sirve a una corrida sin él.

**Gates y suite en el servidor.** Las mismas comprobaciones de
`CLAUDE.md` corren en el servidor, para no cargar el PC: `gates` (todos los
gates de Python, o los que se nombren) y `suite` (la suite de Python,
`tests/test_overtone.py`). Cada gate se informa por separado, con el final de su
salida. Los gates de Rust necesitan cargo, que el servicio no tiene. `perf`
mide los presupuestos en la máquina que lo corre, que en un servidor es la
del servidor.

```bash
python bench/remote.py --token-file token.txt gates --wait
```

```bash
python bench/remote.py --token-file token.txt suite --wait
```

`sbom` y `notices` no corren en el servidor: revisan el venv y los crates
del build del instalador de Windows. El modelo de Beat This! es un archivo
de Git LFS; sin git-lfs, la VPS tiene un puntero en su lugar (y `perf` falla
en esa etapa). Una sola vez: el paquete como root, y git-lfs, como todo
`git` sobre el checkout, como `overtone`:

```bash
apt-get install -y git-lfs
```

```bash
sudo -u overtone -H git -C /opt/overtone lfs install --local && sudo -u overtone -H git -C /opt/overtone lfs pull && ls -la /opt/overtone/assets/models/beat_this_final0.onnx
```

Desde ahí el actualizador baja los archivos LFS en cada versión.

Los gates generan su audio de prueba en `bench/audio`, dentro del código,
donde el servicio no puede escribir. Una sola vez, como `overtone` (el
enlace va dentro de su checkout, que root no toca):

```bash
sudo -u overtone -H sh -c 'mkdir -p /var/lib/overtone/bench-audio && ln -sfn /var/lib/overtone/bench-audio /opt/overtone/bench/audio'
```

**Probar otra versión del algoritmo:** en la VPS,
`sudo -u overtone -H git -C /opt/overtone pull --ff-only && systemctl restart overtone-api`,
y lanza la corrida. Cada informe guarda el commit que lo produjo, así que dos
corridas se comparan sabiendo qué código respondió cada una. Las mediciones
no son gates: lo que decide si un cambio entra siguen siendo los gates
locales de `CLAUDE.md`.

## Actualización automática

Cada push a `experimental` (la rama de staging) llega solo a la VPS:

1. GitHub Actions (`.github/workflows/deploy.yml`) entra a la VPS como
   `overtone-deploy`, un usuario cuya llave solo puede arrancar
   `overtone-update.service`: no abre una consola, no ejecuta nada más y no
   usa contraseña. root sigue entrando con llave y contraseña, como antes.
2. Ese servicio (`deploy/overtone-update.sh`) baja la rama (solo
   fast-forward), recompila `overtone-cli` si cambió el código Rust y
   reinicia Overtone. Si corre una medición, los gates o la suite, espera.
   También espera si el servicio está activo pero la API no contesta (o
   rechaza el token): sin respuesta no se sabe si corre algo, y el log dice
   por qué esperó. Si el servicio está parado no corre nada, así que
   despliega igual: un servidor caído puede estar esperando justo ese
   arreglo.
3. Un timer hace lo mismo cada 5 minutos, por si GitHub falla o la VPS
   estaba apagada.

Solo se despliega esa rama: las experimentales nunca llegan solas. Si dejas
la VPS en otra rama a mano, el actualizador la deja en paz y lo dice en el
log.

Instalarlo, una vez, como root (la llave pública la da quien configura los
secretos de GitHub). root no ejecuta el script desde el checkout, que es de
`overtone`: primero lo copia a un archivo suyo (git lo lee como `overtone`),
lo revisa entero, y ejecuta esa copia. El script escribe él mismo las
unidades de systemd del actualizador; no copia nada del checkout.

```bash
sudo -u overtone -H git -C /opt/overtone show HEAD:deploy/setup-deploy-user.sh > /root/setup-deploy-user.sh
```

```bash
less /root/setup-deploy-user.sh
```

```bash
sh /root/setup-deploy-user.sh 'ssh-ed25519 AAAA... github-actions-deploy'
```

Si el script cambia en el repositorio, se repite igual: copiar, revisar,
ejecutar la copia.

Qué hizo cada vez:

```bash
journalctl -u overtone-update -n 20 --no-pager
```

## Usarlo

Desde tu PC, con un túnel:

```bash
ssh -N -L 8765:127.0.0.1:8765 usuario@IP_DE_LA_VPS
```

```bash
curl -H "Authorization: Bearer $(cat token.txt)" "http://127.0.0.1:8765/api/songs?q=camellia"
```

Para exponerlo a internet, pon delante un proxy con TLS (Caddy o nginx) que
reenvíe a `127.0.0.1:8765`. No cambies `--host` a `0.0.0.0` sin TLS.

## Tests y gates en la VPS

Son los mismos comandos de `CLAUDE.md`, con `.venv/bin/python` en lugar de
`.venv/Scripts/python.exe`. Dos salvedades:

- `real-audio` y Corpus B leen la carpeta Songs; solo valen allí si está.
- `bpm-snapshot` y `golden.py` fijan valores medidos en Windows. La primera
  vez en Linux, compara antes de dar por buena o mala una diferencia de
  decimales. Nunca re-baselines para poner un gate en verde.
