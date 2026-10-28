# 18 — Estudio oráculo (W11.2): ¿vale la pena un engine que elige?

Escrito el 2026-10-28. Es la tarea W11.2 de `docs/16-web-platform.md`: antes de
construir el router de W11.3, medir cuánto se ganaría si para cada canción se eligiera
la mejor configuración del engine. La regla del dueño: si ese techo no supera en
**5 puntos held-out** a la mejor configuración sola, el ensamble no vale la pena y se
dice.

## Veredicto

**Con las configuraciones que hoy corren en el servidor, no.** Elegir la mejor por canción
entre cinco configuraciones (Rust, app, Rust con voto, v3 con voto, v3 sin voto) gana
**+0,0 puntos held-out** en tempo ok, octava y red lines a 5 ms, y **+0,0 a +0,1** en
beats a 10 ms (intervalo de bootstrap 0,0..0,1). En dev el techo es +0,9 en tempo ok y
octava y +0,7 en beats. Las variantes de octava (ninguna, fold, fold + halve,
fold + judge), sobre los stages enteros, dan un techo de +0,2 como mucho. La meta de
**+5 puntos no está ni cerca**. Ninguna regla elegida en dev mejora el held-out.

La razón es estructural: estas configuraciones comparten el mismo núcleo (Rust y v3 dan
la misma lectura, como fija `golden.py`), y en 121 de 180 canciones todas puntúan
exactamente igual. Donde fallan, fallan juntas: el tempo ok de S2 held-out es 0 % en
las cinco. Las más distintas, **Beat This! solo y el tracker forzado, no se pudieron
correr** (ver "Lo que no se corrió"). Son las únicas que podrían cambiar el veredicto,
y el único dato previo no las favorece: Beat This! solo, en las muestras del
2026-10-26, quedó 27 puntos abajo en beats a 10 ms en S1 held-out (53,4 contra 80,5 %).

**W11.3 no se construye con estas piezas.** Para reabrirlo, primero hay que darle al
servidor esas dos configuraciones como `EXPERIMENTS` de `python/overtone_runs.py` y
correr este mismo estudio con ellas.

## Método

**Datos.** Los tres stages de `bench/stages.json` (S1 `anime-single`, S2
`anime-variable`, S3 `bands-variable`), solo mapas ranked, approved o loved (el
`osu!.db` del servidor), con el split de siempre: cada canción va a dev (70 %) o
held-out (30 %) por el hash de su carpeta. Las red lines de los mappers son la verdad.

**Corridas.** Todo en el servidor del dueño con `bench/remote.py`, una corrida de
`bench/stages.py` por configuración y stage, **sin `--split`**: dev y held-out en la
misma corrida, así cada configuración ajusta sus convenciones (la del offset y la de los
beats) sobre su propio dev, como hace el stage, y el held-out se lee una sola vez. Nada
pesado corrió en la PC (regla del dueño del 2026-10-28).

**Métricas**, por mapa, las de `bench/stages.py`:

- **tempo ok:** todas las red lines en la octava del mapa y a 0,05 BPM o menos;
- **octava x1:** la primera red line en la octava del mapa;
- **beats 10 ms:** F-measure de los beats a 10 ms, con la convención de beats de dev
  descontada;
- **red lines 5 ms:** tempo ok y todas las red lines a 5 ms o menos, con la convención
  de offset de dev descontada (la de cada configuración).

**Oráculo.** Se cruzan los informes por mapa y se quedan los mapas que todas las
configuraciones puntuaron. El oráculo elige **una configuración por canción** (todas sus
dificultades comparten el audio): "por métrica" elige la mejor para esa métrica (un techo
distinto por métrica), "conjunto" elige una sola por canción con el promedio de las
cuatro y se lee en las cuatro. **Gap** = oráculo menos la mejor configuración sola. El
intervalo del gap held-out es un bootstrap de canciones (1000 remuestreos, 95 %). El
oráculo es un techo optimista: elige mirando la verdad.

**Router, primer vistazo.** Con los rasgos que traen los informes (si cada
configuración respondió, cuántas red lines dio, y si dos configuraciones dieron la misma
primera red line en los mapas de la canción), se busca en dev la regla de una o dos
condiciones que mejor elige otra configuración en lugar de la base (la mejor en dev por
el promedio de las cuatro métricas), y se lee una vez en held-out. Se prueban miles de
reglas sobre pocas canciones: el riesgo de sobreajuste es alto y se dice con cada
número.

La herramienta es `bench/oracle.py` (una medición, no un gate):

```bash
.venv/Scripts/python.exe bench/oracle.py app=<run id> rust=<run id> ... --token-file <token>
```

Los informes nombran carpetas de una biblioteca privada: quedan en `bench/.cache/`
(ignorado por git), igual que el informe del oráculo.

## Configuraciones

