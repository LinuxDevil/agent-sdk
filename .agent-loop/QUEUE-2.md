# Round 2 orchestration state

Updated 2026-10-02 when the session hit its usage limit. Tickets: TICKETS-2.md. Rules: BRIEF-2.md.

## Merged (21)
R1a #210, R1b #270, R3 #261, R5 docs#5, G1 #259, G2a #263, G2b #267, G2c #276, G3 #262, G4a #265, G4b #268, G4c #274, G5a #269, G5b #264, G7 #278, G8 #266, G9a docs#6, M1 #273, M6 #271, M7a #284, N8 #283.

## Were running when the session stopped (check each: open PR, or branch lou-<id>-* with unmerged commits)
R2 #189 (opus), M2 #222 (opus), M5a #226 (opus), M10a #233 (opus), N13a #255 (opus, PR #277 open: security fix for http_request DNS pinning), fix for #275 (typecheck-ai7 red on main since M1) then M8 #231 (sonnet).

## Next
- G6 #203 after R2. Fold in #288 (two dead links in SDK docs).
- G9b/c/d (Arabic, 35 pages pending) after wave 2.
- Wave 2 left: M3a, M3b (after N13a), M4 (hub), M5b (after M5a), M9 (hub), M10b, M10c, M7b (owner).
- Wave 3: N1a.. etc. One hub ticket at a time. Follow-up to file: route openApiTools requests through N13a's pinned lookup; createAgent() takes remaining execute options (temperature, maxTokens, captureContent, sandbox, callbacks); #272 runtime manifest enforcement.
- Wave 4 needs the owner's OK for breaking moves.

## Operational notes
- OpenRouter account has no credit (402). Deferred live tests are listed in issue #260.
- Disk: each worktree is ~1.2 GB with node_modules. After a ticket merges, delete node_modules/dist/coverage in its worktree (keep the worktree and branch). Keep at most ~4 code tickets running: the deploy tests share a machine-wide build lock and time out under load.
- Docs tickets use the reduced verification list. M1 slipped a failure past local checks because CI's ai-7 job was not run locally: for provider changes run the ai-7 job steps too.
- Owner actions pending: enable "Allow GitHub Actions to create and approve pull requests" in agent-sdk-docs; R4 #191; approve comparison rows (G9a); add OpenRouter credit; rotate the key after round 2.
