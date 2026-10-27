import { useCallback, useEffect, useState } from 'react'

import { decodeHeld, heldAudio, holdAudio, sha1Hex } from '../lib/session-audio.js'

/**
 * The song behind analysis `id`, decoded in this browser (ADR-W4).
 *
 * States: `none` (no file this session: ask for it), `checking` (hashing a
 * file picked again), `mismatch` (it is other audio), `unverifiable` (the
 * analysis carries no hash to check against), `decoding`, `ready`, `error`
 * (this browser cannot decode the format). Only a file whose SHA-1 matches the
 * analysis's is played or drawn: lining another song up with these red lines
 * would show a timing that was never measured.
 *
 * `verify(digest)` stands in for `sha1` where the page may not know the hash:
 * a published timing's visitor (W3.27) asks the server whether the file's
 * hash matches, and only hears yes or no.
 */
export function useSongAudio(id, sha1, verify = null) {
  const [state, setState] = useState(() => ({ kind: heldAudio(id) ? 'decoding' : 'none' }))

  const decode = useCallback(
    (file) => {
      setState({ kind: 'decoding', name: file.name })
      decodeHeld(id)
        .then((song) => setState({ kind: 'ready', name: file.name, song }))
        .catch((error) => setState({ kind: 'error', name: file.name, message: String(error?.message ?? error) }))
    },
    [id],
  )

  useEffect(() => {
    const file = heldAudio(id)
    if (file) decode(file)
    else setState({ kind: 'none' })
  }, [id, decode])

  const pick = useCallback(
    async (file) => {
      if (!file) return
      if (!sha1 && !verify) return setState({ kind: 'unverifiable', name: file.name })
      setState({ kind: 'checking', name: file.name })
      let same
      try {
        const digest = await sha1Hex(file)
        same = sha1 ? digest === sha1.toLowerCase() : await verify(digest)
      } catch (error) {
        return setState({ kind: 'error', name: file.name, message: String(error?.message ?? error) })
      }
      if (!same) return setState({ kind: 'mismatch', name: file.name })
      holdAudio(id, file)
      decode(file)
    },
    [id, sha1, verify, decode],
  )

  return { ...state, pick }
}
