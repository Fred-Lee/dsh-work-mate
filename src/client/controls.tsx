/**
 * Local controls for the WorkMate panel.
 *
 * Why not ui-primitives here: the plugin client bundle ships a single JS entry,
 * while the primitives' CSS modules live in separate hashed stylesheets that the
 * host does not load for plugin bundles. Using them rendered plain DOM in the
 * real shell (the import dialog became an inline page). These local controls use
 * the panel's inline stylesheet, so the panel looks the same in the standalone
 * route and inside the host.
 */
import { useEffect } from 'react'
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react'

type ButtonVariant = 'primary' | 'outline' | 'ghost'

export function Btn(
  props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; className?: string },
): JSX.Element {
  const { variant = 'outline', size = 'md', className = '', type = 'button', ...rest } = props
  const classes = ['wm-btn', size === 'sm' ? 'mini' : '', variant === 'primary' ? 'primary' : variant === 'ghost' ? 'subtle' : '', className]
    .filter(Boolean)
    .join(' ')
  return <button className={classes} type={type} {...rest} />
}

export function Segmented(props: {
  id?: string
  value: string
  label: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <div className="wm-seg" id={props.id} role="tablist" aria-label={props.label}>
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={props.value === option.value}
          className={props.value === option.value ? 'active' : ''}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Tag(props: { tone?: 'success' | 'info' | 'warning' | 'danger' | 'outline'; children: ReactNode }): JSX.Element {
  return <span className={`wm-tag wm-tag-${props.tone ?? 'outline'}`}>{props.children}</span>
}

export function StateDot(props: { state?: string }): JSX.Element {
  return <i className={`wm-state-dot wm-state-${props.state ?? 'idle'}`} aria-hidden />
}

export function PathLabel(props: { path: string; className?: string; style?: CSSProperties }): JSX.Element {
  const path = props.path.length > 56 ? `${props.path.slice(0, 30)}…${props.path.slice(-20)}` : props.path
  return (
    <span className={`wm-path ${props.className ?? ''}`} style={props.style} title={props.path}>
      {path}
    </span>
  )
}

export function Tooltip(props: { label: string; children: ReactNode; side?: string }): JSX.Element {
  return <span className="wm-tip" title={props.label}>{props.children}</span>
}

export function Pill(props: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }): JSX.Element {
  const { active = false, className = '', type = 'button', ...rest } = props
  // aria-pressed 让读屏器知道这是开关而不是普通按钮（polish-workbench-delivery T11）。
  return <button className={`wm-pill${active ? ' active' : ''} ${className}`.trim()} type={type} aria-pressed={active} {...rest} />
}

export function DisclosureRow(props: { icon?: string; title: string; open?: boolean; expandable?: boolean; onToggle: () => void }): JSX.Element {
  return (
    <button className="wm-disclosure" type="button" onClick={props.onToggle}>
      <span className="wm-disclosure-icon">{props.open ? '▾' : props.icon ?? '▸'}</span>
      {props.title}
    </button>
  )
}

export function Modal(props: {
  open: boolean
  onClose: () => void
  title: string
  closeLabel?: string
  footer?: ReactNode
  children?: ReactNode
}): JSX.Element | null {
  useEffect(() => {
    if (!props.open) return
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [props.open, props.onClose])

  if (!props.open) return null
  return (
    <div className="wm-modal" role="presentation" onMouseDown={props.onClose}>
      <div
        className="wm-modal-box"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="wm-modal-head">
          <h3>{props.title}</h3>
          <button className="wm-btn mini" type="button" aria-label={props.closeLabel ?? '关闭'} onClick={props.onClose}>
            ✕
          </button>
        </header>
        <div className="wm-modal-body">{props.children}</div>
        {props.footer !== undefined && <footer className="wm-modal-foot">{props.footer}</footer>}
      </div>
    </div>
  )
}
