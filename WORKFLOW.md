# Modalidad de trabajo por tarea

Todo cambio en este repo recorre estos pasos, en orden, sin saltarse ninguno.
Está pegada a las reglas de `AGENTS.md` (un cambio lógico por commit, sin
trailers, todo gate en una línea local).

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
.venv/Scripts/python.exe -m unittest test_timing_analyzer
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

## 4. Commitear

- Rama primero si el trabajo está en curso; nunca sobre la rama base a medias.
- Mensaje imperativo corto + cuerpo con el **porqué** (el diff ya dice el
  qué). Sin `Co-Authored-By`, sin firmas de herramienta.
- El cuerpo cita la medición del paso 3.
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
volver al paso 1.
