import { useEffect, useRef, useState } from 'react'

import useReducedMotion from '../../hooks/useReducedMotion.js'

/**
 * A staggered entrance on scroll (docs/design.md, section 5): the children
 * with `data-reveal` rise 8 px and fade in when the group first comes into
 * view, 35 ms apart, the seventh and after at once. Transform and opacity
 * only, with the strong ease-out.
 *
 * Only a group that starts below the fold is held back, and only once the
 * script runs: without it, in a thumbnail, in print, or with reduced motion
 * (the system's or the site's setting), everything is simply there. What the
 * first screen shows never waits for an animation.
 *
 *   <Reveal as="ul" className="grid ...">
 *     {items.map((item, i) => <li key={item} data-reveal style={{ '--i': i }}>...</li>)}
 *   </Reveal>
 *
 * Put `data-reveal` on the element itself (not inside) for a single block.
 */
export default function Reveal({ as: Tag = 'div', className = '', children, ...rest }) {
  const ref = useRef(null)
  const reduced = useReducedMotion()
  // 'idle': drawn as is. 'armed': held back, waiting to be seen. 'in': shown.
  const [state, setState] = useState('idle')

  useEffect(() => {
    const element = ref.current
    if (!element || reduced || typeof IntersectionObserver !== 'function') return undefined
    // Already on screen when the page draws: leave it alone.
    if (element.getBoundingClientRect().top < window.innerHeight) return undefined
    setState('armed')
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        setState('in')
        observer.disconnect()
      },
      { rootMargin: '0px 0px -12% 0px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [reduced])

  return (
    <Tag ref={ref} className={className} data-reveal-state={state} {...rest}>
      {children}
    </Tag>
  )
}
