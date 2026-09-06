/**
 * Runtime style injection for the EMBEDDED diff view (same pattern as
 * ui-dashboard's inject-styles). Idempotent; standalone mounts load the file
 * via index.html <link> and never import this module.
 */
// @ts-expect-error esbuild text-loader virtual module (declared below)
import cssText from './styles.css?inline'

const TAG_ID = '@helmsman/ui-diff/styles.css'

export function injectDiffStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${TAG_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@helmsman/ui-diff'
  tag.dataset.pluginCss = TAG_ID
  tag.textContent = cssText
  document.head.appendChild(tag)
}
