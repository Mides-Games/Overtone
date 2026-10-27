import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import usePageMeta from '../hooks/usePageMeta.js'

export default function NotFound() {
  const { t } = useTranslation()
  usePageMeta(t('notFound.title'))
  return (
    <div className="space-y-5 py-16 text-center">
      <p className="readout text-[56px] font-semibold leading-none text-red">404</p>
      <h1 className="font-display text-title font-bold uppercase">{t('notFound.title')}</h1>
      <Link to="/" className="btn-ghost">
        {t('notFound.back')}
      </Link>
    </div>
  )
}
