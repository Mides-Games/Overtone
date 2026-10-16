# Modalidad de trabajo por tarea

Todo cambio en este repo recorre estos pasos, en orden, sin saltarse ninguno.
Está pegada a las reglas de `AGENTS.md` (un cambio lógico por commit, sin
trailers, todo gate en una línea local).

## 0. Elegir la tarea y la opción

Las opciones no se consultan: se eligen solas, por el criterio del momento.
A igualdad de condiciones gana la **mejor**, la **más recomendada** o la
**más solicitada** en ese momento:

- **Mejor:** la que más acerca el objetivo medido — la tabla de
  `docs/07-roadmap.md`, su columna Pri y su "What is pending, in order".
- **Más recomendada:** la que la documentación marca como siguiente paso o
  como desbloqueo de las demás.
- **Más solicitada:** la que más pesa para quien lo usa.

Si ninguna destaca, manda el orden del roadmap. La elección y el criterio que
la decidió se anotan (en el cuerpo del commit o en `docs/timeline.md`), para que
se pueda auditar.

## 1. Programar

- Un cambio lógico por tarea. Si asoman dos, se parte en dos.
- El port sigue al contrato (`docs/05-dsp-pipeline.md`): primero paridad con
  v3, después mejora, cada una detrás de su gate.
- Respetar CRLF en `.rs` (el resto del código lo usa) y nada de `unsafe`.

## 2. Testear

Verde antes de seguir. Según lo tocado:

```bash
cargo test --workspace                                   # Rust, todo
cargo run --release -q -p overtone-bench -- golden      # paridad vs v3
cargo run --release -q -p overtone-bench -- density     # hints F-11
cargo run --release -q -p overtone-bench -- elastic     # rampas + deriva
.venv/Scripts/python.exe -m unittest discover -s tests
.venv/Scripts/python.exe bench/benchmark.py
.venv/Scripts/python.exe bench/gates.py bpm-snapshot
.venv/Scripts/python.exe bench/golden.py check
```

Si el paso 1 no trae su test (unitario o gate), volver al paso 1.

## 3. Ver rendimiento

- Ninguna afirmación de precisión o velocidad sin número medido en el mismo
  commit. El bench imprime sus propios tiempos: no confundir build con motor.
- Comparar contra la referencia que toque: baseline v3 (24/24, 0.0000 BPM /
  0.16 ms), prototipo de `proto/` (density 4/4 + 0 FP; elastic 0.14–0.16 BPM),
  o gate de `docs/05-dsp-pipeline.md` parte B.
- Anotar los números; "not measured" también es un resultado válido.
- Para repetir T6 con una muestra independiente, usar `bench/labels.py` con
  `--seed`, `--exclude-from`, `--cache` y `--output`. El JSON de salida se
  escribe tras cada carpeta y la ejecución se reanuda solo si la muestra coincide;
  cada fila medida se reutiliza únicamente si los SHA-1 del mapa y del audio
  siguen iguales. Mantener caché y resultado bajo `bench/.cache/`, nunca añadir
  datos de `Songs` al repositorio. Ejemplo:

  ```powershell
  .venv/Scripts/python.exe bench/labels.py --songs "C:\osu!\Songs" --seed 61 --exclude-from bench/labels.json --cache bench/.cache/t6/structures.json --output bench/.cache/t6/result.json
  ```

  No reducir `--tune` / `--heldout` para declarar el roadmap cerrado: el bar es
  +15 puntos tanto en ajuste como en la muestra independiente.

## 4. Commitear

El formato vive en `AGENTS.md` y no se negocia: commits, ramas y títulos de
PR en **inglés**, asunto `type(scope/task): short imperative description`
(e.g. `fix(engine/octave): prefer the mapped pulse on ties`), tipos
`feature · fix · refactor · perf · bench · test · docs · chore`, rama
`type/short-topic` (e.g. `chore/repo-layout`).

- Rama primero si el trabajo está en curso; nunca sobre la rama base a medias.
- Asunto en una línea + cuerpo con el **porqué** (el diff ya dice el
  qué). Sin `Co-Authored-By`, sin firmas de herramienta.
- El cuerpo cita la medición del paso 3 y los gates corridos con su resultado.
- Antes de cerrar el commit: todo `.rs` nuevo tiene su línea `mod` y todo
  cambio necesario está staged (`git status` + compilar con solo lo staged
  en la cabeza). Dos commits incompletos por esta causa bastan para la regla.

## 5. Auditar

Releer el diff buscando, en este orden:

