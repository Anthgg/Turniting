import type { ReactNode } from 'react'
import { TurnitingMascot, type MascotState } from './TurnitingMascot'
import './TurnitingFeedback.css'

export interface TurnitingFeedbackProps {
  state: MascotState
  title?: string
  description?: string
  children?: ReactNode
  className?: string
  layout?: 'inline' | 'panel'
  size?: 'compact' | 'standard' | 'large'
}

const ALERT_STATES = new Set<MascotState>(['error', 'network-error', 'file-error'])
const BUSY_STATES = new Set<MascotState>(['stand-up', 'reading', 'analyzing', 'running', 'thinking'])

export function TurnitingFeedback({
  state,
  title,
  description,
  children,
  className,
  layout = 'panel',
  size = layout === 'panel' ? 'standard' : 'compact',
}: TurnitingFeedbackProps) {
  const isAlert = ALERT_STATES.has(state)
  const classes = ['turniting-feedback', `turniting-feedback--${layout}`, `turniting-feedback--${state}`, className]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={classes}
      role={isAlert ? 'alert' : 'status'}
      aria-live={isAlert ? 'assertive' : 'polite'}
      aria-atomic="true"
      aria-busy={BUSY_STATES.has(state) || undefined}
    >
      <TurnitingMascot state={state} size={size} className="turniting-feedback__mascot" />
      <div className="turniting-feedback__content">
        {title && <strong className="turniting-feedback__title">{title}</strong>}
        {description && <p className="turniting-feedback__description">{description}</p>}
        {children && <div className="turniting-feedback__actions">{children}</div>}
      </div>
    </div>
  )
}
