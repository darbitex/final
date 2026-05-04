// VerbIcons — minimal inline SVG icons for the 4 verb-action affordances on
// FeedRow + opinion panel toggle. All sized via the `size` prop, color via
// `currentColor` so they inherit text color (and disabled state).

type Props = { size?: number; className?: string };

export function SparkIcon({ size = 16, className }: Props) {
  // Lightning bolt — Spark = positive reaction / "like".
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M13 2 L3 14 h7 v8 l10-12 h-7 z" />
    </svg>
  );
}

export function EchoIcon({ size = 16, className }: Props) {
  // Two arrows in a loop — Echo = repost / amplify.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

export function PressIcon({ size = 16, className }: Props) {
  // Bookmark — Press = collect / mint as collectible NFT.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M19 3H5 c-1.1 0-2 .9-2 2 v16 l9-4 9 4 V5 c0-1.1-.9-2-2-2 z" />
    </svg>
  );
}

export function VoiceIcon({ size = 16, className }: Props) {
  // Speech bubble / reply — Voice = reply to a parent mint.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function RemixIcon({ size = 16, className }: Props) {
  // Quote marks — Remix = quote-post a parent mint.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M7 7c-2 0-3.5 1.5-3.5 3.5s1.5 3.5 3.5 3.5c.4 0 .7-.05 1-.13l-1 4.13h2.5l1.5-6c.3-1.2.5-2.3.5-3.3C11.5 8.5 9.5 7 7 7zm10 0c-2 0-3.5 1.5-3.5 3.5s1.5 3.5 3.5 3.5c.4 0 .7-.05 1-.13l-1 4.13h2.5l1.5-6c.3-1.2.5-2.3.5-3.3C21.5 8.5 19.5 7 17 7z" />
    </svg>
  );
}

export function OpinionIcon({ size = 16, className }: Props) {
  // Two stacked bars (YAY/NAY) — Opinion = belief market.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="6" width="18" height="5" rx="1" fillOpacity="0.85" />
      <rect x="3" y="13" width="13" height="5" rx="1" fillOpacity="0.55" />
    </svg>
  );
}

export function ShareIcon({ size = 16, className }: Props) {
  // Three nodes connected by lines — classic "share" glyph.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M8.2 10.8 L15.8 7.2 M8.2 13.2 L15.8 16.8" />
    </svg>
  );
}
