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
  min-height: 100%;
  padding: 0 0 24px;
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
  position: sticky; top: 0; z-index: 5;
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
.wm-board { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; padding: 14px 18px 0; align-items: start; }
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

/* ---------- chat entry (assistant action row / input tools) ---------- */
.wm-chat-trigger {
  font-size: 12px; padding: 2px 8px; border-radius: 6px; cursor: pointer;
  border: 1px solid transparent; background: transparent; color: var(--wm-muted-fallback, #656d76);
}
.wm-chat-trigger:hover { background: var(--wm-code, rgba(127,127,127,.12)); color: var(--wm-fg, inherit); }
`
