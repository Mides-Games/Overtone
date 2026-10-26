/** The Mides mark, as on midesprojects.com. It takes the text colour. */
export default function Logo({ size = 40, className = '' }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 200 200"
      fill="none"
      role="img"
      aria-label="Mides Projects"
      className={className}
    >
      <path
        d="M22 162 L22 74 C22 26 58 26 80 48 C86 54 88 63 88 74 C88 26 118 26 148 26 Q172 26 172 62 L172 128 C172 166 148 172 130 168 C112 164 106 150 106 136"
        stroke="currentColor"
        strokeWidth="12"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
