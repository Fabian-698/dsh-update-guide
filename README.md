# dsh-upgrade-fix-012

An [Agent Skill](https://skills.sh) for diagnosing and repairing the breakage caused by upgrading **DeepSeek Harness (dsh)** to **0.1.2-rc.x** (from 0.1.1-rc.2).

Battle-tested on a real machine (2026-09): one command health-check, per-problem fix playbooks, and a dual verification gate to prove the machine is clean.

## Symptoms this skill fixes

- Old sessions fail to open / resume: `Cannot read properties of undefined (reading 'some')` — presets or plugins using the removed `Session.events` API
- `UNKNOWN_MODEL` on old sessions — session model references no longer match the declared provider model set (model id renames, provider splits)
- `resume failed ... preset "xxx" not found` — the session's agent preset directory was deleted; `session/selectModel` cannot get through (fix: rebuild a stub preset, see `references/fix-patterns.md` 模式 6)
- Third-party plugins failing to enable (`... is not a function`, `on ok=false` in dshmarket logs) — e.g. `subagents.registerContinuableSetup` removed
- verify-session S10/S8 **false positives** — bundled verifier updated for range-pairs `sourceEventSeqs` and the full 0.1.2 event-type set
- Dead config override rows in `cordis.patch.yml`, web-bundle `fetchProvider` clobber gate, and more

Full checklist: [`references/breaking-changes.md`](references/breaking-changes.md) — 22 breaking changes, each with blast radius / how to detect / how to fix.

## Install

**Option A — skills CLI:**

```bash
npx skills add <owner>/dsh-upgrade-fix-012 -g
# GitHub 直连/镜像自动回退环境可用:
source gh-skills.sh && skills add <owner>/dsh-upgrade-fix-012 -g -y
```

**Option B — git clone (works offline-friendly mirrors):**

```bash
git clone --depth 1 https://github.com/<owner>/dsh-upgrade-fix-012.git \
  ~/.dsh/skills/dsh-upgrade-fix-012
```

**Option C — manual copy:** copy this directory to `~/.dsh/skills/dsh-upgrade-fix-012/` on the target machine (adjust `DSH_HOME` if not the default `~/.dsh`).

## Quick start

```bash
# 1) Health check — outputs a blocker/warning/info issue list
node ~/.dsh/skills/dsh-upgrade-fix-012/scripts/scan-upgrade.mjs

# 2) Fix per the scan output (order: blocker → warning)
#    - Invalid session model refs:
node ~/.dsh/skills/dsh-upgrade-fix-012/scripts/fix-model-refs.mjs --list
node ~/.dsh/skills/dsh-upgrade-fix-012/scripts/fix-model-refs.mjs \
  --provider deepseek-official --model deepseek-v4-flash \
  --reasoningEffort high --token-file /tmp/dshcookies.txt --dry-run
#    - Everything else: follow SKILL.md + references/fix-patterns.md

# 3) Dual verification gate
node ~/.dsh/skills/dsh-upgrade-fix-012/scripts/verify-session.mjs --all
node ~/.dsh/skills/dsh-upgrade-fix-012/scripts/verify-patch.mjs --profile web --diff-default

# 4) Restart dsh web (via dshmarket, not bare kill) and open a previously broken old session
```

If you use an AI agent (dsh agent, Claude Code, etc.), just point it at `SKILL.md` — the file is written to be agent-consumable and drives the whole workflow.

## Contents

| File | Purpose |
|---|---|
| `SKILL.md` | Agent-facing entry: workflow, fix order, known pitfalls |
| `references/breaking-changes.md` | All 0.1.2-rc.1 breaking changes, detection & remediation per item |
| `references/fix-patterns.md` | Copy-paste fix patterns (incl. the preset-stub pattern for deleted presets) |
| `references/model-fix.md` | Full `UNKNOWN_MODEL` retrospective with a real 16-session case |
| `scripts/scan-upgrade.mjs` | One-shot health check (6 categories, `--json` supported) |
| `scripts/fix-model-refs.mjs` | Batch session `selectModel` via RPC (`--list` / `--dry-run` / idempotent) |
| `scripts/verify-session.mjs` | Session-log integrity verifier (range-pairs + 0.1.2 event types) |
| `scripts/verify-patch.mjs` | Config assembly verifier (tree / MCP schema / handshake / clobber / dead patch) |

## Compatibility & notes

- Targets **dsh 0.1.2-rc.x**; `scan-upgrade.mjs` prints the detected version first — for other versions, read `references/breaking-changes.md` and judge applicability.
- Linux/macOS, Node ≥ 18. Some checks read session logs compressed with zstd.
- `scan-upgrade.mjs` / `verify-*.mjs` are read-only. `fix-model-refs.mjs` performs session-level `selectModel` RPCs (audited as `model/selection` events) against a running dsh web; it never edits session log files.
- No secrets are embedded; credentials are supplied at runtime via cookie file or `DSH_TOKEN` env.
- Model-flavor decisions (which provider/model to standardize on) are yours to make; the skill defaults to `deepseek-official/deepseek-v4-flash` since the built-in catalog is stable across config drift.

## License

[MIT](LICENSE)
