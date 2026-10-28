// Analyse one song and print its red lines and the [TimingPoints] block.
//
//   OVERTONE_TOKEN=ot_... node examples/analyze.mjs path/to/song.mp3
//
// OVERTONE_URL points it at another Overtone (http://127.0.0.1:3001, say).
import { Overtone, OvertoneError } from '../overtone.mjs'

const [path] = process.argv.slice(2)
if (!path) {
  console.error('usage: node examples/analyze.mjs <audio file>')
  process.exit(2)
}

const overtone = new Overtone({ token: process.env.OVERTONE_TOKEN, baseUrl: process.env.OVERTONE_URL })
const status = (a) =>
  `\r${a.status}${a.position ? ` (#${a.position} in the queue)` : ''}${a.progress ? ` ${Math.round(a.progress * 100)}%` : ''}   `

try {
  const analysis = await overtone.analyzeFile(path, { onUpdate: (a) => process.stderr.write(status(a)) })
  process.stderr.write('\n')
  if (analysis.status === 'refused') {
    console.log(`No steady pulse: ${analysis.result.refusal?.message ?? 'the engine refused this audio.'}`)
  } else {
    for (const line of analysis.result.red_lines) {
      console.log(`${(line.time_ms / 1000).toFixed(3).padStart(9)} s  ${line.bpm.toFixed(3)} BPM  ${line.meter}/4`)
    }
    console.log(await overtone.analysisTimingText(analysis.id))
  }
} catch (error) {
  if (!(error instanceof OvertoneError)) throw error
  console.error(`${error.name} ${error.code ?? ''}: ${error.message}`)
  process.exit(1)
}
