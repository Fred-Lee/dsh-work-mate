/**
 * Left-rail glyph for the WorkMate workbench panel.
 *
 * The sidebar hands every panel row a `{ size, active }` share; this is the
 * workbench (a board seen from the side) rather than a chat bubble, so the rail
 * reads as "workbench first, chat second".
 */
import type { PanelIconProps } from './slot-types'

export function WorkmatePanelIcon({ size, active }: PanelIconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={active ? 2 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
      <path d="M9 9v11" />
      <path d="M12.5 13h5" />
      <path d="M12.5 16.5h3" />
    </svg>
  )
}
