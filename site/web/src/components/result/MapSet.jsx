import { useTranslation } from 'react-i18next'

import { DIFFICULTIES, MANIA_KEYS, MODES, TEST_SUBS } from '../../lib/mapping.js'

/**
 * What the .osz holds besides its Timing difficulty (W13.1, W13.5): the game
 * mode every difficulty is written for (and mania's key count), empty
 * difficulties Easy to Expert with the same timing, and a playable test map
 * with a circle on every beat or half beat. Each is off until the reader asks:
 * an .osz nobody configured stays the one Timing difficulty it always was.
 * `options` and `onChange` are OszOptions.jsx's; `breaks` is how many breaks
 * the test map will leave empty.
 */
export default function MapSet({ options, onChange, breaks = 0 }) {
  const { t } = useTranslation()
  const set = (patch) => onChange((o) => ({ ...o, ...patch }))
  const toggleDifficulty = (name) =>
    onChange((o) => ({ ...o, difficulties: o.difficulties.includes(name) ? o.difficulties.filter((d) => d !== name) : [...o.difficulties, name] }))
  const count = 1 + options.difficulties.length + (options.testSub ? 1 : 0)

  return (
    <div className="space-y-3 border-t border-line pt-3">
      <h3 className="label">{t('mapSet.title')}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <fieldset className="space-y-1.5">
          <legend className="text-caption text-text">{t('mapSet.mode')}</legend>
          <div className="flex flex-wrap gap-1.5">
            {MODES.map((m) => (
              <button key={m.mode} type="button" className="tool-btn px-2.5" aria-pressed={options.mode === m.mode} onClick={() => set({ mode: m.mode })}>
                {t(`mapSet.modes.${m.key}`)}
              </button>
            ))}
          </div>
          {options.mode === 3 && (
            <label className="flex items-center gap-2 text-caption text-text">
              <span>{t('mapSet.keys')}</span>
              <select className="field h-8 w-auto py-0 text-label" value={options.keys} onChange={(e) => set({ keys: Number(e.target.value) })}>
                {MANIA_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {k}K
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="text-caption text-dim">{t('mapSet.modeNote')}</p>
        </fieldset>

        <fieldset className="space-y-1.5">
          <legend className="text-caption text-text">{t('mapSet.test')}</legend>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className="tool-btn px-2.5" aria-pressed={!options.testSub} onClick={() => set({ testSub: 0 })}>
              {t('mapSet.off')}
            </button>
            {TEST_SUBS.map((sub) => (
              <button key={sub} type="button" className="tool-btn min-w-11" aria-pressed={options.testSub === sub} onClick={() => set({ testSub: sub })}>
                1/{sub}
              </button>
            ))}
          </div>
          <p className="text-caption text-dim">{t('mapSet.testNote')}</p>
          {options.testSub > 0 && breaks > 0 && <p className="text-caption text-dim">{t('mapSet.testBreaks', { n: breaks })}</p>}
        </fieldset>
      </div>

      <fieldset className="space-y-1.5">
        <legend className="text-caption text-text">{t('mapSet.difficulties')}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {DIFFICULTIES.map((d) => (
            <label key={d.name} className="flex cursor-pointer items-center gap-1.5 text-label text-text">
              <input type="checkbox" className="accent-[var(--accent)]" checked={options.difficulties.includes(d.name)} onChange={() => toggleDifficulty(d.name)} />
              <span>{d.name}</span>
            </label>
          ))}
        </div>
        <p className="text-caption text-dim">{t('mapSet.difficultiesNote')}</p>
      </fieldset>
      <p role="status" className="text-caption text-text">
        {t('mapSet.count', { n: count })}
      </p>
    </div>
  )
}
