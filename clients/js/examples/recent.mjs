// The newest published timings, and the first of them as CSV.
//
//   OVERTONE_TOKEN=ot_... node examples/recent.mjs [search words]
import { Overtone } from '../overtone.mjs'

const overtone = new Overtone({ token: process.env.OVERTONE_TOKEN, baseUrl: process.env.OVERTONE_URL })
const { timings } = await overtone.timings({ q: process.argv.slice(2).join(' '), limit: 10 })
for (const t of timings) {
  const song = [t.artist, t.title].filter(Boolean).join(' - ') || '(untitled)'
  console.log(`${t.id}  ${String(t.bpm ?? '?').padStart(7)} BPM  ${String(t.redLines).padStart(3)} lines  ${song}`)
}
if (timings[0]) console.log(`\n${await overtone.timingCsv(timings[0].id)}`)
