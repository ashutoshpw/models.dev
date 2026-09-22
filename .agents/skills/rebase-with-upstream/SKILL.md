---
name: rebase-with-upstream
description: Rebase the models.dev fork (ashutoshpw/models.dev) onto upstream (anomalyco/models.dev) dev while keeping the fork's AIStack models.dev branding, deployment customizations, and capability metadata intact. Use when syncing the fork with upstream, rebasing dev, after upstream catalog syncs land, or when models.aistack.run needs to pick up upstream changes.
---

# Rebase fork with upstream

The fork tracks `anomalyco/models.dev` (upstream) and deploys to **https://models.aistack.run** via Cloudflare (SST). It is co-branded **AIStack models.dev**: the AIStack brand owns user-facing copy and doc URLs, while package scopes (`@models.dev/*`), catalog data, and internal identifiers stay upstream. A rebase replays a small set of fork commits on top of upstream's `dev`, and it is only done when the fork's brand and deploy invariants survive and the deploy is green.

Both remotes use `dev`. Upstream has no `main`; neither does the fork. Work in place on `dev` — do not open a PR for a rebase, push straight to `origin/dev`.

## What the fork owns (must survive a rebase)

| Path | Fork state | Conflict policy |
| --- | --- | --- |
| `sst.config.ts` | `domain: "models.aistack.run"`, no `sst.Secret` links, no `models.opencode.ai` block | Fork wins. Re-check upstream did not add a required Worker prop |
| `.github/workflows/deploy.yml` | Guard `github.repository == 'ashutoshpw/models.dev'`, `vars.CLOUDFLARE_DEFAULT_ACCOUNT_ID` | Fork wins. Ask the user before adopting any new upstream workflow entry or edit |
| `packages/function/src/worker.ts` | `PosthogToken`/`LakeUrl`/`LakeSecret` optional, telemetry guarded | Merge: take upstream worker changes, keep optional `Env` fields and the guard condition |
| `packages/web/src/render.tsx` | `AIStack models.dev` titles/h1/copy, GitHub links point to `ashutoshpw/models.dev`, API examples use `https://models.aistack.run` | Fork wins on brand copy, the four hrefs, and doc URLs; upstream wins everywhere else |
| `packages/web/index.html` | `og:image` on `https://models.aistack.run/social-share.png` | Fork wins |
| `providers/**/models/*.toml` capability blocks | Fork-authored `[capabilities.*]` sections (anthropic `claude-opus-4-6`, google gemini/veo/embedding files, openai `gpt-5.4` + `gpt-realtime-2.1`, openrouter + vercel gpt-5.4/realtime, xai `grok-imagine-video-1.5`) | Take upstream's synced file, re-apply the fork's capability sections inside its new shape |
| Capability feature code | `feat: add evidence-backed capability metadata` touches `packages/core`, `packages/sdk`, `packages/web`, `docs/`, tests, `sync.md`, `AGENTS.md`, `package.json`, `validate.yml` | Keep; adapt to upstream's new shape. If upstream adopts the feature, drop the fork commit instead of duplicating |
| `scripts/check-fork.ts`, `.github/workflows/fork-check.yml`, `package.json` `check:fork` | Fork guard that enforces the rows above; CI runs it on push to `dev` | Fork wins. Add a `RULES` entry whenever a new fork invariant appears |
| Everything else | upstream | upstream wins |

Facts that make this cheap: upstream's hourly `sync-models.yml` (guarded to `anomalyco`) only lands catalog syncs under `providers/` and `models/`; the fork's sync workflows never run. The brand delta is confined to `packages/web/src/render.tsx` and `packages/web/index.html` — grep `Models.dev` (capital M) and `https://models.dev/` to find any upstream copy a rebase restored. Root `models.json` is stale legacy — syncs do not touch it, do not hand-merge it. `packages/sdk/src/generated.ts` is currently only touched by the fork's capability commit.

## Pre-flight

