import { useTranslation } from 'react-i18next'

/**
 * A rank as a chip: Mides Projects' in the accent, Overtone's neutral, and
 * "Overtone related" on a Mides staff member who also holds an Overtone rank.
 */
export function MidesRank({ rank }) {
  const { t } = useTranslation()
  if (!rank) return null
  return <span className="chip-accent" title={t('crew.midesTitle')}>Mides · {t(`crew.mides.${rank}`)}</span>
}

export function OvertoneRank({ rank }) {
  const { t } = useTranslation()
  if (!rank) return null
  return <span className="chip-tempo">{t(`crew.overtone.${rank}`)}</span>
}

export function OvertoneRelated() {
  const { t } = useTranslation()
  return <span className="chip-neutral" title={t('crew.relatedTitle')}>{t('crew.related')}</span>
}

/** Both ranks of a profile, or nothing. */
export function ProfileRanks({ user }) {
  if (!user?.midesRank && !user?.overtoneRank) return null
  return (
    <p className="flex flex-wrap gap-2 pt-1">
      <MidesRank rank={user.midesRank} />
      <OvertoneRank rank={user.overtoneRank} />
    </p>
  )
}
