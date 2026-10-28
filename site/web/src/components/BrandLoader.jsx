import { useTranslation } from 'react-i18next'

/**
 * The loader: one bar of four beats pulsing in time, the downbeat in red as a
 * red line would sit. Frozen for people who ask for reduced motion.
 */
const BEATS = ['var(--red)', 'var(--accent)', 'var(--accent)', 'var(--accent)']

export default function BrandLoader({ className = '' }) {
  const { t } = useTranslation()
  return (
    <div className={`flex items-center justify-center ${className}`} role="status">
      <span className="flex h-7 items-end gap-1.5" aria-hidden="true">
        {BEATS.map((color, i) => (
          <span key={i} className="beat-bar h-full" style={{ background: color, animationDelay: `${i * 0.3}s` }} />
        ))}
      </span>
      <span className="sr-only">{t('common.loading')}</span>
    </div>
  )
}
