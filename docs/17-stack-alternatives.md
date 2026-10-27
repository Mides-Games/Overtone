# 17 — Alternativas al stack: qué podría reemplazar o sumarse

Escrito el 2026-10-27. Es el relevamiento que pidió el dueño ("busca más alternativas de
APIs, dependencias, todo lo que sirva, que entre directamente"): modelos de beat y tempo,
métodos para tempo que deriva, decodificación, opciones de onnxruntime, piezas del sitio y
servicios autoalojables. Cada candidato tiene licencia, tamaño, mantenimiento y encaje.

Las reglas que filtran todo esto son las de `CLAUDE.md`: el motor no hace llamadas de red
ni telemetría (una API de análisis de terceros no puede estar en el camino del timing),
ninguna mejora se declara sin medición en el mismo commit, el 24/24 del benchmark no se
negocia, y lo que se distribuye tiene que ser compatible con MIT (`installer/sbom.py` y
`installer/notices.py` registran lo que viaja).

Fuentes: los repos, PyPI, crates.io y npm de cada paquete, consultados el 2026-10-27.
Una licencia marcada con † se tomó de memoria y no se volvió a verificar ese día.

---

## 0. Resumen

| Decisión | Candidato | Por qué |
|---|---|---|
| **Adoptado** | `enable_mem_pattern = False` en la sesión de Beat This! (rama `perf/beat-this-memory`) | Pico de memoria 1904 → 1278 MB, mismos beats, sin más CPU (§7). |
| **Medir después** | int8 de Beat This!, Beat This! `small0`, DBN sobre la activación de Beat This!, PLP / DP con tempo variable, `beat-this-rs` + `ort` en Rust | Pueden mover la precisión; ninguno se adopta sin Corpus B y las puertas. |
| **Para el sitio, cuando haga falta** | `rate-limiter-flexible` (Postgres), `yauzl`/`yazl`, `music-metadata`, `pg-boss` o `graphile-worker`, Umami, Uptime Kuma, GlitchTip | Todos MIT/ISC y del lado del servidor; ninguno toca el motor. |
| **Descartado** | modelos de madmom, Essentia TempoCNN, BeatNet, All-In-One, pedalboard, MinIO, adm-zip | Licencia (NC, AGPL, GPL), abandono o dependencias pesadas. |

---

## 1. Modelos y trackers de beat / tempo

| Candidato | Qué es | Licencia código / pesos | Tamaño | Mantenimiento | Encaje |
|---|---|---|---|---|---|
| **Beat This!** final0 (lo actual) | Transformer de beats y downbeats (CPJKU, ISMIR 2024) | MIT / MIT (explícito en el README desde 2026-05-28) | 83 MB en ONNX | Primeras versiones en PyPI: 1.0 y 1.1.0 (abril 2026). Sin checkpoints nuevos. | Ya es el votante extra y el juez de octava. |
| **Beat This! small0** | El mismo modelo, chico | MIT / MIT | ≈8 MB | Igual | Diez veces más liviano: bajaría el costo por canción del servidor (Beat This! es lo que define cuántos análisis simultáneos aguanta). El paper lo da algo peor; **sin medir en Corpus B**. Requiere exportarlo con `proto/beat_this_export.py` (torch). |
| **beat-this-rs** (crates.io `beat-this` 1.1.0, 2026-10-02) | Port a Rust de Beat This! sobre `ort` y `symphonia` | MIT | — | Un solo autor (danigb), reciente | Atajo posible para que v4 tenga el voto sin Python. Hay que auditarlo contra los vectores golden antes de confiar. |
| **madmom** | DSP, RNN/TCN y el DBN de beats | BSD / **CC BY-NC-SA 4.0** | — | Última versión en PyPI 0.16.1 (2018); rompe con numpy nuevo | **Los modelos no pueden viajar** (no comercial). El código del DBN es BSD y no necesita pesos: ese sí sirve (§2). |
| **madmom-onnx** | Fork que corre madmom con onnxruntime | BSD / CC BY-NC-SA | — | 0.17.dev0 (2026-02-24), Python 3.9–3.14, un mantenedor | La forma práctica de tener el DBN en Python 3.14, solo el DBN. |
| **All-In-One** | Beats, downbeats y estructura | MIT / sin licencia | — | Poca actividad | Depende de madmom, NATTEN y Demucs; pesos sin licencia. Descartado. |
| **BeatNet** | CRNN + filtro de partículas | CC-BY-4.0 / sin licencia | chico | Abandonado; pide Python ≤3.9 y torch | Descartado. |
| **Essentia TempoCNN** | CNN de tempo global y local | **AGPL-3.0** / **CC BY-NC-SA** | — | Activo | Las dos licencias quedan fuera. Descartado. |
| **livechord-beat-refiner** | Transformer que refina la salida de otros trackers | Apache-2.0 / Apache-2.0 | — | 0.1.0 (2026-05-09) | Entrenado con etiquetas de los mismos trackers; su propia ficha no muestra que supere a Beat This!. Solo mirar. |

Papers recientes que importan:

- **"The SMC Blind Spot"** (arXiv 2605.12287, mayo 2026): el DBN de madmom arranca en 55 BPM
  como mínimo, y eso fuerza el doble tempo en el 21 % de SMC. Es exactamente la clase de error
  de octava que tenemos. Sin código; la lección es que cualquier DBN que se sume tiene que
  abrir su rango de BPM y llevar una prior de octava explícita.
- **dPLP** (Chiu, Strahl, Müller, ISMIR 2025): PLP diferenciable. Sin código encontrado.

## 2. Tempo que deriva (bandas con batería en vivo)

Es el punto débil medido: en bandas en vivo el tempo sale bien en ~47–60 % de los mapas.
Todo lo de esta tabla trabaja **sobre la activación de Beat This!** (que ya calculamos) o
sobre la envolvente de onsets, así que no suma modelos.

| Método | Implementación permisiva | Qué aportaría |
|---|---|---|
| DBN / HMM con cambio de tempo | `DBNBeatTrackingProcessor` de madmom (BSD, sin pesos); portable a Rust | Sigue un tempo que se mueve; `transition_lambda` más bajo tolera más deriva. Abrir `min_bpm`/`max_bpm` (ver SMC). |
| PLP (Grosche y Müller) | `librosa.beat.plp` (ISC) | La documentación de librosa lo recomienda cuando el tempo varía mucho. Se le puede dar la activación de Beat This! como envolvente. |
| DP de Ellis con tempo variable | `librosa.beat.beat_track(bpm=<array por frame>)` (ISC) | Con `librosa.feature.tempo(aggregate=None)` da una curva de tempo y un seguimiento que la respeta. |
| Tempograma local + Viterbi | librosa `tempogram` y código propio | Curva de tempo suavizada; fácil de portar a Rust. |

Recomendación: el próximo experimento de precisión para bandas es **DBN o PLP sobre la
activación de Beat This!**, medido en Corpus B (`--split dev`, después `held-out`) en el
servidor. No se adopta en este relevamiento porque no hay medición, y otra sesión está
trabajando la octava.

## 3. Decodificación y remuestreo

| Paquete | Versión | Licencia | Encaje |
|---|---|---|---|
| soundfile (lo actual) | 0.14.0, 2026-06-06 | BSD-3; trae libsndfile **LGPL-2.1** | Se queda. La oferta de fuente LGPL ya está en `installer/notices.json`. |
| soxr (lo actual) | 1.1.0 | **LGPL-2.1+** | Se queda; ya registrado en `notices.json`. |
| PyAV (`av`) | 19.0.2 | BSD-3; trae FFmpeg | Solo si hiciera falta un formato que libsndfile no lee. Hay que revisar si el FFmpeg del wheel es LGPL o GPL antes de distribuirlo. |
| audioread | — | MIT† | Llama a ffmpeg externo. No. |
| torchaudio | 2.9+ en mantenimiento | BSD | `load()` ahora delega en TorchCodec. No vale sumar torch. |
| pedalboard | 0.9.26 | **GPL-3.0** | Descartado. |
| Symphonia (lo actual en Rust) | 0.6.1, 2026-08-13 | MPL-2.0 | Se queda; MPL es por archivo, compatible con distribuir MIT. |
| rubato | 5.0.1, 2026-10-01 | MIT/Apache-2.0 | El remuestreador en Rust puro si `overtone-audio` necesita cambiar el suyo; evita libsoxr en C. Medir con `overtone-bench resample` antes. |
| dasp | 0.11† | MIT/Apache† | Quieto desde ~2020. No. |

Nada acá le gana a lo que hay: no se cambia.

## 4. onnxruntime (Beat This!)

Beat This! es lo más caro del análisis: 1,46 GB y 50 s con el voto contra 101 MB y 2,3 s
sin él (fixture de 90 s, `docs/16-web-platform.md` §0). Opciones:

- **Cuantización dinámica int8** (`quantize_dynamic`): el modelo baja de 83 a 23 MB. Hay
  reportes de transformers que pierden precisión. Como la activación termina en
  milisegundos, es un cambio de precisión y pasa por las puertas, no solo por velocidad.
- **Threads**: `intra_op_num_threads` = núcleos físicos, `inter_op_num_threads` = 1.
- **Memoria pico**: `enable_cpu_mem_arena = False` y `enable_mem_pattern = False` bajan el
  pico con entradas de largo variable, a cambio de algo de velocidad.
- **Optimización de grafo**: `ORT_ENABLE_ALL` en tiempo de carga (ya es el default). Si se
  guarda el modelo optimizado, a `ENABLE_EXTENDED` como máximo (lo demás depende del CPU).
- **`ort` (Rust)**: 2.0.0-rc.15 (2026-10-19), MIT/Apache. Sin versión estable; descarga los
  binarios de ORT al compilar salvo que se use `load-dynamic`. Para v4 sirve fijando la rc
  exacta y cargando el ORT que ya viaja.

Lo medido está en §7.

## 5. Piezas del sitio (Node)

El sitio hoy tiene dos dependencias (`express`, `pg`) a propósito. Estas entran cuando una
tarea las pida, no antes:

| Para | Paquete | Versión | Licencia | Deps | Nota |
|---|---|---|---|---|---|
| Rate limit en Postgres | **rate-limiter-flexible** | 11.2.3 | ISC | 0 | Usa el pool de `pg` que ya existe. Es el reemplazo natural de `middlewares/rate-limit.js` el día que haya dos procesos (lo dice su propio comentario). |
| (no) | @acpr/rate-limit-postgresql | 1.4.1 | MIT | 4 | Fija `pg 8.11.3` exacto y trae sus migraciones. No. |
| Leer ZIP (subir un .osz) | **yauzl** | 3.4.0 | MIT | 1 | Streaming; rechaza rutas absolutas y `..`. Igual hay que limitar cantidad de entradas y tamaño descomprimido (zip bomb). |
| Escribir ZIP (descargar un .osz) | **yazl** | 3.3.1 | MIT | 1 | El par de yauzl. |
| ZIP en el navegador | fflate | 0.8.3 | MIT | 0 | No sanea rutas: validarlas a mano. |
| (no) | adm-zip | 0.6.1 | MIT | 0 | Carga todo en memoria; tuvo un CVE de zip-slip. |
| Tags de audio | **music-metadata** | 12.3.2 | MIT | 10 | Solo ESM, Node ≥22: encaja con `site/api`. Título, artista y duración del audio subido sin decodificarlo. |
| SSE | better-sse | 0.16.1 | MIT | 0 | Todavía 0.x. Un SSE con `res.write` son ~20 líneas; solo vale si crecen los canales. |
| Cola en Postgres | **pg-boss** | 12.38.0 | MIT | 4 | Reintentos, expiración y prioridades sobre la misma base. |
| Cola en Postgres | graphile-worker | 0.18.0 | MIT | 8 | LISTEN/NOTIFY, menor latencia. |

`utils/queue.js` y `spool.service.js` ya resuelven la cola de hoy; pg-boss solo si aparecen
reintentos o varios workers.

## 6. Servicios autoalojables (del lado del servidor)

Ninguno toca el motor, así que la regla offline no se rompe: corren en el servidor del dueño
y no reciben nada del usuario más allá de lo que el sitio ya tiene.

| Necesidad | Opción | Licencia | Nota |
|---|---|---|---|
| Errores | GlitchTip | MIT† | Compatible con los SDK de Sentry; Postgres + un worker. |
| Uptime | Uptime Kuma | MIT† | Un contenedor. |
| Analítica sin cookies | Umami | MIT† | Sobre Postgres. Plausible CE es AGPL y pide ClickHouse: más pesado. |
| Almacenamiento de objetos | SeaweedFS (Apache-2.0†) o Garage (AGPL†) | | **MinIO CE quedó archivado el 2026-04-25**: no adoptar. Hoy el disco local alcanza. |
| Búsqueda | FTS de Postgres | — | El mismo modelo que FTS5 en la app de escritorio. Meilisearch pasó su edición Enterprise a BUSL; no hace falta a esta escala. |

## 7. Lo medido y lo adoptado

Medición del 2026-10-27, en esta PC (6 núcleos, 12 hilos) con corridas de otras sesiones de
fondo: el reloj no sirve, así que se compara el **pico de working set** y los **segundos de
CPU** del proceso. Beat This! solo (`_beat_this_beats`), una configuración por proceso, sobre
tres canciones de Corpus B: Take You Down (135 s), YUI - again (257 s, deriva en vivo) y The
Raven that Refused to Sing (477 s). Los beats se comparan con los de la configuración por
defecto. Script: fuera del repo (medición de una sola vez).

| Configuración | Pico | CPU (s, por canción) | Beats a <1 ms del default | Modelo |
|---|---|---|---|---|
| default (dos corridas) | 1904 MB | 120–121 / 238–248 / 422–507 | — | 83 MB |
| **sin mem pattern** | **1278 MB** | **116 / 179 / 392** | **1425/1425** | 83 MB |
| sin arena | 1045 MB | 148 / 182 / 448 | 1425/1425 | 83 MB |
| sin arena ni pattern | 991 MB | 187 / 316 / 591 | 1425/1425 | 83 MB |
| int8 dinámico | 955 MB | 115 / 175 / 364 | 96–98 % (98–99 % a <20 ms) | 23 MB |
| int8 sin arena ni pattern | 683 MB | 170 / 318 / 626 | igual que int8 | 23 MB |

(El pico incluye ~505 MB de las tres canciones ya decodificadas.)

Decisiones, tomadas por viabilidad (el dueño delegó la elección):

- **Adoptado: sin memory pattern.** Es la única opción que gana en las dos cosas a la vez: un
  tercio menos de pico y nada más de CPU, con los beats idénticos. El pattern guarda un plan
  de buffers por forma de entrada y cada canción termina en un trozo de otro largo, así que
  solo suma. Puertas en verde (benchmark 24/24, bpm-snapshot 24/24, golden 27/27, real-audio
  6/6, perf, facts, sbom, notices, suite 784). Una corrida de `perf` falló en
  `edm-174/attacks`, una etapa que el cambio no toca, con la máquina cargada; la repetición
  pasó. No cambia ninguna dependencia, así que sbom y notices quedan igual.
- **No adoptado: sin arena.** Baja más la memoria, pero la CPU varió entre +23 % y −27 % según
  la canción: en una máquina cargada eso no es una ganancia demostrada. Se puede repetir en
  el servidor cuando su cola se libere.
- **No adoptado todavía: int8.** El modelo cuatro veces más chico y la mitad de memoria son
  atractivos para el servidor, pero mueve el 2–4 % de los beats más de 1 ms. Es un cambio de
  precisión: necesita una corrida de Corpus B por etapa (`bench/remote.py run ... --split dev`)
  antes de decidir. Si se prueba, excluir la cabeza final de la cuantización
  (`nodes_to_exclude`) es lo primero que hay que medir.
- **Pendientes de medir** (no se adoptan sin números): Beat This! `small0`, y DBN o PLP sobre la
  activación de Beat This! para las bandas que derivan. La cola de mediciones del servidor
  está ocupada por la matriz de experimentos del motor; van detrás.
- **Sitio:** nada se adopta en este relevamiento. Hoy no hay una tarea que lo pida: el rate
  limit en memoria alcanza con un proceso, y otra sesión está trabajando `site/`. Cuando
  haga falta, el orden es `rate-limiter-flexible` (dos procesos), `yauzl`/`yazl` (subir y bajar
  `.osz`) y `music-metadata` (tags del audio subido).
