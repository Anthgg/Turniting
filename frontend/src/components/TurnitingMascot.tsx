import { useId } from 'react'
import './TurnitingMascot.css'

export type MascotState =
  | 'idle'
  | 'ready'
  | 'stand-up'
  | 'reading'
  | 'analyzing'
  | 'running'
  | 'thinking'
  | 'success'
  | 'result-reveal'
  | 'warning'
  | 'error'
  | 'network-error'
  | 'file-error'
  | 'empty'
  | 'clear'
  | 'copy'

export interface TurnitingMascotProps {
  state: MascotState
  size?: 'compact' | 'standard' | 'large'
  className?: string
}

export function TurnitingMascot({
  state,
  size = 'standard',
  className,
}: TurnitingMascotProps) {
  const id = useId()
  const pearlId = `${id}-pearl`
  const screenId = `${id}-screen`
  const scanId = `${id}-scan`
  const visorId = `${id}-visor`
  const metalId = `${id}-metal`
  const shineId = `${id}-shine`
  const shadowId = `${id}-shadow`
  const glowId = `${id}-glow`
  const headClipId = `${id}-head-clip`
  const classes = ['turniting-mascot', className].filter(Boolean).join(' ')

  return (
    <svg
      className={classes}
      viewBox="0 0 240 220"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      data-state={state}
      data-size={size}
    >
      <defs>
        <linearGradient id={pearlId} x1="0" y1="0" x2=".8" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset=".24" stopColor="#f5f8f8" />
          <stop offset=".58" stopColor="#e1e9ea" />
          <stop offset=".82" stopColor="#cbd7d9" />
          <stop offset="1" stopColor="#aabdc0" />
        </linearGradient>
        <linearGradient id={screenId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#9cf5e1" />
          <stop offset=".38" stopColor="var(--tm-accent-light)" />
          <stop offset="1" stopColor="var(--tm-accent)" />
        </linearGradient>
        <linearGradient id={visorId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#53656b" />
          <stop offset=".18" stopColor="#2b3c43" />
          <stop offset=".66" stopColor="#17262c" />
          <stop offset="1" stopColor="#0d171c" />
        </linearGradient>
        <linearGradient id={metalId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#72858a" />
          <stop offset=".36" stopColor="#34464d" />
          <stop offset="1" stopColor="#18272d" />
        </linearGradient>
        <radialGradient id={shineId} cx=".25" cy=".08" r=".9">
          <stop offset="0" stopColor="#ffffff" stopOpacity=".72" />
          <stop offset=".46" stopColor="#ffffff" stopOpacity=".18" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={shadowId} cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#40545a" stopOpacity=".27" />
          <stop offset=".62" stopColor="#40545a" stopOpacity=".11" />
          <stop offset="1" stopColor="#40545a" stopOpacity="0" />
        </radialGradient>
        <filter id={glowId} x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="1.8" result="softGlow" />
          <feMerge>
            <feMergeNode in="softGlow" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <clipPath id={headClipId}>
          <path d="M66 68c0-20 15-35 35-35h38c21 0 36 15 36 35v20c0 22-15 38-37 38h-35c-22 0-37-16-37-38V68Z" />
        </clipPath>
        <linearGradient id={scanId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--tm-accent)" stopOpacity="0" />
          <stop offset=".22" stopColor="var(--tm-accent-light)" stopOpacity=".2" />
          <stop offset=".5" stopColor="var(--tm-accent-light)" stopOpacity="1" />
          <stop offset=".78" stopColor="var(--tm-accent-light)" stopOpacity=".2" />
          <stop offset="1" stopColor="var(--tm-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>

      <g className="tm-stage">
        <ellipse className="tm-shadow" data-part="floor-shadow" cx="119" cy="202" rx="64" ry="11" fill={`url(#${shadowId})`} />

        <g className="tm-document" data-part="document" aria-hidden="true">
          <path className="tm-document-shadow" d="M165 91h27l18 18v66a7 7 0 0 1-7 7h-38a7 7 0 0 1-7-7V98a7 7 0 0 1 7-7Z" />
          <path className="tm-document-sheet" d="M162 86h28l18 18v68a7 7 0 0 1-7 7h-39a7 7 0 0 1-7-7V93a7 7 0 0 1 7-7Z" />
          <path className="tm-document-fold" d="M190 86v12a6 6 0 0 0 6 6h12" />
          <path className="tm-document-rule tm-document-rule--one" d="M166 119h29" />
          <path className="tm-document-rule tm-document-rule--two" d="M166 130h24" />
          <path className="tm-document-rule tm-document-rule--three" d="M166 141h27" />
          <path className="tm-document-rule tm-document-rule--four" d="M166 152h17" />

          <g className="tm-empty-mark">
            <circle cx="184" cy="132" r="13" />
            <path d="M179 132h10m-5-5v10" />
          </g>
          <g className="tm-copy-sheet">
            <path d="M171 97h28v43h-28z" />
            <path d="M176 107h18m-18 7h14m-14 7h16" />
          </g>
          <g className="tm-check-mark" data-part="success-check">
            <circle cx="194" cy="158" r="14" />
            <path d="m187 158 5 5 9-11" />
          </g>
          <g className="tm-alert-mark" data-part="warning-icon">
            <path className="tm-alert-shape" d="M194 142a15 15 0 1 0 0 30 15 15 0 0 0 0-30Z" />
            <path className="tm-alert-glyph" d="M194 149v9m0 5h.01" />
          </g>
          <g className="tm-error-mark" data-part="error-icon">
            <circle cx="194" cy="158" r="15" />
            <path d="m188 152 12 12m0-12-12 12" />
          </g>
          <g className="tm-file-alert-mark">
            <circle cx="194" cy="158" r="14" />
            <path d="m190 154 8 8m0-8-8 8" />
          </g>
          <g className="tm-network-mark">
            <circle cx="194" cy="158" r="14" />
            <path d="M188 154a9 9 0 0 1 12 0m-9 4a5 5 0 0 1 6 0m-3 4h.01m-8-12 16 16" />
          </g>
          <g className="tm-clear-mark">
            <circle cx="194" cy="158" r="14" />
            <path d="M189 153a7 7 0 0 1 12 3m0-4v4h-4m-1 7a7 7 0 0 1-12-3m0 4v-4h4" />
          </g>

          <g className="tm-scan-line" data-part="scan-line">
            <path className="tm-scan-halo" d="M158 122h49" />
            <path className="tm-scan-beam" stroke={`url(#${scanId})`} d="M158 122h49" />
            <path className="tm-scan-tick" d="M163 116v12m39-12v12" />
          </g>
        </g>

        <g className="tm-figure">
          <g className="tm-ear-pods" aria-hidden="true">
            <circle className="tm-ear-cushion" cx="68" cy="82" r="17" fill={`url(#${metalId})`} />
            <circle className="tm-ear-bezel" cx="68" cy="82" r="12.5" fill={`url(#${pearlId})`} />
            <circle className="tm-ear-ring" cx="68" cy="82" r="8.4" fill={`url(#${metalId})`} />
            <circle className="tm-ear-core" cx="68" cy="82" r="4.2" fill={`url(#${screenId})`} />
            <circle className="tm-ear-cushion" cx="172" cy="82" r="17" fill={`url(#${metalId})`} />
            <circle className="tm-ear-bezel" cx="172" cy="82" r="12.5" fill={`url(#${pearlId})`} />
            <circle className="tm-ear-ring" cx="172" cy="82" r="8.4" fill={`url(#${metalId})`} />
            <circle className="tm-ear-core" cx="172" cy="82" r="4.2" fill={`url(#${screenId})`} />
          </g>

          <g className="tm-antenna" data-part="antenna">
            <path className="tm-antenna-stem" d="M111 47v-9c0-5 4-9 9-9s9 4 9 9v9" />
            <circle className="tm-antenna-glow" cx="120" cy="28" r="10" filter={`url(#${glowId})`} />
            <circle className="tm-antenna-core" cx="120" cy="28" r="4.5" />
          </g>

          <path className="tm-neck" d="M111 108v10m18-10v10" />
          <g className="tm-head" data-part="head">
            <path className="tm-head-shell" fill={`url(#${pearlId})`} d="M66 68c0-20 15-35 35-35h38c21 0 36 15 36 35v20c0 22-15 38-37 38h-35c-22 0-37-16-37-38V68Z" />
            <path className="tm-head-gloss" clipPath={`url(#${headClipId})`} d="M64 32h112v96H64z" fill={`url(#${shineId})`} />
            <path className="tm-head-highlight" d="M82 54c10-11 22-16 39-16" />
            <path className="tm-head-crown-seam" d="M119 35c1 9 8 17 18 22" />
            <path className="tm-head-seam" d="M70 75v13m101-13v13" />
            <rect className="tm-visor" data-part="visor" x="69" y="61" width="103" height="46" rx="21" fill={`url(#${visorId})`} />
            <path className="tm-visor-glint" d="M81 70c5-4 11-5 19-5" />
            <g className="tm-eyes">
              <ellipse className="tm-eye-halo" cx="99" cy="83" rx="7.8" ry="9" filter={`url(#${glowId})`} />
              <ellipse className="tm-eye-halo" cx="143" cy="83" rx="7.8" ry="9" filter={`url(#${glowId})`} />
              <ellipse className="tm-eye tm-eye--left" data-part="eye-left" cx="99" cy="83" rx="3.2" ry="6.3" />
              <ellipse className="tm-eye tm-eye--right" data-part="eye-right" cx="143" cy="83" rx="3.2" ry="6.3" />
              <path className="tm-eye-thinking" d="M96 84h8m35 0h8" />
              <path className="tm-eye-closed" d="m94 84 9 3m35-3 9 3" />
            </g>
            <circle className="tm-face-signal" cx="120" cy="92" r="1.4" filter={`url(#${glowId})`} />
          </g>

          <path className="tm-shoulder-joint" stroke={`url(#${metalId})`} d="M86 131c4-6 10-9 17-9h34c7 0 13 3 17 9" />
          <path className="tm-torso-shell" data-part="torso" fill={`url(#${pearlId})`} d="M89 126c4-4 9-6 15-6h32c6 0 11 2 15 6l7 9v35c0 8-6 14-14 14H96c-8 0-14-6-14-14v-35l7-9Z" />
          <path className="tm-torso-gloss" fill={`url(#${shineId})`} d="M91 132c5-7 11-9 19-9h24c9 0 15 3 20 10v31c-16 10-46 12-68 1v-33Z" />
          <path className="tm-torso-highlight" d="M95 128c3-2 6-3 10-3" />
          <path className="tm-torso-rim" d="M91 177c15 8 42 9 59 0" />
          <rect className="tm-chest-bezel" fill={`url(#${metalId})`} x="96" y="134" width="48" height="30" rx="9" />
          <rect className="tm-screen" data-part="chest-display" fill={`url(#${screenId})`} x="99" y="137" width="42" height="24" rx="7" />
          <path className="tm-screen-gloss" d="M104 140h30c2 0 3 1 3 3v1h-35v-1c0-2 1-3 2-3Z" />
          <path className="tm-screen-line" d="M107 146h25m-25 6h17" />
          <circle className="tm-screen-dot" cx="135" cy="154" r="1.6" filter={`url(#${glowId})`} />
          <circle className="tm-torso-light" cx="119" cy="171" r="2" />

          <g className="tm-shoulder-caps" aria-hidden="true">
            <circle className="tm-joint-gasket" cx="89" cy="139" r="10" fill={`url(#${metalId})`} />
            <circle className="tm-joint-cap" cx="89" cy="139" r="7" fill={`url(#${pearlId})`} />
            <circle className="tm-joint-gasket" cx="151" cy="139" r="10" fill={`url(#${metalId})`} />
            <circle className="tm-joint-cap" cx="151" cy="139" r="7" fill={`url(#${pearlId})`} />
          </g>

          <g className="tm-arm tm-arm--left">
            <path className="tm-arm-shell tm-arm-shell--upper" data-part="arm-left-upper" fill={`url(#${pearlId})`} d="M87 137c-8-3-15 0-19 7l-5 8c4 3 9 5 14 4l10-14Z" />
            <path className="tm-arm-shell tm-arm-shell--lower" data-part="arm-left-lower" fill={`url(#${pearlId})`} d="m63 150-6 10c-3 5-1 11 4 14 5 3 11 1 14-4l6-10c-4-2-9-5-14-10Z" />
            <path className="tm-arm-highlight" d="m68 151-8 13" />
            <path className="tm-hand-finger" d="M53 170c-2 2-2 5 0 7m6-8v7m5-8c2 2 2 5 0 7" />
            <circle className="tm-hand" data-part="hand-left" fill={`url(#${pearlId})`} cx="57" cy="174" r="6" />
          </g>
          <g className="tm-arm tm-arm--right">
            <path className="tm-arm-shell tm-arm-shell--upper" data-part="arm-right-upper" fill={`url(#${pearlId})`} d="M153 137c8-3 15-1 20 5l6 8c-3 5-7 9-12 10l-14-14Z" />
            <path className="tm-arm-shell tm-arm-shell--lower" data-part="arm-right-lower" fill={`url(#${pearlId})`} d="m173 148 10 10c4 5 3 11-2 15-4 4-11 3-15-2l-9-11c5-2 10-6 16-12Z" />
            <path className="tm-arm-highlight" d="m167 146 8 10" />
            <path className="tm-hand-finger" d="M176 164c-2 2-2 5 0 7m6-8v7m5-7c2 2 2 5 0 7" />
            <circle className="tm-hand" data-part="hand-right" fill={`url(#${pearlId})`} cx="180" cy="168" r="6" />
          </g>

          <g className="tm-legs">
            <path className="tm-leg tm-leg--upper" data-part="leg-left-upper" stroke={`url(#${metalId})`} d="M101 182v5" />
            <path className="tm-leg tm-leg--lower" data-part="leg-left-lower" stroke={`url(#${metalId})`} d="M101 187v6" />
            <path className="tm-leg tm-leg--upper" data-part="leg-right-upper" stroke={`url(#${metalId})`} d="M138 182v5" />
            <path className="tm-leg tm-leg--lower" data-part="leg-right-lower" stroke={`url(#${metalId})`} d="M138 187v6" />
            <circle className="tm-knee-joint" cx="101" cy="185" r="4.2" fill={`url(#${metalId})`} />
            <circle className="tm-knee-joint" cx="138" cy="185" r="4.2" fill={`url(#${metalId})`} />
            <path className="tm-leg-highlight" d="M99 187v5m37-5v5" />
            <path className="tm-foot-sole" d="M87 199h27m12 0h27" />
            <path className="tm-foot" data-part="foot-left" fill={`url(#${pearlId})`} d="M91 191h18c4 0 7 3 7 7v3H84v-2c0-4 3-8 7-8Z" />
            <path className="tm-foot" data-part="foot-right" fill={`url(#${pearlId})`} d="M128 191h18c4 0 7 3 7 7v3h-32v-2c0-4 3-8 7-8Z" />
            <path className="tm-foot-detail" d="M94 195h8m34 0h8" />
          </g>

          <g className="tm-ready-gesture">
            <path fill={`url(#${pearlId})`} d="M153 137c9-5 18-2 20 5l4 12c2 5-1 10-6 11-5 1-9-1-10-6l-3-8" />
            <circle fill={`url(#${pearlId})`} cx="176" cy="151" r="6" />
            <path className="tm-gesture-spark" d="M187 133v-7m-3.5 3.5h7" />
          </g>
          <g className="tm-reading-gesture">
            <path fill={`url(#${pearlId})`} d="M87 139c-7 0-12 5-12 12v8c0 5 4 9 9 9s8-4 8-9v-9" />
            <circle fill={`url(#${pearlId})`} cx="84" cy="166" r="5.5" />
          </g>
          <g className="tm-result-reveal-gesture">
            <path fill={`url(#${pearlId})`} d="M153 139c7-3 14 0 17 6l7 15c2 5 0 10-5 12-5 2-10 0-12-5l-7-14" />
            <circle fill={`url(#${pearlId})`} cx="173" cy="171" r="6" />
          </g>
        </g>

        <g className="tm-particles" data-part="data-particles" aria-hidden="true">
          <circle className="tm-particle tm-particle--one" cx="53" cy="91" r="2" />
          <circle className="tm-particle tm-particle--two" cx="190" cy="63" r="1.5" />
          <path className="tm-particle-star" data-part="sparkles" d="M48 115v8m-4-4h8m147-31v6m-3-3h6" />
        </g>
      </g>
    </svg>
  )
}
