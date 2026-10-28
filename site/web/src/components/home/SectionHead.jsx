import SectionHeader from '../ui/SectionHeader.jsx'

/**
 * A front-page section's heading: the site's section header
 * (components/ui/SectionHeader.jsx) with the front page's way of passing the
 * action, as children.
 */
export default function SectionHead({ id, eyebrow, title, lede, children, className }) {
  return <SectionHeader id={id} eyebrow={eyebrow} title={title} lede={lede} action={children} className={className} />
}
