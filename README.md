# osu! Timing Analyzer

Aplicación local para obtener BPMs y offsets de un audio, pensada para crear puntos rojos de osu!. No promete una exactitud imposible: audio sin percusión clara, rubato, swing y producción con transitorios suaves requieren revisión manual. Sí evita que microfluctuaciones normales se conviertan en cambios de BPM.

## Instalación y uso

```powershell
python -m pip install -r requirements.txt
python timing_analyzer.py
```

Puedes analizar también desde la terminal:

```powershell
python timing_analyzer.py "C:\ruta\cancion.wav" --delta 1.5 --persistence 8 --csv timing.csv
```

`--delta 1.5` es la separación mínima entre el tempo actual y uno nuevo. Por lo tanto, 225 a 225.2 BPM permanece en el mismo punto; un cambio estable de 225 a 227 se añade. La interfaz exige por defecto 20 beats consecutivos y 90 % de confianza antes de exportar un timing point. Esto reduce falsos positivos; baja esos valores solo al revisar cambios cortos manualmente.

El programa resuelve también half-time/double-time: prueba una, dos y cuatro subdivisiones contra los transitorios reales del audio. Por defecto, cuando las evidencias son cercanas, prefiere el rango común de mapas de osu! (120–300 BPM); no es un multiplicador fijo. Desmarca **Preferir BPM de mapa** —o usa `--no-map-preference`— para canciones que realmente son lentas.

La interfaz permite:

- Ver cada offset y BPM detectado.
- Exportar la tabla a CSV.
- Copiar timing points rojos directamente en el formato de `[TimingPoints]` de un archivo `.osu`.

Para máxima compatibilidad con MP3, M4A, AAC y otros formatos comprimidos, instala FFmpeg y asegúrate de que esté disponible en `PATH`. WAV, FLAC y OGG suelen funcionar directamente mediante SoundFile.

## Método y precisión

El análisis usa audio mono a 44.1 kHz y ventanas de 256 muestras (≈5.8 ms), detección de transitorios y seguimiento dinámico de beats. El BPM local se calcula con la mediana de varios intervalos, no con un único intervalo; luego se segmenta solo al detectar un cambio sostenido. Los offsets se expresan en milisegundos desde el inicio del audio.

Antes de mapear, comprueba en el editor que el primer beat y cada transición importante caigan sobre los transitorios. En temas con cambios graduales de tempo, puede ser apropiado bajar la persistencia o añadir puntos manuales.
