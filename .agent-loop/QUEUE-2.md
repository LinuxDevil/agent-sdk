# Round 2 orchestration state (orchestrator's working notes)

Started 2026-10-02 on the owner's instruction: "spin sub agents to start working, do not wait for my input, do not wait for CI". Tickets are GitHub issues in LinuxDevil/agent-sdk (map: `issues.json` next to this file). Agents: `model: sonnet` or `opus` per the issue label, each in its own worktree `E:\agent-sdk\.claude\worktrees\<ID>`, merging its own PR after local verification. Brief: `.agent-loop/BRIEF-2.md` on the state branch. Key: `E:\agent-sdk\.claude\round2.env` (10 USD limit on the key).

Rules I follow: about five implementers at a time; one `hub` ticket at a time; documentation tickets use the reduced verification list; do not start a ticket whose dependency has not merged; R4, M7b, G9a, A1-A3, A7 need the owner (`owner-decision`).

## Done
- R5 docs sync workflow: agent-sdk-docs#5 merged. Owner action: enable "Allow GitHub Actions to create and approve pull requests" in the docs repo, then re-run "Sync SDK docs".

## Running
- R1a #187 (sonnet), R2 #189 (opus), R3 #190 (sonnet)
- G1 #193, G2a #194, G3 #197 (sonnet)
- Ticket writers still running: A (wave 4), M (wave 2), NB (wave 3 second half)

## Next, in order
- R1b #188 after R1a merges (live test 0.25)
- G4a #198, G5b #202, G6 #203, G8 #205 (independent pages)
- G2b #195, G2c #196, G4b #199, G4c #200, G5a #201 (G4b/G4c/G2c all edit api-overview.md: run them one after another)
- G7 #204 after G1, G2b, G2c, G4a-c
- G9a-d after all of G1-G8 (docs repo; G9a is owner-decision for the comparison matrix: do the sync/navigation part, leave the matrix out unless the owner approves)
- Wave 2 (M), then wave 3 (N), then wave 4 (A, owner-decision)

## Held for the owner
- R4 #191: tarball diet (recommended option A).

## Findings to carry forward
- `lousho studio` fails from an npm install in alpha.8 (R1a fixes): reason to cut alpha.9 after wave 0.
- Versions in the repo are the published ones; bump before the next release (owner).
- N3b is already done (Forge fork exists); `agent.fork()` exists on createAgent; N3a covers sessions only.
- createAgent() lacks: temperature, maxTokens, exporter, captureContent, redactContent, sandbox, onRunEnd. Candidate ticket (not filed): "createAgent() takes the remaining execute options".
