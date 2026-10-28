// A Discord-style bot in one file: analyse the songs you name and post each
// result to a Discord channel through a webhook (Channel settings ->
// Integrations -> Webhooks). No library, no gateway connection, no bot
// account: one HTTPS POST per song to the webhook you configured, and
// nothing else leaves this machine.
//
//   OVERTONE_TOKEN=ot_... DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/... \
//     node examples/discord-webhook.mjs song1.mp3 song2.ogg
//
// Without DISCORD_WEBHOOK_URL it prints the message it would have posted.
// The official bot, with slash commands, is bot/ in the Overtone repository.
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Overtone, OvertoneError } from '../overtone.mjs'

/** The Discord message (one embed) for one finished analysis. */
export function messageFor(analysis, filename) {
  const result = analysis.result ?? {}
  if (analysis.status === 'refused') {
    return { embeds: [{ title: filename, description: `No steady pulse: ${result.refusal?.message ?? 'refused'}`, color: 0x8b8798 }] }
  }
  const lines = result.red_lines ?? []
  const shown = lines.slice(0, 10).map((l) => `\`${(l.time_ms / 1000).toFixed(3)} s\`  **${l.bpm.toFixed(2)}** BPM  ${l.meter}/4`)
  if (lines.length > shown.length) shown.push(`... and ${lines.length - shown.length} more`)
  return {
    embeds: [{
      title: filename,
      description: shown.join('\n'),
      color: 0x7c5cff,
      fields: [
        { name: 'BPM', value: result.global_bpm === null || result.global_bpm === undefined ? 'variable' : String(result.global_bpm), inline: true },
        { name: 'Red lines', value: String(lines.length), inline: true },
        { name: 'Offset', value: `${Math.round(result.offset_ms ?? 0)} ms`, inline: true },
      ],
      footer: { text: 'Overtone' },
    }],
  }
}

async function post(webhook, message, retried = false) {
  if (!webhook) return console.log(JSON.stringify(message, null, 2))
  const response = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message) })
  // Discord's own rate limit: wait what it says, once.
  if (response.status === 429 && !retried) {
    const wait = Math.min(Number(response.headers.get('Retry-After')) || 1, 60)
    await new Promise((resolve) => setTimeout(resolve, wait * 1000))
    return post(webhook, message, true)
  }
  if (!response.ok) throw new Error(`Discord answered ${response.status}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const overtone = new Overtone({ token: process.env.OVERTONE_TOKEN, baseUrl: process.env.OVERTONE_URL })
  const webhook = process.env.DISCORD_WEBHOOK_URL
  for (const path of process.argv.slice(2)) {
    try {
      const analysis = await overtone.analyzeFile(path)
      await post(webhook, messageFor(analysis, basename(path)))
    } catch (error) {
      if (!(error instanceof OvertoneError)) throw error
      await post(webhook, { content: `${basename(path)}: ${error.code ?? error.name}: ${error.message}` })
    }
  }
}
