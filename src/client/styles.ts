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


/* ---------- header ---------- */
.wm-header {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 20px;
  background: var(--wm-card);
  border-bottom: 1px solid var(--wm-border-soft);
  /* No position:sticky here: inside the host's overflow:hidden right-rail it
     pins to the rail top and covers the shell's layout buttons. */
}
.wm-brand { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 700; letter-spacing: .2px; }
.wm-logo {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border-radius: 7px; font-size: 10px; font-weight: 800;
  color: var(--wm-accent); background: var(--wm-accent-soft);
  border: 1px solid var(--wm-border);
}
.wm-count { color: var(--wm-muted); font-size: 11px; font-weight: 500; background: var(--wm-code); border-radius: 999px; padding: 2px 8px; }
.wm-toolbar { margin-left: auto; display: flex; align-items: center; gap: 8px; }
/* 窄屏（320）：头部必须换行，否则视图切换被挤出可视区、提案计数被压成竖排单字。 */
@media (max-width: 720px) {
  .wm-header { flex-wrap: wrap; row-gap: 8px; padding: 10px 14px; }
  .wm-brand { flex: 1 1 auto; min-width: 0; }
  .wm-toolbar { margin-left: 0; width: 100%; justify-content: flex-start; overflow-x: auto; }
  .wm-count { white-space: nowrap; flex: none; }
  .wm-seg { flex: none; }
}
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
.wm-board { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; padding: 16px 20px 24px; align-items: start; }
@media (max-width: 1200px) { .wm-board { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 900px) { .wm-board { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px) { .wm-board { grid-template-columns: 1fr; } }
.wm-col { background: var(--wm-code); border: 1px solid var(--wm-border-soft); border-radius: 12px; padding: 10px; display: flex; flex-direction: column; min-height: 380px; }
.wm-col-head { display: flex; align-items: center; gap: 7px; padding: 2px 4px 10px; font-weight: 600; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--wm-muted); }
.wm-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.wm-col-count {
  margin-left: auto; font-size: 11px; min-width: 20px; text-align: center;
  background: var(--wm-card); border-radius: 999px; padding: 1px 6px; color: var(--wm-muted);
}
.wm-col-body { display: flex; flex-direction: column; gap: 9px; min-height: 60px; flex: 1 1 auto; }
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
.wm-progress-fill { height: 100%; border-radius: 999px; background: var(--wm-accent); transition: width .3s ease; }
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
  border: 1px solid var(--wm-border-soft); border-radius: 10px;
  padding: 12px 14px; background: var(--wm-card); box-shadow: var(--wm-shadow);
  border-top: 3px solid var(--wm-accent);
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
  padding: 10px 20px;
  background: var(--wm-card);
  border-bottom: 1px solid var(--wm-border-soft);
  background: var(--wm-surface);
}
.wm-context-field {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11px; color: var(--wm-muted);
}
.wm-context-field > span { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; font-weight: 600; }
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
.wm-list { display: flex; flex-direction: column; gap: 0; padding: 0; margin: 16px 20px 0; background: var(--wm-card); border: 1px solid var(--wm-border-soft); border-radius: 12px; box-shadow: var(--wm-shadow); overflow: hidden; }
.wm-list-head {
  display: grid; grid-template-columns: minmax(0,1fr) 132px 190px 76px; gap: 16px;
  padding: 9px 16px; border-bottom: 1px solid var(--wm-border-soft);
  font-size: 10px; letter-spacing: .04em; text-transform: uppercase; color: var(--wm-muted); font-weight: 600;
  background: var(--wm-code);
}
.wm-list-row {
  display: grid; grid-template-columns: minmax(0,1fr) 132px 190px 76px; align-items: center; gap: 16px;
  width: 100%; text-align: left; cursor: pointer;
  padding: 12px 16px; border: 0; border-bottom: 1px solid var(--wm-border-soft); border-radius: 0;
  background: transparent; color: var(--wm-fg);
  background: var(--wm-card); color: var(--wm-fg);
  box-shadow: var(--wm-shadow);
}
.wm-list-row:last-child { border-bottom: 0; }
.wm-list-row:hover { background: var(--wm-code); box-shadow: none; transform: none; }
.wm-list-head > *:last-child, .wm-list-row > *:last-child { text-align: right; }
.wm-list-main { min-width: 0; }
.wm-list-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wm-list-status { display: inline-flex; align-items: center; gap: 7px; }
.wm-list-projects, .wm-list-time { color: var(--wm-muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@media (max-width: 900px) {
  .wm-list-head { display: none; }
  .wm-list-row { grid-template-columns: minmax(0,1fr) auto; }
  .wm-list-projects, .wm-list-time { display: none; }
}
.wm-list-title { margin: 0; font-size: 13px; font-weight: 600; line-height: 1.35; }
.wm-drawer-mask {
  position: fixed; inset: 0; z-index: 60;
  background: var(--dsw-alias-bg-mask-1, rgba(8, 12, 20, .45));
  display: flex; justify-content: flex-end;
}
.wm-drawer {
  width: min(560px, 100vw); height: 100%;
  background: var(--wm-surface); color: var(--wm-fg);
  border-left: 1px solid var(--wm-border);
  padding: 16px; overflow-y: auto;
  display: flex; flex-direction: column; gap: 10px;
}
.wm-drawer-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.wm-drawer-head h3 { margin: 0; font-size: 15px; }

/* ---------- native minimal v3 (direction A) ----------
 * Follow the host: 14px body, 0.5px borders, layer surfaces, no decorative
 * shadows on content cards. Keep only the drawer/modal elevation. */
.wm-root {
  --wm-fg: var(--dsw-alias-label-primary, #1a1a1e);
  --wm-muted: var(--dsw-alias-label-secondary, #6b6b76);
  --wm-bg: var(--dsw-alias-bg-layer-1, #f6f7f9);
  --wm-card: var(--dsw-alias-bg-layer-2, #ffffff);
  --wm-surface: var(--dsw-alias-bg-layer-2, #ffffff);
  --wm-border: var(--dsw-alias-border-l3, rgba(15, 23, 42, .14));
  --wm-border-soft: var(--dsw-alias-border-l2, rgba(15, 23, 42, .10));
  --wm-accent: var(--dsw-alias-state-business-primary, #4d6bfe);
  --wm-accent-soft: var(--dsw-alias-bg-layer-2, #f3f4f6);
  --wm-code: var(--dsw-alias-bg-layer-2, #f4f4f5);
  --wm-shadow: none;
  --wm-shadow-lift: var(--dsw-elevation-soft, 0 2px 8px rgba(15, 23, 42, .10));
  --wm-hover: var(--dsw-alias-interactive-bg-hover, rgba(15, 23, 42, .05));
  font-size: 14px;
  line-height: 22px;
}
.wm-header {
  padding: 14px 24px;
  background: var(--wm-card);
  border-bottom: 0.5px solid var(--wm-border-soft);
}
.wm-brand { font-size: 15px; font-weight: 600; gap: 8px; }
.wm-logo {
  width: 28px; height: 28px; border-radius: var(--dsw-radius-sm, 6px);
  color: var(--wm-fg); background: var(--wm-surface);
  border: 0.5px solid var(--wm-border-soft); font-size: 11px; font-weight: 600;
}
.wm-count {
  display: inline-flex; align-items: center; height: 20px; padding: 0 7px;
  background: transparent; border: 0.5px solid var(--wm-border-soft);
  border-radius: 999px; font-size: 11px; font-weight: 500;
}
.wm-context {
  padding: 10px 24px; gap: 12px;
  background: var(--wm-card); border-bottom: 0.5px solid var(--wm-border-soft);
}
.wm-context-field { font-size: 12px; gap: 6px; }
.wm-context-field > span { font-size: 12px; letter-spacing: 0; text-transform: none; font-weight: 500; }
.wm-context-field select, .wm-search {
  height: 28px; padding: 0 8px; font-size: 12px; line-height: 26px;
  border: 0.5px solid var(--wm-border); border-radius: var(--dsw-radius-sm, 6px);
  background: var(--wm-bg); color: var(--wm-fg); box-shadow: none;
}
.wm-context-field select:focus, .wm-search:focus { border-color: var(--wm-accent); outline: none; }
.wm-context-meta { font-size: 12px; }
.wm-btn {
  height: 28px; padding: 0 10px; font-size: 12px; line-height: 26px;
  border: 0.5px solid var(--wm-border); border-radius: var(--dsw-radius-sm, 6px);
  background: transparent; color: var(--wm-fg); box-shadow: none;
  transition: background .12s ease, color .12s ease;
}
.wm-btn:hover { background: var(--wm-hover); box-shadow: none; transform: none; }
.wm-btn:active { transform: none; }
.wm-btn.primary {
  background: var(--dsw-alias-button-primary-fill, var(--wm-accent));
  border-color: transparent; color: var(--dsw-alias-label-primary-foreground, #fff); font-weight: 500;
}
.wm-btn.primary:hover { background: var(--dsw-alias-button-primary-hover, var(--wm-accent)); filter: none; }
.wm-btn.subtle { border-color: transparent; color: var(--wm-muted); }
.wm-btn.mini { height: 24px; padding: 0 8px; font-size: 11px; line-height: 22px; border-radius: var(--dsw-radius-sm, 6px); }
.wm-list {
  margin: 20px 24px 0; background: var(--wm-card);
  border: 0.5px solid var(--wm-border-soft); border-radius: var(--dsw-radius-md, 8px);
  box-shadow: none;
}
.wm-list-head {
  padding: 8px 16px; background: transparent;
  border-bottom: 0.5px solid var(--wm-border-soft);
  font-size: 11px; letter-spacing: 0; text-transform: none; font-weight: 500;
}
.wm-list-row { padding: 10px 16px; border-bottom: 0.5px solid var(--wm-border-soft); }
.wm-list-row:hover { background: var(--wm-hover); }
.wm-list-title { font-size: 13px; line-height: 20px; font-weight: 500; }
.wm-list-row .wm-card-id { font-size: 11px; }
.wm-list-projects, .wm-list-time { font-size: 12px; }
.wm-board { padding: 20px 24px 24px; gap: 12px; }
.wm-col {
  background: var(--wm-card); border: 0.5px solid var(--wm-border-soft);
  border-radius: var(--dsw-radius-md, 8px); padding: 8px; min-height: 280px;
}
.wm-col-head {
  padding: 4px 6px 8px; font-size: 12px; font-weight: 500;
  letter-spacing: 0; text-transform: none;
}
.wm-col-count { font-size: 11px; color: var(--wm-muted); }
.wm-card {
  background: var(--wm-code); border: 0.5px solid var(--wm-border-soft);
  border-radius: var(--dsw-radius-sm, 6px); box-shadow: none; padding: 10px 12px;
}
.wm-card:hover { box-shadow: var(--wm-shadow-lift); transform: none; }
.wm-card-title { font-size: 13px; font-weight: 500; line-height: 20px; }
.wm-card-bar { width: 3px; }
  background: var(--wm-card); border: 0.5px solid var(--wm-border-soft);
  border-radius: var(--dsw-radius-md, 8px); box-shadow: none;
}
.wm-console { padding: 20px 24px 24px; gap: 20px; }
.wm-kpis { gap: 12px; }
.wm-kpi {
  background: var(--wm-card); border: 0.5px solid var(--wm-border-soft);
  border-top: 0.5px solid var(--wm-border-soft);
  border-radius: var(--dsw-radius-md, 8px); box-shadow: none; padding: 12px 14px;
}
.wm-kpi-value { font-size: 22px; font-weight: 600; }
.wm-kpi-label { font-size: 12px; }
.wm-table { font-size: 13px; }
.wm-table th { font-size: 11px; font-weight: 500; padding: 8px; }
.wm-table td { padding: 8px; border-bottom: 0.5px solid var(--wm-border-soft); }
.wm-table tbody tr:hover { background: var(--wm-hover); }
.wm-drawer { width: min(560px, 100vw); padding: 20px 24px; background: var(--wm-surface); border-left: 0.5px solid var(--wm-border); }
.wm-drawer-head h3 { font-size: 16px; font-weight: 600; }
.wm-modal { align-items: center; padding: 24px; }
.wm-modal-box {
  width: min(560px, 100%); padding: 24px;
  background: var(--dsw-alias-bg-layer-2, var(--wm-surface));
  border-radius: var(--dsw-radius-panel, 12px);
  box-shadow: var(--dsw-elevation-prominent, 0 12px 40px rgba(15, 23, 42, .20));
}
.wm-modal-box h3 { font-size: 16px; font-weight: 600; margin: 0 0 16px; }
.wm-modal-box input, .wm-modal-box select {
  height: 32px; font-size: 13px; padding: 0 10px;
  border: 0.5px solid var(--wm-border); border-radius: var(--dsw-radius-sm, 6px);
  background: var(--wm-bg); color: var(--wm-fg);
}
.wm-graph {
  margin: 20px 24px 0; padding: 24px;
  background: var(--wm-card); border: 0.5px solid var(--wm-border-soft);
  border-radius: var(--dsw-radius-md, 8px);
}
.wm-empty { padding: 56px 0; font-size: 13px; }
.wm-section-title, .wm-card-title { font-size: 13px; font-weight: 600; }
.wm-skeleton-row { border-radius: var(--dsw-radius-sm, 6px); }

/* local controls (replace ui-primitives CSS that the host does not load for plugins) */
.wm-seg { display: inline-flex; align-items: center; gap: 2px; padding: 3px; background: var(--wm-code); border-radius: var(--dsw-radius-sm, 6px); }
.wm-seg button {
  height: 26px; padding: 0 12px; border: 0; border-radius: var(--dsw-radius-sm, 6px);
  background: transparent; color: var(--wm-muted); font-size: 12px; font-weight: 500; cursor: pointer;
}
.wm-seg button:hover { color: var(--wm-fg); }
.wm-seg button.active { background: var(--wm-card); color: var(--wm-fg); box-shadow: 0 1px 2px rgba(15,23,42,.08); }
.wm-tag {
  display: inline-flex; align-items: center; height: 20px; padding: 0 7px;
  border-radius: 999px; font-size: 11px; font-weight: 500; white-space: nowrap;
  color: var(--wm-muted); background: var(--wm-code);
}
.wm-tag-success { color: var(--dsw-alias-state-success-primary, #22c55e); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 10%, transparent); }
.wm-tag-info { color: var(--dsw-alias-state-business-primary, #4d6bfe); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 10%, transparent); }
.wm-tag-warning { color: var(--dsw-alias-state-warn-primary, #f59e0b); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 12%, transparent); }
.wm-tag-danger { color: var(--dsw-alias-state-error-primary, #ef4444); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 10%, transparent); }
.wm-state-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--wm-muted); flex: none; }
.wm-state-done { background: var(--dsw-alias-state-success-primary, #22c55e); }
.wm-state-ongoing { background: var(--dsw-alias-state-business-primary, #4d6bfe); }
.wm-state-warning { background: var(--dsw-alias-state-warn-primary, #f59e0b); }
.wm-state-error { background: var(--dsw-alias-state-error-primary, #ef4444); }
.wm-state-idle { background: var(--dsw-alias-state-idle-primary, #c9ccd1); }
.wm-path { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wm-tip { display: inline-flex; }
.wm-disclosure {
  display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 16px;
  border: 0; border-top: 0.5px solid var(--wm-border-soft); background: transparent;
  color: var(--wm-muted); font-size: 12px; text-align: left; cursor: pointer;
}
.wm-disclosure:hover { background: var(--wm-hover); color: var(--wm-fg); }
.wm-disclosure-icon { font-size: 10px; }
.wm-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.wm-modal-head h3 { margin: 0; font-size: 16px; font-weight: 600; }
.wm-modal-body { max-height: min(60vh, 520px); overflow-y: auto; }
.wm-modal-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.wm-import-list { margin: 12px 0 0; gap: 0; }
.wm-import-row { padding: 10px 0; border: 0; border-top: 0.5px solid var(--wm-border-soft); border-radius: 0; align-items: flex-start; }
.wm-import-row:first-child { border-top: 0; }
.wm-import-row > div:first-child { min-width: 0; }
.wm-import-row .wm-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--wm-muted); margin-top: 2px; }
.wm-import-row .wm-actions { flex: none; }
.wm-import-badge { margin-left: 6px; vertical-align: 1px; }


/* task view (adopt-superagent-openspec-source) */
.wm-tasks { display: flex; flex-direction: column; gap: 12px; padding: 14px 20px 24px; }
.wm-tasks-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.wm-conn-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--wm-muted); flex: none; }
.wm-conn-dot.ok { background: var(--wm-success, #2e7d54); }
.wm-conn-dot.off { background: var(--wm-danger, #a63d37); }
.wm-tasks-health { font-size: 12px; color: var(--wm-muted); }
.wm-tasks-count { font-size: 12px; color: var(--wm-muted); margin-left: auto; }
.wm-tasks-board { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; align-items: start; }
/* 760 仍保持四列（验收要求）：每列约 170px，卡片标题两行截断即可读；
   只有更窄才降成两列、单列。 */
@media (max-width: 640px) { .wm-tasks-board { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 460px) { .wm-tasks-board { grid-template-columns: minmax(0, 1fr); } }
.wm-task-col { display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 10px; border: 0.5px solid var(--wm-border-soft); border-radius: 10px; background: var(--wm-surface); }
.wm-task-col-attention { border-color: var(--wm-border); }
.wm-task-col-head { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.wm-task-col-label { font-weight: 600; }
.wm-task-col-count { color: var(--wm-muted); }
.wm-task-col-hint { margin-left: auto; color: var(--wm-muted); font-size: 11px; }
.wm-task-col-body { display: flex; flex-direction: column; gap: 8px; }
.wm-task-card { display: flex; flex-direction: column; gap: 6px; padding: 9px 10px; border: 0.5px solid var(--wm-border-soft); border-radius: 8px; background: var(--wm-card); }
.wm-task-open { display: block; width: 100%; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.wm-task-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 13px; font-weight: 500; line-height: 1.45; }
.wm-task-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 5px; color: var(--wm-muted); font-size: 11px; }
.wm-task-repo { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; padding: 1px 4px; border-radius: 4px; background: var(--wm-code); }
.wm-task-time { font-size: 10px; }
.wm-task-note { font-size: 11px; color: var(--wm-muted); line-height: 1.5; }
.wm-task-quote { padding: 7px 9px; border-left: 2px solid var(--wm-border); border-radius: 0 6px 6px 0; background: var(--wm-accent-soft); font-size: 12px; line-height: 1.55; }
.wm-task-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.wm-task-form { display: flex; flex-direction: column; gap: 10px; }
.wm-task-form-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
@media (max-width: 760px) { .wm-task-form-row { grid-template-columns: minmax(0, 1fr); } }
.wm-task-form .wm-context-field { display: flex; flex-direction: column; gap: 4px; }
.wm-task-form input, .wm-task-form textarea, .wm-task-form select { width: 100%; padding: 6px 8px; border: 0.5px solid var(--wm-border); border-radius: 6px; background: var(--wm-card); color: var(--wm-fg); font: inherit; font-size: 12px; }
.wm-task-modes { display: flex; flex-direction: column; gap: 6px; }
.wm-task-mode { display: flex; align-items: flex-start; gap: 8px; padding: 7px 9px; border: 0.5px solid var(--wm-border-soft); border-radius: 8px; }
.wm-task-mode.active { border-color: var(--wm-accent); }
.wm-task-mode b { display: block; font-size: 12px; font-weight: 500; }
.wm-task-mode small { display: block; color: var(--wm-muted); font-size: 11px; }
.wm-task-form-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.wm-task-facts { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 4px 10px; margin: 0; font-size: 12px; }
.wm-task-facts dt { color: var(--wm-muted); }
.wm-task-facts dd { margin: 0; overflow-wrap: anywhere; }
.wm-src { color: var(--wm-muted); font-size: 10px; font-weight: 400; }
.wm-tasks-leftover { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 0.5px solid var(--wm-border-soft); border-radius: 10px; background: var(--wm-surface); }
.wm-tasks-leftover-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 11px; }
.wm-tasks-leftover-row code { font-size: 10px; }
.wm-section-title { font-size: 12px; font-weight: 600; margin-bottom: 6px; }
`
