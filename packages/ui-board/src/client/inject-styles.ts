/**
 * Runtime style injection for the EMBEDDED board view. When the board runs
 * standalone its stylesheet comes from index.html <link>; when imported as a
 * library (workbench panel / DSH overlay), nobody loads that file, so we inject
 * it once with the same data-plugin tagging the DSH shell uses for HMR
 * bookkeeping (mirrors ui-dashboard/src/client/inject-styles.ts).
 */
// esbuild resolves the file and applies its text loader for the embedded view
// (type side is covered by ./css-inline.d.ts, same as ui-dashboard).
import cssText from './styles.css?inline'

const TAG_ID = '@helmsman/ui-board/styles.css'

export function injectBoardStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${TAG_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@helmsman/ui-board'
  tag.dataset.pluginCss = TAG_ID
  tag.textContent = cssText
  document.head.appendChild(tag)
}
