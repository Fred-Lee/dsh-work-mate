/**
 * WorkMate panel design system.
 *
 * Color tokens prefer the host's `--dsw-alias-*` theme variables (verified in
 * Codingns4DSH against DSH 0.1.6/0.1.7), so inside the shell the panel follows
 * the host's light/dark theme; the `--wm-*-fallback` tier only matters on the
 * standalone page, where it tracks prefers-color-scheme.
 */
export const PANEL_STYLE = `
.wm-root {
  --wm-fg: var(--dsw-alias-label-primary, var(--wm-fg-fallback));
  --wm-muted: var(--dsw-alias-label-secondary, var(--wm-muted-fallback));
  --wm-bg: var(--dsw-alias-bg-primary, var(--wm-bg-fallback));
  --wm-card: var(--dsw-alias-bg-secondary, var(--wm-card-fallback));
  --wm-surface: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-secondary, var(--wm-card-fallback)));
  --wm-border: var(--dsw-alias-border-l2, var(--wm-border-fallback));
  --wm-border-soft: var(--dsw-alias-border-l1, var(--wm-border-soft-fallback));
  --wm-accent: var(--dsw-alias-button-info-fill, var(--wm-accent-fallback));
  --wm-accent-soft: var(--dsw-alias-bg-secondary, var(--wm-accent-soft-fallback));
  --wm-code: var(--dsw-alias-bg-secondary, var(--wm-code-fallback));
  --wm-shadow: var(--dsw-elevation-l1, 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.08));
  --wm-shadow-lift: var(--dsw-elevation-prominent, 0 8px 24px rgba(16,24,40,.12));

  --wm-bg-fallback: #f6f8fa;
  --wm-card-fallback: #ffffff;
  --wm-border-fallback: #d8dee4;
  --wm-border-soft-fallback: #e7ebef;
  --wm-fg-fallback: #1f2328;
  --wm-muted-fallback: #656d76;
  --wm-accent-fallback: #4f46e5;
  --wm-accent-soft-fallback: #eef2ff;
  --wm-code-fallback: #f0f2f5;

  font-family: -apple-system, "PingFang SC", "Segoe UI", sans-serif;
  font-size: 13px;
  color: var(--wm-fg);
  background: var(--wm-bg);

  /* Height contract for the host "main" slot: the central column is a
     definite-height flex container with overflow hidden (host
     AppFrame.module.css .centerCol), so a plain block root gets its overflow
     silently clipped by the ancestor — content present, unreachable, without
     any scrollbar. Fill the column (flex, height 100%) and delegate
     scrolling to .wm-body below (fix-panel-scroll, design D1/D2). */
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* The single vertical scroll layer (fix-panel-scroll D1). min-height: 0 is
   what lets a flex child shrink below its content height — without it the
   default auto refuses to shrink and overflow never engages. On the
   standalone page there are no CSS ancestors, so height: 100% degrades to
   auto, this layer simply grows, and the document keeps scrolling (C5). */
.wm-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-bottom: 24px;
}

/* Modal exit as a fixed scope root: when the panel opens a modal from inside
   a host slot, this element is the CSS-variable scope AND the full-viewport
   overlay, above every shell chrome (buttons at z-index stay clickable after
   close because the whole layer unmounts). */
.wm-root.wm-modal-fixed {
  position: fixed; inset: 0; z-index: 9999;
  background: transparent; padding: 0;
}
@media (prefers-color-scheme: dark) {
  .wm-root {
    --wm-bg-fallback: #0d1117;
    --wm-card-fallback: #161b22;
    --wm-border-fallback: #30363d;
    --wm-border-soft-fallback: #21262d;
    --wm-fg-fallback: #e6edf3;
    --wm-muted-fallback: #8b949e;
    --wm-accent-fallback: #818cf8;
    --wm-accent-soft-fallback: #1c2033;
    --wm-code-fallback: #21262d;
  }
}

/* ---------- header ---------- */
.wm-header {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 18px 12px;
  background: linear-gradient(135deg, var(--wm-accent-soft), transparent 70%);
  border-bottom: 1px solid var(--wm-border-soft);
  /* No position:sticky here: inside the host's overflow:hidden right-rail it
     pins to the rail top and covers the shell's layout buttons. */
}
.wm-brand { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 700; letter-spacing: .2px; }
.wm-logo {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border-radius: 8px; font-size: 14px;
  background: linear-gradient(135deg, #6366f1, #22d3ee);
  box-shadow: var(--wm-shadow);
}
.wm-count { color: var(--wm-muted); font-size: 12px; font-weight: 400; }
.wm-toolbar { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.wm-pills { display: inline-flex; background: var(--wm-code); border-radius: 999px; padding: 3px; }
.wm-pill {
  border: 0; background: transparent; color: var(--wm-muted); cursor: pointer;
  font-size: 12px; padding: 4px 12px; border-radius: 999px;
}
.wm-pill.active { background: var(--wm-card); color: var(--wm-fg); box-shadow: var(--wm-shadow); font-weight: 600; }

/* ---------- buttons ---------- */
.wm-btn {
  font-size: 12px; padding: 5px 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--wm-border); background: var(--wm-surface); color: var(--wm-fg);
  transition: box-shadow .15s ease, transform .05s ease;
}
.wm-btn:hover { box-shadow: var(--wm-shadow); }
.wm-btn:active { transform: translateY(1px); }
.wm-btn.primary { background: var(--wm-accent); border-color: var(--wm-accent); color: #fff; font-weight: 600; }
.wm-btn.primary:hover { filter: brightness(1.08); }
.wm-btn.subtle { border-color: transparent; background: transparent; color: var(--wm-muted); }
.wm-btn.subtle:hover { background: var(--wm-code); box-shadow: none; }
.wm-btn:disabled { opacity: .45; cursor: not-allowed; box-shadow: none; }
.wm-btn.mini { font-size: 11px; padding: 2px 8px; border-radius: 6px; }

/* ---------- kanban ---------- */
.wm-board { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; padding: 14px 18px 0; align-items: start; }
@media (max-width: 1200px) { .wm-board { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 900px) { .wm-board { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px) { .wm-board { grid-template-columns: 1fr; } }
.wm-col { background: var(--wm-code); border-radius: 12px; padding: 8px; }
.wm-col-head { display: flex; align-items: center; gap: 6px; padding: 4px 6px 8px; font-weight: 600; font-size: 12px; color: var(--wm-muted); }
.wm-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.wm-col-count {
  margin-left: auto; font-size: 11px; min-width: 20px; text-align: center;
  background: var(--wm-card); border-radius: 999px; padding: 1px 6px; color: var(--wm-muted);
}
.wm-col-body { display: flex; flex-direction: column; gap: 8px; min-height: 60px; }
.wm-col-empty { color: var(--wm-muted); font-size: 12px; text-align: center; padding: 18px 0; opacity: .7; }

/* ---------- card ---------- */
.wm-card {
  position: relative; overflow: hidden;
  background: var(--wm-card); border: 1px solid var(--wm-border); border-radius: 10px;
  padding: 10px 12px 10px 16px; cursor: pointer;
  box-shadow: var(--wm-shadow);
  transition: box-shadow .15s ease, transform .15s ease;
}
.wm-card:hover { box-shadow: var(--wm-shadow-lift); transform: translateY(-1px); }
.wm-card-bar { position: absolute; left: 0; top: 0; bottom: 0; width: 4px; }
.wm-card-title { margin: 0; font-size: 13px; font-weight: 600; line-height: 1.35; }
.wm-card-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--wm-muted); margin-top: 2px; }
.wm-meta { color: var(--wm-muted); font-size: 11px; margin-top: 6px; display: flex; gap: 8px; align-items: center; }
.wm-progress-track { margin-top: 8px; height: 6px; border-radius: 999px; background: var(--wm-code); overflow: hidden; }
.wm-progress-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #6366f1, #22d3ee); transition: width .3s ease; }
.wm-progress-label { font-size: 10px; color: var(--wm-muted); margin-top: 3px; }

.wm-detail { border-top: 1px dashed var(--wm-border); margin-top: 10px; padding-top: 8px; font-size: 12px; cursor: default; }
.wm-detail .wm-section { margin-bottom: 8px; }
.wm-detail .wm-section > b { display: block; font-size: 11px; color: var(--wm-muted); font-weight: 600; margin-bottom: 3px; }
.wm-detail code { font-family: ui-monospace, monospace; background: var(--wm-code); padding: 1px 5px; border-radius: 5px; font-size: 11px; }
.wm-detail ul { margin: 4px 0 0; padding-left: 16px; }
.wm-detail li { margin: 2px 0; }

.wm-action-note {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.4;
  opacity: 0.85;
}
.wm-action-note.error {
  color: #e5534b;
  opacity: 1;
}
.wm-actions { display: flex; gap: 6px; flex-wrap: wrap; }

/* ---------- modal ---------- */
.wm-modal {
  position: fixed; inset: 0; z-index: 50;
  background: var(--dsw-alias-bg-mask-1, rgba(8, 12, 20, .45));
  display: flex; align-items: flex-start; justify-content: center; padding-top: 12vh;
}
.wm-modal-box {
  width: min(420px, calc(100vw - 32px));
  background: var(--wm-surface); color: var(--wm-fg);
  border: 1px solid var(--wm-border); border-radius: 14px;
  box-shadow: var(--wm-shadow-lift);
  padding: 18px;
}
.wm-modal-box h3 { margin: 0 0 12px; font-size: 14px; }
.wm-field { display: grid; gap: 4px; margin-bottom: 10px; }
.wm-field label { font-size: 11px; color: var(--wm-muted); font-weight: 600; }
.wm-field input {
  font-size: 13px; padding: 7px 10px; border-radius: 8px;
  border: 1px solid var(--wm-border); background: var(--wm-bg); color: var(--wm-fg);
  outline: none;
}
.wm-field input:focus { border-color: var(--wm-accent); box-shadow: 0 0 0 3px var(--wm-accent-soft); }
.wm-modal-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
.wm-ok-note { background: var(--wm-accent-soft); border: 1px solid var(--wm-border); border-radius: 10px; padding: 10px 12px; margin-top: 8px; font-size: 12px; }
.wm-ok-note a, .wm-link { color: var(--wm-accent); font-weight: 600; text-decoration: none; cursor: pointer; }
.wm-ok-note a:hover, .wm-link:hover { text-decoration: underline; }

.wm-error { color: #ef4444; font-size: 12px; margin: 8px 18px; }
.wm-empty { color: var(--wm-muted); padding: 48px 0; text-align: center; font-size: 13px; }

/* ---------- graph ---------- */
.wm-graph { position: relative; padding: 34px 18px 6px; }
.wm-graph svg { display: block; }
.wm-graph-col-label { position: absolute; top: 14px; font-size: 11px; color: var(--wm-muted); font-weight: 600; }

/* ---------- control room (workbench panel) ---------- */
.wm-console { padding: 12px 16px 24px; display: flex; flex-direction: column; gap: 14px; }
.wm-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
.wm-kpi {
  border: 1px solid var(--wm-border, rgba(127,127,127,.25)); border-radius: 10px;
  padding: 10px 12px; background: var(--wm-bg-soft, rgba(127,127,127,.06));
}
.wm-kpi-value { font-size: 20px; font-weight: 700; line-height: 1.2; }
.wm-kpi-label { font-size: 11px; color: var(--wm-muted); margin-top: 2px; }
.wm-kpi-note { font-size: 10px; color: var(--wm-muted); margin-top: 4px; }
.wm-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.wm-table th {
  text-align: left; font-weight: 600; color: var(--wm-muted); font-size: 11px;
  padding: 6px 8px; border-bottom: 1px solid var(--wm-border, rgba(127,127,127,.25));
}
.wm-table td { padding: 6px 8px; border-bottom: 1px solid var(--wm-border-soft, rgba(127,127,127,.12)); }
.wm-table tr:last-child td { border-bottom: none; }
.wm-num { text-align: right; font-variant-numeric: tabular-nums; }
.wm-tier {
  display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 600;
  border: 1px solid transparent;
}
.wm-tier-normal { background: rgba(63,185,80,.14); color: #2da44e; }
.wm-tier-log { background: rgba(127,127,127,.16); color: var(--wm-muted); }
.wm-tier-diagnose { background: rgba(210,153,34,.16); color: #bf8700; }
.wm-tier-propose { background: rgba(248,81,73,.16); color: #cf222e; }
.wm-tier-unknown { background: rgba(127,127,127,.1); color: var(--wm-muted); font-weight: 500; }

/* ---------- chat entry (assistant action row / input tools) ---------- */
.wm-chat-trigger {
  font-size: 12px; padding: 2px 8px; border-radius: 6px; cursor: pointer;
  border: 1px solid transparent; background: transparent; color: var(--wm-muted-fallback, #656d76);
}
.wm-chat-trigger:hover { background: var(--wm-code, rgba(127,127,127,.12)); color: var(--wm-fg, inherit); }
/* ---------- project context bar (multiproject workbench) ---------- */
.wm-context {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  padding: 8px 18px;
  border-bottom: 1px solid var(--wm-border-soft);
  background: var(--wm-surface);
}
.wm-context-field {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11px; color: var(--wm-muted);
}
.wm-context-field select {
  font-size: 12px; padding: 4px 8px; border-radius: 8px;
  border: 1px solid var(--wm-border); background: var(--wm-bg); color: var(--wm-fg);
}
.wm-context-meta { font-size: 11px; color: var(--wm-muted); }
.wm-import-list { display: flex; flex-direction: column; gap: 8px; max-height: 50vh; overflow-y: auto; margin: 8px 0; }
.wm-import-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 8px 10px; border: 1px solid var(--wm-border-soft); border-radius: 10px;
}
.wm-import-path {
  font-family: ui-monospace, monospace; font-size: 11px; color: var(--wm-muted);
  word-break: break-all; margin-top: 2px;
}

.wm-search {
  flex: 1 1 160px; min-width: 120px; max-width: 260px;
  font-size: 12px; padding: 4px 8px; border-radius: 8px;
  border: 1px solid var(--wm-border); background: var(--wm-bg); color: var(--wm-fg);
}
.wm-col-empty .wm-btn { margin-left: 6px; }

/* ---------- list view + detail drawer ---------- */
.wm-list { display: flex; flex-direction: column; gap: 6px; padding: 12px 18px 0; }
.wm-list-row {
  display: flex; align-items: center; justify-content: space-between; gap: 14px;
  width: 100%; text-align: left; cursor: pointer;
  padding: 10px 12px; border: 1px solid var(--wm-border); border-radius: 10px;
  background: var(--wm-card); color: var(--wm-fg);
  box-shadow: var(--wm-shadow);
}
.wm-list-row:hover { box-shadow: var(--wm-shadow-lift); transform: translateY(-1px); }
.wm-list-title { margin: 0; font-size: 13px; font-weight: 600; line-height: 1.35; }
.wm-drawer-mask {
  position: fixed; inset: 0; z-index: 60;
  background: var(--dsw-alias-bg-mask-1, rgba(8, 12, 20, .45));
  display: flex; justify-content: flex-end;
}
.wm-drawer {
  width: min(480px, 100vw); height: 100%;
  background: var(--wm-surface); color: var(--wm-fg);
  border-left: 1px solid var(--wm-border);
  padding: 16px; overflow-y: auto;
  display: flex; flex-direction: column; gap: 10px;
}
.wm-drawer-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.wm-drawer-head h3 { margin: 0; font-size: 15px; }

/* ---------- team console ---------- */
.wm-team { padding: 14px 18px 0; display: flex; flex-direction: column; gap: 12px; }
.wm-team-head { display: flex; align-items: center; justify-content: space-between; }
.wm-team-head h3 { margin: 0; font-size: 14px; }
.wm-team-list { display: flex; flex-direction: column; gap: 6px; }
.wm-team-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  width: 100%; text-align: left; cursor: pointer; padding: 9px 12px;
  border: 1px solid var(--wm-border); border-radius: 10px;
  background: var(--wm-card); color: var(--wm-fg);
}
.wm-team-row.active { border-color: var(--wm-accent, #3b82f6); box-shadow: var(--wm-shadow-lift); }
.wm-team-detail { border-top: 1px solid var(--wm-border-soft); padding-top: 12px; }
.wm-team-detail h4 { margin: 0 0 4px; font-size: 13px; }
.wm-team-table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
.wm-team-table th, .wm-team-table td { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--wm-border-soft); }
.wm-team-table th { color: var(--wm-muted); font-weight: 500; }
.wm-team-events { margin-top: 8px; max-height: 180px; overflow-y: auto; }

.wm-team-waves { display: flex; gap: 8px; overflow-x: auto; padding: 8px 0; }
.wm-team-wave { min-width: 150px; border: 1px dashed var(--wm-border); border-radius: 10px; padding: 8px; }
.wm-team-wave-head { font-size: 11px; color: var(--wm-muted); margin-bottom: 6px; }
.wm-team-chip {
  font-size: 11px; padding: 4px 6px; margin-bottom: 4px; border-radius: 6px;
  background: var(--wm-code, rgba(127,127,127,.10)); border-left: 3px solid var(--wm-muted);
}
.wm-team-chip.done { border-left-color: #22c55e; }
.wm-team-chip.dispatched, .wm-team-chip.running { border-left-color: #3b82f6; }
.wm-team-chip.failed, .wm-team-chip.blocked { border-left-color: #ef4444; }

.wm-team-question {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 10px; margin: 6px 0; border-radius: 8px;
  background: rgba(245, 158, 11, .12); border: 1px solid rgba(245, 158, 11, .35);
  font-size: 12px;
}

.wm-team-roles { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.wm-team-role {
  font-size: 11px; padding: 3px 8px; border-radius: 999px;
  border: 1px solid var(--wm-border); color: var(--wm-muted);
}
.wm-team-role.active { border-color: #3b82f6; color: #3b82f6; background: rgba(59, 130, 246, .10); }
.wm-team-current { font-size: 12px; color: #3b82f6; margin-bottom: 6px; }

.wm-drawer-section { margin: 10px 0 4px; font-size: 12px; color: var(--wm-muted); border-top: 1px solid var(--wm-border-soft); padding-top: 8px; }
.wm-drawer-actions {
  position: sticky; bottom: 0; margin-top: auto; padding: 10px 0 4px;
  display: flex; flex-wrap: wrap; gap: 6px;
  background: var(--wm-surface); border-top: 1px solid var(--wm-border);
}

.wm-tree { display: flex; flex-direction: column; gap: 10px; max-height: 55vh; overflow-y: auto; margin: 8px 0; }
.wm-tree-group-head { font-size: 11px; color: var(--wm-muted); margin-bottom: 4px; }
.wm-tree-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  width: 100%; text-align: left; cursor: pointer; padding: 8px 10px;
  border: 1px solid var(--wm-border); border-radius: 8px;
  background: var(--wm-card); color: var(--wm-fg);
}
.wm-tree-row:hover { box-shadow: var(--wm-shadow-lift); }

.wm-btn:focus-visible, .wm-pill:focus-visible, .wm-list-row:focus-visible,
.wm-team-row:focus-visible, .wm-tree-row:focus-visible {
  outline: 2px solid var(--wm-accent, #3b82f6); outline-offset: 2px;
}

`
