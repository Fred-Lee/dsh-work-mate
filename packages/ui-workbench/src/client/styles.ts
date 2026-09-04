/**
 * Injects the workbench drawer stylesheet once per document, tagged like DSH
 * plugin CSS (`data-plugin`) so HMR bookkeeping can claim it. Uses DSH theme
 * variables (`--dsw-*`) with fallbacks, so the drawer follows light/dark.
 */
const CSS = `
.hls-drawer{position:fixed;top:0;right:0;bottom:0;width:480px;max-width:92vw;background:var(--dsw-specific-sidebar-fill,#fff);color:var(--dsw-alias-label-primary,#16191e);border-left:1px solid var(--dsw-alias-border-l3,#e5e7eb);box-shadow:-12px 0 32px rgba(0,0,0,.14);display:flex;flex-direction:column;pointer-events:auto;z-index:20;font-size:14px;line-height:1.5}
.hls-drawer-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l3,#e5e7eb);flex:none}
.hls-drawer-title{font-weight:600;font-size:14px;flex:1;margin:0}
.hls-close{border:none;background:transparent;cursor:pointer;color:inherit;font-size:15px;padding:4px 9px;border-radius:8px}
.hls-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.hls-tabs{display:flex;gap:4px;padding:8px 10px 0;flex:none}
.hls-tab{flex:1;text-align:center;padding:6px 4px;font-size:13px;border:none;background:transparent;color:inherit;opacity:.65;cursor:pointer;border-bottom:2px solid transparent}
.hls-tab.is-active{opacity:1;font-weight:600;border-bottom-color:var(--dsw-alias-label-primary,#16191e)}
.hls-body{flex:1;overflow-y:auto;padding:12px 14px 16px;position:relative}
.hls-panel h3{margin:4px 0 10px;font-size:14px}
.hls-panel textarea{width:100%;box-sizing:border-box;resize:vertical;min-height:72px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3,#d1d5db);background:transparent;color:inherit;font:inherit;margin:0 0 4px}
.hls-panel textarea:focus{outline:none;border-color:var(--dsw-alias-label-primary,#16191e)}
.hls-actions{margin:8px 0 14px;display:flex;gap:8px;align-items:center}
.hls-btn{padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3,#d1d5db);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));color:inherit;cursor:pointer;font-size:13px}
.hls-btn:disabled{opacity:.5;cursor:not-allowed}
.hls-link{font-size:12px;color:inherit;opacity:.7}
.hls-records{list-style:none;margin:0;padding:0}
.hls-records li{padding:5px 0;border-bottom:1px dashed var(--dsw-alias-border-l3,#eceef1);font-size:13px}
.hls-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.hls-dot[data-status="completed"]{background:#16a34a}
.hls-dot[data-status="running"]{background:#d97706}
.hls-dot[data-status="failed"]{background:#dc2626}
.hls-empty{opacity:.6;font-size:13px}
.hls-toast{position:absolute;left:14px;right:14px;bottom:12px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.07));font-size:13px}
.hls-toggle-btn{display:flex;align-items:center;gap:6px;width:100%;padding:8px 10px;border:none;background:transparent;color:inherit;cursor:pointer;border-radius:8px;font-size:13px;text-align:left}
.hls-toggle-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
`

const TAG_ID = '@helmsman/ui-workbench/workbench.css'

export function injectStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${TAG_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@helmsman/ui-workbench'
  tag.dataset.pluginCss = TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}
