/**
 * A WAV file from Float32 channels: 16-bit PCM, interleaved, the canonical
 * 44-byte header. Enough for a click track every editor and player opens; no
 * dependency for something this small.
 */
export function encodeWav(channels, sampleRate) {
  const count = channels.length
  const frames = count ? channels[0].length : 0
  const dataBytes = frames * count * 2
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const ascii = (at, text) => [...text].forEach((ch, i) => (bytes[at + i] = ch.charCodeAt(0)))
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // the fmt chunk's size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, count, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * count * 2, true) // bytes per second
  view.setUint16(32, count * 2, true) // bytes per frame
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  let at = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < count; c++) {
      // Clipped, not wrapped: a mix that peaks past 1 flattens instead of cracking.
      const s = Math.max(-1, Math.min(1, channels[c][i] || 0))
      view.setInt16(at, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true)
      at += 2
    }
  }
  return bytes
}
