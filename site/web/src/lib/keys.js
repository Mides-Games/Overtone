/**
 * Whether a page-wide key (the tempo map's and the listening tools') should
 * leave `event` alone: a modifier is held, the reader is typing in a field
 * (a slider, a checkbox or a button still let the keys through), or a modal
 * dialog is open and owns the keyboard.
 */
export function pageKeyIgnored(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return true
  if (typeof document !== 'undefined' && document.querySelector('dialog[open]')) return true
  const target = event.target
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
    return !(target instanceof HTMLInputElement && ['range', 'checkbox', 'radio', 'button'].includes(target.type))
  }
  return false
}
