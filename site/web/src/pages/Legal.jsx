import LegalPage from '../components/LegalPage.jsx'

/**
 * The legal pages (W4.5-W4.7), one route each. Their text is in the locale
 * files under `legal.terms`, `legal.privacy` and `legal.disclaimer`; the
 * privacy page states what the code stores (docs/site.md says where each
 * line comes from), so a change to what is stored changes that text too.
 *
 * Terms and privacy carry the draft note until the owner fills their
 * placeholders and approves them; the disclaimer states only what the engine
 * and the benchmark already say, and has nothing left to decide.
 */
export const Terms = () => <LegalPage page="terms" />
export const Privacy = () => <LegalPage page="privacy" />
export const Disclaimer = () => <LegalPage page="disclaimer" draft={false} />
