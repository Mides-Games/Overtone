import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A list read a page at a time with the API's cursor (W5.1, W3.26).
 * `load(filters, { cursor })` resolves to `{ items, next }`. A change of
 * `filters` (compared by value, after `delay` ms so typing does not send a
 * request per key) starts again from the first page; `more()` appends the
 * next one. An answer that arrives after the filters changed is dropped.
 */
export function usePagedList(load, filters, { delay = 300 } = {}) {
  const [state, setState] = useState({ items: null, next: null, loading: true, error: false })
  const key = JSON.stringify(filters)
  const generation = useRef(0)

  useEffect(() => {
    const mine = ++generation.current
    setState((s) => ({ ...s, loading: true, error: false }))
    const timer = setTimeout(() => {
      load(JSON.parse(key), {})
        .then(({ items, next }) => mine === generation.current && setState({ items, next, loading: false, error: false }))
        .catch(() => mine === generation.current && setState((s) => ({ ...s, loading: false, error: true })))
    }, delay)
    return () => clearTimeout(timer)
  }, [load, key, delay])

  const more = useCallback(() => {
    if (!state.next || state.loading) return
    const mine = generation.current
    setState((s) => ({ ...s, loading: true }))
    load(JSON.parse(key), { cursor: state.next })
      .then(({ items, next }) =>
        mine === generation.current && setState((s) => ({ items: [...(s.items ?? []), ...items], next, loading: false, error: false })),
      )
      .catch(() => mine === generation.current && setState((s) => ({ ...s, loading: false, error: true })))
  }, [load, key, state.next, state.loading])

  /** Changes one loaded item in place (a publish or unpublish), or drops it (`null`: deleted). */
  const update = useCallback((id, change) => {
    setState((s) => ({
      ...s,
      items: (s.items ?? []).flatMap((item) => (item.id !== id ? [item] : change === null ? [] : [{ ...item, ...change }])),
    }))
  }, [])

  return { ...state, more, update }
}