1. Corrección: ¿reproduce a v3 (`np.round` vs `.round()`, `np.mod` vs
   `rem_euclid`, tolerancias, ventanas inclusivas)?
2. Basura: código muerto, warnings del compilador, helpers de un solo uso,
   tests que no fallarían nunca (vacuos), comentarios que repiten el código.
3. Rendimiento: ¿hay un O(n²) evitable en el path caliente? ¿alguna
   asignación por beat que un pre-size elimina? Medir antes de tocar.

## 6. Commitear de nuevo (solo si el paso 5 cambió algo)

Mismo formato que el paso 4, cuerpo explicando qué encontró la auditoría.
Si no cambió nada, se omite sin culpa.

## 7. Proseguir con la siguiente tarea

Actualizar la tabla de `docs/07-roadmap.md` si una fase cambió de estado, y
volver al paso 0.

## 8. Mantener el mapa del proyecto

Actualizar `docs/project-map.md` en cada cambio del proyecto: módulos, crates,
flujos de datos, pasos de build, relaciones de verificación, y cifras del bloque
de datos actuales cuando cambien conteos o mediciones documentadas. Ejecutar
`bench/facts.py` antes de anotar conteos o esquema.

Usar Graphify en modo local para actualizar el grafo del código y su reporte:

```powershell
graphify extract . --code-only --cargo
graphify cluster-only . --no-label
graphify god-nodes --top 15
graphify query "<system or symbol>"
```

Cuando cambien tareas, features, prioridades o estados, actualizar el índice
curado `docs/project-status.json` y regenerar el mapa interactivo de estado:

```powershell
.venv/Scripts/python.exe scripts/graphify_project_status.py
& "$env:TEMP\overtone-graphify-env\Scripts\graphify.exe" cluster-only graphify-out\project-status --no-label
```

Revisar el HTML y el reporte generados contra las fuentes. El índice enlaza cada
nodo al documento y línea que justifican su estado; no editar el HTML a mano.
El Mermaid y la tabla de `docs/project-map.md` siguen siendo el índice humano de
arquitectura y relaciones documentales. Graphify permanece fuera de las
dependencias del producto. No usar extracción semántica, APIs, endpoints,
claves, hooks ni watchers para este repositorio. Los artefactos portables se
mantienen bajo `graphify-out/`; cachés, manifiestos y marcadores de ruta son
locales y deben quedar ignorados por Git.

## Definición de hecho

Una tarea está hecha cuando cumple todo esto, sin excepciones:

1. Los gates del paso 2 están verdes con números, no con sensaciones.
2. `bench/facts.py` no reporta discrepancias (los conteos que los docs
   afirman siguen siendo los del código).
3. `docs/timeline.md` tiene su entrada con las secciones Changed / Fixed /
   Hardening / Measured, y `Rejected / tried and dropped` si se abandonó un
   enfoque (el razonamiento es lo caro; se escribe una vez y se hereda siempre).
4. `docs/07-roadmap.md` refleja el estado real de las fases tocadas.
5. El diff pasó la auditoría del paso 5 sin pendientes.
6. `docs/project-map.md` refleja el árbol y los flujos actuales; todo cambio
   del proyecto actualizó y revisó el mapa.
7. Si cambió código o dependencias, Graphify se regeneró en modo local y se
   revisaron `graph.json`, `GRAPH_REPORT.md` y `graph.html`.
8. Si cambió el roadmap, se actualizó `docs/project-status.json` y se regeneró
   `graphify-out/project-status/graphify-out/graph.html`.

## Pull requests

Sin bots ni plantillas automáticas: los checks corren en local. Cada PR
hecho con `gh` responde tres cosas y trae la checklist marcada:

- Qué cambió y por qué (una o dos frases; el diff ya dice el cómo).
- Gates corridos con su resultado (comando + números, pega la salida).
- Checklist:
  - [ ] un cambio lógico por commit, formato `type(scope/task): …` en inglés
  - [ ] gates verdes + `bench/facts.py` ok
  - [ ] entrada en `docs/timeline.md` (o "sin entrada porque …")
  - [ ] roadmap actualizado si cambió una fase

## Documentos nuevos

- Los docs de diseño llevan el siguiente número libre (`docs/NN-nombre.md`) y
  una fila en la tabla de documentación del `README.md`.
- Los docs de proceso (rutinas, plantillas) van sin número en `docs/` con
  nombre en minúsculas (`workflow.md`, `timeline.md`).
- `docs/timeline.md` es el changelog: no crear un `CHANGELOG.md` aparte que
  haya que mantener en paralelo.