1. Work from a clean tree on `dev` (`git status`), and confirm the fork's head is what you think it is (`git log --oneline -3`).
2. `git fetch origin dev && git fetch upstream dev`.
3. Baseline health before rewriting history:
   - `bun install` if `bun.lock` changed.
   - `bun run check:fork`.
   - `bun validate`.
   - `bun run coverage:capabilities --check`.
   - `bun test` — record failures verbatim. Known pre-existing failures in the fork (as of the capability commit): Hyper reasoning inheritance, Eden AI reasoning options, DeepInfra live modalities, and open-weight weights links, all under `packages/core/test`. Only *new* failures are rebase damage.
4. Confirm the last fork deploy is green: `gh run list --repo ashutoshpw/models.dev --branch dev --limit 5`. A red base means fix it before rebasing.
5. Divergence and conflict surface:
   ```sh
   git rev-list --left-right --count origin/dev...upstream/dev
   git log --oneline origin/dev..upstream/dev
   git merge-tree "$(git merge-base upstream/dev origin/dev)" upstream/dev origin/dev | grep -c '^+<<<'
   ```
   Git >= 2.38 can use `git merge-tree --write-tree upstream/dev origin/dev` instead. Report the plan before rebasing.

## Rebase

1. `git rebase upstream/dev`.
2. Resolve per the table above. For synced provider/model TOMLs prefer upstream's file (`git checkout --theirs`) and re-add the fork's capability sections; never keep a fork-side copy of upstream pricing or modalities.
3. Keep the fork at its small commit count: fold fixes into the commit they belong to with `git commit --fixup=<sha>` followed by `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash upstream/dev`.
4. Never use `--no-verify`. Never commit secrets or tokens.

## Verify

1. `bun validate`.
2. `bun run coverage:capabilities --check`.
3. `bun test` — diff against the pre-rebase baseline; the known four should be the only failures.
4. Build the bundle the deploy builds: `bun ./script/build.ts` from `packages/web`.
5. Fork invariants — the guard encodes the table above, and CI's "Fork check" runs the same command:
   ```sh
   bun run check:fork
   git log --oneline upstream/dev..HEAD              # only fork commits
   ```
   If a conflict resolution deleted `scripts/check-fork.ts` or `fork-check.yml`, restore them from the previous fork commit; never delete a rule to make the guard pass.

## Push and deploy

1. `git push --force-with-lease origin dev` — a rebase rewrites `dev`; never plain `--force`.
2. Watch the runs: `gh run list --repo ashutoshpw/models.dev --branch dev --limit 5`. "Fork check" and "Deploy" both start on push; Fork check must be green. If no run appears within a minute (fork push events have missed before), dispatch it: `gh workflow run deploy.yml -R ashutoshpw/models.dev --ref dev`.
3. Verify live: `curl -sI https://models.aistack.run` returns 200, and `curl -s https://models.aistack.run/models.json | head -c 80` serves JSON.
4. On failure read `gh run view <id> --log-failed`. Common causes: a fork commit was lost in conflict resolution (re-introduced `sst.Secret`, `models.dev` domain, or the `opencode.ai` zone block), or the Cloudflare token lost R2/DNS scope. Never deploy by hand or via another CLI — the GitHub Action is the only deploy path.
5. The fork's `validate.yml` is PR-only and guarded to `anomalyco`, so it never runs here; local verification above is the gate.

## Report

Close with short bullets the user can scan:

1. **The rebase**: upstream range (old tip -> new tip), commits picked up, fork commits replayed, pushed head SHA.
2. **Conflict work**: only the calls that mattered — provider TOMLs re-applied, capability sections restored, anything dropped or folded.
3. **Verification**: what ran and the results, including whether the pre-existing four failures were the only ones.
4. **Deploy**: run ID/result and the live check.
5. **Flags**: upstream changes worth a decision, stale generated artifacts, or a fork customization upstream now conflicts with.

If a round was aborted or deploy is not green on the pushed head, say so explicitly instead of implying success.
