# Helmsman DSH Toolchain Compatibility

> AUTO-GENERATED from `toolchain.json` — do not edit by hand.
> Regenerate with: `node scripts/check-toolchain.mjs --generate-compat`
> This file must always equal that generator output; `--structural` enforces it.

Records the known-good ("verified") and known-broken version combinations for the DSH workbench used by Helmsman. The only authoritative source of versions is the root `toolchain.json`; this document and the setup guides must not contradict it.

## Verified toolchain

### DSH platform

| component | version | source |
|---|---|---|
| deepseek-harness | 0.1.2-alpha.5 | source build (github.com/deepseek-ai/deepseek-harness, apps/cli) |

Note: Local workbench runs on the 0.1.2-alpha.5 harness source tree. Community plugins authored against the 0.1.2-rc.1 surface run here on the alpha peer surface, so the pinned @deepseek-ai/dsh-tools must stay on this same alpha line.

### @deepseek-ai kernel

| package | kind | pinned version / peer requirement |
|---|---|---|
| @deepseek-ai/cordis | peer | resolved to the running host harness instance (peer dependency of every Helmsman package; never bundled as a private copy) |
| @deepseek-ai/dsh-tools | pinned | 0.1.2-alpha.5 |

### Community plugins — workbench (required in the profile)

| plugin | version | source (`dsh plugin add`) |
|---|---|---|
| dsh-better-sidebar | 0.18.0 | dsh-better-sidebar@0.18.0 |
| dsh-plugin-check | 0.1.0 | dsh-plugin-check@0.1.0 |
| dsh-skill-manager | 0.1.3 | dsh-skill-manager@0.1.3 |
| @open-agfs/dsh-agfs | 0.1.9 | @open-agfs/dsh-agfs@0.1.9 |
| dsh-outline | 0.1.6 | dsh-outline@0.1.6 |
| dsh-vision-router | 2.1.2 | dsh-vision-router@2.1.2 |
| dsh-mnemon | 0.5.2 | dsh-mnemon@0.5.2 |
| dsh-mcp-adapter | 0.6.3 | dsh-mcp-adapter@0.6.3 |
| dsh-auto-review | 0.10.4 | dsh-auto-review@0.10.4 |
| @changfenhuang/dsh-annotation | 1.4.8 | @changfenhuang/dsh-annotation@1.4.8 |

### Community plugins — reused by Helmsman (optional, feature-scoped)

| plugin | version | source (`dsh plugin add`) |
|---|---|---|
| dsh-virtual-workspace | 1.2.2 | github:KevinWen7415/dsh-virtual-workspace |
| dsh-memory-manager | 1.2.0 | https://github.com/MoonlitDropOfBlood/dsh-memory-manager/releases/download/v1.2.0/dsh-memory-manager-1.2.0.tgz |
| dsh-memory-palace | 1.6.2-alpha.4 | github:lovezi0/dsh-memory-palace |

### Helmsman self plugins

Bundle (installs the whole tree; not a layer itself):

| package | version | source |
|---|---|---|
| @helmsman/bundle | 0.1.0 | ./packages/bundle (registry: @helmsman/bundle@0.1.0) |

Layers (13 plugins):

| package | version | source |
|---|---|---|
| @helmsman/worktree | 0.1.0 | ./packages/worktree |
| @helmsman/memory-topology | 0.1.0 | ./packages/memory-topology |
| @helmsman/knowledge-tolaria | 0.1.0 | ./packages/knowledge-tolaria |
| @helmsman/artifacts | 0.1.0 | ./packages/artifacts |
| @helmsman/orchestrator | 0.1.0 | ./packages/orchestrator |
| @helmsman/adapter-claude | 0.1.0 | ./packages/adapter-claude |
| @helmsman/adapter-codex | 0.1.0 | ./packages/adapter-codex |
| @helmsman/adapter-pi | 0.1.0 | ./packages/adapter-pi |
| @helmsman/adapter-oh-my-pi | 0.1.0 | ./packages/adapter-oh-my-pi |
| @helmsman/presets | 0.1.0 | ./packages/presets |
| @helmsman/ui-dashboard | 0.1.0 | ./packages/ui-dashboard |
| @helmsman/ui-diff | 0.1.0 | ./packages/ui-diff |
| @helmsman/ui-workbench | 0.1.0 | ./packages/ui-workbench |

### Toolchain engines

| tool | constraint |
|---|---|
| node | ^22.19 || >=24 |
| pnpm | >=10 |

## Known issues

### dsh-tools-rc8-callid-toolcallid — @deepseek-ai/dsh-tools rc line breaks CallId/ToolCallId imports

The 0.1.2-rc.8 line of @deepseek-ai/dsh-tools imports the legacy CallId export from @deepseek-ai/dsh-llm, which the alpha line renamed to ToolCallId. A dsh-tools on the rc line running against the 0.1.2-alpha.5 harness makes plugins importing the shared call-id type fail at module load.

Symptom: `@deepseek-ai/dsh-llm does not provide an export named 'CallId'`

Affected: `dsh-better-sidebar`, `dsh-plugin-check`, `@open-agfs/dsh-agfs`, `dsh-mcp-adapter`, `dsh-auto-review`

Resolution: Keep @deepseek-ai/dsh-tools pinned to 0.1.2-alpha.5 (pnpm.overrides in the profile package.json). Do not move to the rc line without re-verifying the affected imports.

