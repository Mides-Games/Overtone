/**
 * Overtone's logo: the overtone series (a fundamental and two fading
 * harmonics) cut by one red timing line, on its panel. It is the desktop
 * app's own icon, drawn by assets/logo.py, which also writes the SVG served
 * here (public/favicon.svg), never a redrawing of it.
 */
export default function Mark({ size = 24, className = '' }) {
  return <img src="/favicon.svg" width={size} height={size} alt="" aria-hidden="true" draggable="false" className={`shrink-0 ${className}`} />
}