| Nombre | Qué es | Corrida (`bench/remote.py run`) |
|---|---|---|
| `rust` | El motor Rust solo; donde se niega, no hay respuesta | `--engine rust` |
| `app` | Rust, y v3 sin voto donde Rust se niega: lo que corre el servidor | `--engine app` |
| `rust-vote` | Rust con el voto de Beat This! | `--engine rust --beat-vote` |
| `v3` | v3 con el voto y los jueces (el modo "Normal" de W11.1) | `--engine python --beat-vote` |
| `v3-novote` | v3 sin el voto, con los jueces de octava | `--engine python` |

Las cinco corrieron el 2026-10-28 sobre las **primeras 60 canciones de cada stage**
(`--max-songs 60`, orden de carpeta, ambos splits), con el código `239849c8`. Rust y app
corrieron además sobre los stages enteros (lo que figura abajo como contexto).

El orden de carpeta ordena por ID de set, así que la muestra se inclina a mapas viejos.
No se eligió por azar: era la forma de que todas las configuraciones vieran las mismas
canciones con lo que `bench/stages.py` ya ofrece. Quedan 180 canciones y 955 mapas
(134 canciones dev y 46 held-out).

## Resultados: cinco configuraciones, las mismas 180 canciones

Las métricas están en %. "Oráculo" es la mejor por canción para cada métrica. "Gap" es
el oráculo menos la mejor sola.

**Todos los stages juntos, dev** (134 canciones, 665 mapas; 90 canciones iguales en las
cinco):

| | tempo ok | octava x1 | beats 10 ms | red lines 5 ms |
|---|---|---|---|---|
| rust | 54,7 | 69,3 | 63,4 | 27,8 |
| app | 54,7 | 87,1 | **76,5** | 27,8 |
| rust-vote | 53,5 | 69,3 | 62,9 | 27,7 |
| v3 | 54,3 | **88,0** | 76,0 | 28,6 |
| v3-novote | **54,7** | 87,1 | 75,7 | **28,7** |
| oráculo | 55,6 | 88,9 | 77,2 | 28,7 |
| **gap** | **+0,9** | **+0,9** | **+0,7** | **+0,0** |

**Todos los stages juntos, held-out** (46 canciones, 290 mapas; 31 iguales en las
cinco):

| | tempo ok | octava x1 | beats 10 ms | red lines 5 ms |
|---|---|---|---|---|
| rust | **59,3** | 74,5 | 63,5 | **24,1** |
| app | 59,3 | **92,8** | 77,8 | 24,1 |
| rust-vote | 57,9 | 73,1 | 64,0 | 24,1 |
| v3 | 57,9 | 91,4 | **78,4** | 24,1 |
| v3-novote | 59,3 | 92,8 | 77,9 | 24,1 |
| oráculo | 59,3 | 92,8 | 78,5 | 24,1 |
| **gap** | **+0,0** | **+0,0** | **+0,0** (IC 0,0..0,1) | **+0,0** |

**Por stage**: gap del oráculo por métrica, dev / held-out, en puntos:

| Stage | Canciones dev / held-out | tempo ok | octava x1 | beats 10 ms | red lines 5 ms |
|---|---|---|---|---|---|
| S1 anime-single | 39 / 21 | +2,7 / +0,0 | +2,7 / +0,0 | +1,4 / +0,0 | +0,0 / +0,0 |
| S2 anime-variable | 48 / 12 | +0,0 / +0,0 | +0,0 / +0,0 | +0,4 / +0,0 | +0,0 / +0,0 |
| S3 bands-variable | 47 / 13 | +0,0 / +0,0 | +0,0 / +0,0 | +0,0 / +0,0 | +0,0 / +0,0 |

El mejor par (oráculo de dos, elegido en dev) es `app` + `v3`, y en held-out da lo mismo
que `app` solo: tempo ok 59,3, octava 92,8, beats 78,1 y red lines 24,1.

Lo que separa a las configuraciones es casi todo el **voto**, y no siempre para bien. En
S3 held-out `v3` gana beats 10 ms (75,9 contra 74,6) pero pierde tempo ok (49,3
contra 54,7) y octava (78,7 contra 84,0). Es el mismo cruce que el timeline ya registró
para el voto en S1 (2026-10-26). `rust` y `rust-vote` pierden octava porque, donde Rust
se niega, no responden: `app` es `rust` con esas canciones contestadas por v3.

## Variantes de octava (stages enteros, código del 2026-10-26)

Son las corridas `local-fold*` del 2026-10-26 (`fa0e758a`), cuando las tres banderas
estaban apagadas. Hay un informe por variante para S1 y S3, con el stage entero. S2
falló ese día. Esos informes guardan solo la primera red line de cada mapa: red lines
5 ms se lee en ella, que es exacto en mapas de una línea.

