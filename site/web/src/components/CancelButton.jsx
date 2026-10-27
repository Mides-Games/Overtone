import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cancelAnalysis } from '../lib/api.js'
import { forgetAnalysis } from '../lib/recent.js'

/**
 * Takes one of your own songs out of the queue (W3.12). Shown only while it
 * waits: once the worker has it, the server answers 409 and this says so.
 * `onCancelled` runs after the server deleted it.
 */
export default function CancelButton({ id, onCancelled, className = '' }) {
  const { t } = useTranslation()
  const [state, setState] = useState({ kind: 'idle' })

  async function cancel(event) {
    event.preventDefault()
    event.stopPropagation()
    setState({ kind: 'busy' })
    try {
      await cancelAnalysis(id)
      forgetAnalysis(id)
      setState({ kind: 'idle' })
      onCancelled?.()
    } catch (error) {
      setState({ kind: 'error', message: error.code === 'NOT_QUEUED' ? t('cancel.notQueued') : t('cancel.failed') })
    }
  }

  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <button type="button" onClick={cancel} disabled={state.kind === 'busy'} className="btn-ghost h-7 px-2.5 text-caption">
        {state.kind === 'busy' ? t('cancel.busy') : t('cancel.button')}
      </button>
      {state.kind === 'error' && (
        <span role="alert" className="text-caption text-red">
          {state.message}
        </span>
      )}
    </span>
  )
}
