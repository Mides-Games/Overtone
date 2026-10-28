/**
 * The tray's optional sound (W3.23): two short sine notes made with Web Audio,
 * so there is no asset to fetch. Off by default; the tray turns it on.
 *
 * Browsers only let a page make sound after the person has interacted with
 * it, so the context is created (or resumed) by `unlockChime` from the click
 * that switches the sound on; until then `chime` stays silent rather than fail.
 */
let context = null

export function unlockChime() {
  try {
    const Context = window.AudioContext ?? window.webkitAudioContext
    if (!Context) return
    context ??= new Context()
    if (context.state === 'suspended') context.resume().catch(() => {})
  } catch {
    context = null
  }
}

/** A rising pair for an answer, a falling one for a refusal or a failure. */
export function chime(good = true) {
  if (!context || context.state !== 'running') return
  try {
    const start = context.currentTime + 0.01
    const notes = good ? [880, 1318.5] : [659.3, 523.3]
    notes.forEach((frequency, i) => {
      const at = start + i * 0.13
      const tone = context.createOscillator()
      const gain = context.createGain()
      tone.type = 'sine'
      tone.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, at)
      gain.gain.exponentialRampToValueAtTime(0.08, at + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.12)
      tone.connect(gain).connect(context.destination)
      tone.start(at)
      tone.stop(at + 0.13)
    })
  } catch {
    // No sound is a fine outcome; the tray still shows the notice.
  }
}
