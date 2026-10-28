import Icon from '../ui/Icon.jsx'

/**
 * The front page's small line drawings, one per benefit and step, from the
 * site's one icon set (components/ui/Icon.jsx): 24 px, a 1.5 px stroke in the
 * text's colour, decorative (the heading beside each says it). Red and amber
 * keep the site's meanings: a red line is a timing point, amber is something
 * to check by ear, and the tempo colour is the tempo curve.
 */
const NAMES = {
  time: 'clock', // a clock: time given back
  variable: 'red-lines', // two red lines over a tempo plot that steps up
  osz: 'package', // the .osz
  check: 'headphones', // amber on one cup: check by ear
  free: 'unlock', // no account, nothing kept
  upload: 'upload',
  analyse: 'wave',
  listen: 'listen',
}

export default function GainIcon({ name, size = 24, className = '' }) {
  return <Icon name={NAMES[name] ?? name} size={size} className={className} />
}
