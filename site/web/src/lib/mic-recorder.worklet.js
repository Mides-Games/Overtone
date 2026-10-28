/**
 * The microphone page's recorder (W13.12), on the audio thread: the input's
 * first channel, handed to the page in blocks of 4096 samples (about 90 ms),
 * transferred rather than copied. It only listens; nothing is played back.
 */
const BLOCK = 4096

class Recorder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = new Float32Array(BLOCK)
    this.filled = 0
  }

  process(inputs) {
    const input = inputs[0]?.[0]
    if (input) {
      let i = 0
      while (i < input.length) {
        const n = Math.min(input.length - i, BLOCK - this.filled)
        this.block.set(input.subarray(i, i + n), this.filled)
        this.filled += n
        i += n
        if (this.filled === BLOCK) {
          this.port.postMessage(this.block, [this.block.buffer])
          this.block = new Float32Array(BLOCK)
          this.filled = 0
        }
      }
    }
    return true
  }
}

registerProcessor('overtone-recorder', Recorder)
