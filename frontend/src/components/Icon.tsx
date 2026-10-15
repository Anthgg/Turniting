import type { ReactNode } from 'react'

export type IconName =
  | 'arrow-right'
  | 'brain'
  | 'check'
  | 'chevron-right'
  | 'chevrons'
  | 'clock'
  | 'database'
  | 'file'
  | 'file-plus'
  | 'grid'
  | 'refresh'
  | 'server'
  | 'shield-check'
  | 'spark'
  | 'upload'

const iconContent: Record<IconName, ReactNode> = {
  'arrow-right': <><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></>,
  brain: <><path d="M12 18V5" /><path d="M15.5 6.5a3 3 0 0 1 2.4 4.8 3.5 3.5 0 0 1-1 6.7H15" /><path d="M8.5 6.5a3 3 0 0 0-2.4 4.8 3.5 3.5 0 0 0 1 6.7H9" /><path d="M9 4a3 3 0 0 1 6 0v14a3 3 0 0 1-6 0" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  'chevron-right': <path d="m9 18 6-6-6-6" />,
  chevrons: <><path d="m7 15 5-5 5 5" /><path d="m7 9 5-5 5 5" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h8" /></>,
  'file-plus': <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h8" /><path d="M14 2v6h6M8 13h7" /><path d="M19 16v6M16 19h6" /></>,
  grid: <><rect x="3" y="3" width="8" height="8" rx="2" /><rect x="13" y="3" width="8" height="5" rx="2" /><rect x="13" y="10" width="8" height="11" rx="2" /><rect x="3" y="13" width="8" height="8" rx="2" /></>,
  refresh: <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2" /></>,
  server: <><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6" /></>,
  'shield-check': <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11" /><path d="m9 12 2 2 4-4" /></>,
  spark: <><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3Z" /><path d="m19 14 1.2 2.8L23 18l-2.8 1.2L19 22l-1.2-2.8L15 18l2.8-1.2L19 14Z" /></>,
  upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5M12 3v12" /></>,
}

interface IconProps {
  name: IconName
  size?: number
  className?: string
}

export function Icon({ name, size = 18, className }: IconProps) {
  return (
    <svg
      className={className}
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {iconContent[name]}
    </svg>
  )
}
