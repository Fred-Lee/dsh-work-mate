/**
 * Runtime style injection for the EMBEDDED dashboard view. When the dashboard
 * runs standalone its stylesheet comes from index.html <link>; when imported
 * as a library (workbench panel), nobody loads that file, so we inject it once
 * with the same data-plugin tagging the DSH shell uses for HMR bookkeeping.
 */
// @ts-expect-error esbuild text-loader virtual module (declared below)
import cssText from './styles.css?inline'

const TAG_ID = '@helmsman/ui-dashboard/styles.css'

export function injectDashboardStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${TAG_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@helmsman/ui-dashboard'
  tag.dataset.pluginCss = TAG_ID
  tag.textContent = cssText
  document.head.appendChild(tag)
}
