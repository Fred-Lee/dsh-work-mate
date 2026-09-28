/** Injected once per document (both SPA and better-sidebar tab use it). */
export const PANEL_STYLE = `
.wm-root { font-family: -apple-system, "PingFang SC", "Segoe UI", sans-serif; font-size: 13px; color: var(--wm-fg, #1f2328); padding: 12px; }
.wm-header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
.wm-header h2 { font-size: 15px; margin: 0; }
.wm-header .wm-count { color: var(--wm-muted, #8b949e); font-size: 12px; }
.wm-card { border: 1px solid var(--wm-border, #d0d7de); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; background: var(--wm-card, #ffffff); }
.wm-card .wm-title-row { display: flex; align-items: center; gap: 8px; }
.wm-card .wm-title { font-weight: 600; }
.wm-card .wm-id { font-family: ui-monospace, monospace; font-size: 12px; color: var(--wm-muted, #8b949e); }
.wm-badge { font-size: 11px; border-radius: 999px; padding: 1px 8px; border: 1px solid transparent; }
.wm-badge.draft { color: #57606a; background: #eaeef2; }
.wm-badge.executing { color: #0969da; background: #ddf4ff; border-color: #54aeff66; }
.wm-badge.archived { color: #1a7f37; background: #dafbe1; }
.wm-meta { color: var(--wm-muted, #8b949e); font-size: 12px; margin-top: 4px; }
.wm-detail { border-top: 1px dashed var(--wm-border, #d0d7de); margin-top: 8px; padding-top: 8px; font-size: 12px; }
.wm-detail .wm-section { margin-bottom: 6px; }
.wm-detail code { font-family: ui-monospace, monospace; background: var(--wm-code, #f6f8fa); padding: 0 4px; border-radius: 4px; }
.wm-actions { margin-top: 8px; display: flex; gap: 6px; }
.wm-btn { font-size: 12px; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--wm-border, #d0d7de); background: var(--wm-card, #fff); cursor: pointer; }
.wm-btn.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
.wm-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.wm-form { border: 1px solid var(--wm-border, #d0d7de); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; display: grid; gap: 6px; }
.wm-form label { font-size: 12px; color: var(--wm-muted, #57606a); }
.wm-form input { font-size: 13px; padding: 4px 8px; border: 1px solid var(--wm-border, #d0d7de); border-radius: 6px; }
.wm-error { color: #cf222e; font-size: 12px; margin: 6px 0; }
.wm-empty { color: var(--wm-muted, #8b949e); padding: 16px 0; text-align: center; }
.wm-progress { font-size: 12px; color: #0969da; }
`
