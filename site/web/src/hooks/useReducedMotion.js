import { useEffect, useState } from 'react'

import { useSettings } from '../context/SettingsContext.jsx'
import { motionReduced } from '../lib/settings.js'

/**
 * Whether motion is cut: the site setting (W12.15) when the reader chose,
 * else the system's `prefers-reduced-motion`, followed live. CSS already
 * stops transitions under both; this is for motion a script drives (the
 * hero strip's playhead, the staggered entrance of components/ui/Reveal.jsx).
 */
export default function useReducedMotion() {
  const setting = useSettings()?.settings?.reducedMotion ?? 'system'
  const [system, setSystem] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined
    const query = matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setSystem(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return motionReduced(setting, system)
}
