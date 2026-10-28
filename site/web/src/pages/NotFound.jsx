import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import Icon from '../components/ui/Icon.jsx'
import Waveform from '../components/ui/Waveform.jsx'
import usePageMeta from '../hooks/usePageMeta.js'

/**
 * Nothing at this address: the site's signature drawing with no red line on
 * it (nothing was timed here), the code as a readout, and the way home.
 */
export default function NotFound() {
  const { t } = useTranslation()
  usePageMeta(t('notFound.title'))
  return (
    <div className="rise max-w-xl space-y-6 py-10 sm:py-16">
      <Waveform bars={48} lines={[]} seed={19} className="h-10 w-48 opacity-90" />
      <p className="readout text-display font-medium leading-none text-dim">404</p>
      <h1 className="heading-headline">{t('notFound.title')}</h1>
      <Link to="/" className="btn-primary">
        {t('notFound.back')}
        <Icon name="arrow-right" size={18} />
      </Link>
    </div>
  )
}
