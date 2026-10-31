import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import Avatar from '../components/Avatar.jsx'
import { MidesRank, OvertoneRank, OvertoneRelated } from '../components/team/RankBadge.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import PageHeader from '../components/ui/PageHeader.jsx'
import SectionHeader from '../components/ui/SectionHeader.jsx'
import { SkeletonRows } from '../components/ui/Skeleton.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { team } from '../lib/team.js'

/**
 * The team, public. `/team`: Mides Projects' staff (their Mides rank, and
 * "Overtone related" when they also hold an Overtone rank) and Overtone's own
 * staff. `/testers`: the testers, translators and contributors. Mides ranks
 * are Mides'; Overtone's are given on /staff.
 */
export default function Team({ section = 'staff' }) {
  const { t } = useTranslation()
  const testers = section === 'testers'
  usePageMeta(t(testers ? 'crew.testersTitle' : 'crew.staffTitle'), t(testers ? 'crew.testersLede' : 'crew.staffLede'))
  const [data, setData] = useState(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    team()
      .then((next) => alive && setData(next))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="space-y-14">
      <PageHeader
        eyebrow={t('crew.eyebrow')}
        title={t(testers ? 'crew.testersTitle' : 'crew.staffTitle')}
        lede={t(testers ? 'crew.testersLede' : 'crew.staffLede')}
      />
      {failed && (
        <p role="alert" className="text-caption text-red">
          {t('crew.failed')}
        </p>
      )}
      {!data && !failed && <SkeletonRows rows={4} label={t('common.loading')} className="border-y border-line" />}
      {data && testers && <Group id="crew-testers" title={t('crew.testersTitle')} members={data.testers} empty={t('crew.noTesters')} />}
      {data && !testers && (
        <>
          <Group id="crew-mides" title={t('crew.midesGroup')} note={t('crew.midesNote')} members={data.mides} empty={t('crew.noStaff')} mides />
          <Group id="crew-overtone" title={t('crew.overtoneGroup')} members={data.staff} empty={t('crew.noStaff')} />
        </>
      )}
    </div>
  )
}

/** /testers: the same page, its testers' part. */
export function Testers() {
  return <Team section="testers" />
}

function Group({ id, title, note = null, members, empty, mides = false }) {
  return (
    <section aria-labelledby={id} className="space-y-5">
      <SectionHeader id={id} title={title} />
      {note && <p className="max-w-[60ch] text-label text-muted">{note}</p>}
      {members.length === 0 ? (
        <EmptyState title={empty} className="border-y border-line py-6" />
      ) : (
        <ul className="grid gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
          {members.map((m) => (
            <li key={m.username} className="flex items-center gap-3 border-t border-line py-4">
              <Avatar account={m} size={44} />
              <div className="min-w-0 space-y-1.5">
                <p className="truncate text-label font-semibold text-text">
                  {m.profile ? (
                    <Link to={`/u/${m.username}`} className="link">
                      {m.displayName || m.username}
                    </Link>
                  ) : (
                    m.displayName || m.username
                  )}
                  <span className="readout font-normal text-dim"> @{m.username}</span>
                </p>
                <p className="flex flex-wrap gap-1.5">
                  {mides ? (
                    <>
                      <MidesRank rank={m.midesRank} />
                      {m.overtoneRelated && <OvertoneRelated />}
                    </>
                  ) : (
                    <OvertoneRank rank={m.overtoneRank} />
                  )}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