| Held-out (248 canciones, 1367 mapas) | tempo ok | octava x1 | beats 10 ms | red lines 5 ms |
|---|---|---|---|---|
| ninguna | 77,1 | 89,8 | 75,1 | 40,8 |
| fold | 77,1 | 89,8 | 75,1 | 40,8 |
| fold + halve | 77,1 | 91,5 | 75,3 | 40,8 |
| fold + halve + judge | 77,1 | 91,5 | 75,3 | 40,8 |
| oráculo | 77,1 | 91,5 | 75,4 | 40,8 |
| **gap** | **+0,0** | **+0,0** | **+0,1** | **+0,0** |

En dev (656 canciones) el gap es +0,2 en octava y +0,1 en beats. En 241 de 248
canciones held-out las cuatro dan lo mismo. Las banderas ya están todas prendidas por
defecto, y nada queda para elegir entre ellas.

## Router, primer vistazo

La base es la mejor configuración en dev por el promedio de las cuatro métricas: `v3`.
Los rasgos los traen los informes:

- si cada configuración respondió;
- cuántas red lines dio;
- si dos configuraciones dieron la misma primera red line en todos los mapas de la canción.

| Regla (elegida en dev) | Reglas probadas | Dev, tempo ok | Held-out |
|---|---|---|---|
| `rust` si `rust-vote` y `v3-novote` coinciden, si no `v3` | 712 | 54,3 → 55,2 | sin cambio en las cuatro |
| lo mismo y además `app` da 26 red lines o menos | 126 736 | 54,3 → 55,2 | sin cambio en las cuatro |

La regla aprende en dev lo que ya dice la tabla: donde el voto no cambia nada, da igual,
y donde cambia, en dev a veces conviene no usarlo. En held-out no mueve nada. Con 134
canciones dev y decenas de miles de reglas probadas, una ganancia en dev de este tamaño
es ruido hasta que el held-out diga otra cosa, y no la dice.

**Qué rasgos separarían los casos**, en lo que se vio:

- **Si el voto cambió las líneas.** Es el único rasgo con señal en dev: es la única
  diferencia real entre las configuraciones.
- **Si Rust se negó.** Separa `rust` de `app`, pero eso ya lo resuelve `app` sin router.

Los rasgos de W11.3 que necesitan el análisis no se pudieron probar, porque los informes
no los guardan: variabilidad del tempo local, densidad de onsets, fuerza del pulso,
confianza y margen de octava. Sí los guarda la caché de `stages.py` en el servidor.

## Lo que no se corrió, y por qué

- **Beat This! solo y el tracker forzado (`engine="legacy"`).** No existen como
  configuración en el servidor: ni `--engine` ni `EXPERIMENTS` los ofrecen. Esta sesión
  arrancó un estudio local que los corría con un memo por canción (`plain_v3` daba lo
  mismo línea por línea en 3 canciones). Se cortó a las 7 canciones por la regla del
  dueño del 2026-10-28: nada pesado en la PC. Esas 7 canciones no se informan.
- **v3 "Rápido"** (sin voto ni jueces): tampoco es una configuración del servidor.
- **`song-octave` y `piecewise-cg`:** se encolaron sobre las mismas 60 canciones, y otra
  sesión las canceló antes de que corrieran. Las dos cambiaron en `master` después
  (#31: el piecewise solo parte las líneas del tracker, y el constant-grid quedó
  prendido), así que medir las del 2026-10-27 ya no respondía nada.

## Costo

Tiempo de servidor de las corridas de este estudio, sumado de cada corrida:

| Corridas | Tiempo |
|---|---|
| Rust en los 3 stages enteros | 1305 s |
| app en los 3 stages enteros | 2683 s |
| Rust con voto, 60 canciones por stage | 1288 s |
| v3 con voto, 60 canciones por stage | 2073 s |
| v3 sin voto, 60 canciones por stage | 1159 s |
| Rust y app, 60 canciones por stage (desde la caché) | 63 s |
| **Total** | **unas 2,4 h** |

En reloj fueron unas 4 h, porque la cola compartía el servidor con otras sesiones. El
cruce de los informes tarda segundos. En la PC solo corrió el piloto de 7 canciones
(unos 10 min de CPU).

## Qué haría falta para reabrir W11.3

1. Sumar a `EXPERIMENTS` de `python/overtone_runs.py` dos configuraciones nuevas:
   - **Beat This! solo:** sus beats como red lines, con `_beats_to_lines`, llevados a
     `MAP_OCTAVE_RANGE`;
   - **el tracker forzado:** `engine="legacy"`.

   Medir la tabla de arriba con las siete.
2. Guardar en el informe de `stages.py` los rasgos baratos que el análisis ya calcula:
   - BPM global;
   - ataques por segundo;
   - residuo;
   - estabilidad;
   - margen de octava;
   - si el voto cambió algo.

   Así el router se prueba con los rasgos de W11.3 y no solo con los de los informes.
3. Correr el estudio con más canciones held-out. 46 canciones dan un intervalo de varios
   puntos para cualquier gap que no sea cero.
