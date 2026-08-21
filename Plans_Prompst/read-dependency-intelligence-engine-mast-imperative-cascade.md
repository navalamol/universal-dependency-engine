# Plan: Review & Adopt Dependency Intelligence Engine MasterPlanUpdate.md

## Context

The user created a comprehensive master plan (Dependency Intelligence Engine-MasterPlanUpdate.md) with another AI session. Phases 1–5 of the engine are complete (332/332 tests passing, regression baseline A:5 B:0 C:3). The VS Code extension (Phase 6) is partially built. The master plan inserts two new phases — 5.5 and 5.6 — before the existing Phase 6, then renumbers downstream.

The user wants an honest review: challenge only medium+ disagreements, otherwise align and update all docs to reflect the new roadmap, then begin execution.

---

## Overall Assessment

The plan is **fundamentally sound and well-structured**. The core thesis — "harden the engine foundation before adding intelligence layers, and never let the UI or LLM replace the deterministic core" — is exactly right. No strong or critical disagreements. One medium disagreement on phase ordering, documented below.

---

## What I Agree With (no challenge needed)

### Phase 5.5 M1 — Security hardening + canonical orchestration API
**Full agreement.** The CODEBASE.md already flags the gap: `enrichWithConfidence` is only wired in `renovate-apply.js`, NOT in `mendfix.js`. The VS Code extension almost certainly bypasses the full pipeline. M1.3 (canonical orchestration API) closes this gap and is the right foundation for everything else. The secure process execution (M1.1) and credential handling (M1.2) are correct pre-pilot requirements.

### Phase 5.5 M2 — Verified remediation evidence
**Full agreement.** The canonical evidence model (M2.4) and outcome taxonomy (M2.5) are what separate a developer script from an enterprise-grade tool. Auditable, versioned, machine-readable evidence is the MOAT. SARIF + CycloneDX/VEX output makes the tool speak the language security teams already use.

### Phase 5.6 D1 — Exposure classification
**Full agreement.** Without knowing whether a package is RUNTIME_REACHABLE vs TEST_ONLY vs CI_EXECUTED, the Phase A/B/C decisions are incomplete. Enterprise security teams will immediately ask "does this actually run in production?" Exposure context directly strengthens confidence decisions and makes pilot reports more credible.

### Phase 5.6 D2 — Replacement and Migration Navigator (D2.1–D2.3)
**Agreement.** API usage fingerprinting + alternative scoring + migration strategy are high-value for Phase C items that currently get "manual review" with no actionable path forward. This turns Phase C from a dead end into a guided process.

### Phase 5.6 D3 — Patch, Backport and Upstream Contribution
**Agreement on direction.** Native npm patch support (D3.1), internal fork workflow (D3.3), licensing gate (D3.5) are concrete and implementable. LLM-assisted patches (D3.4) are correctly gated behind feature flag + human approval. No complaint.

### Phase 6 repositioning (after 5.5 + 5.6 D1/D2)
**Agreement.** The VS Code extension is already partially built but on a foundation that lacks the canonical orchestration API. Building the full UI on top of M1.3's canonical API means the extension is a genuine thin client — not a partial re-implementation of the analysis pipeline.

---

## Medium Disagreement: Phase 5.5 M3 ordering relative to Phase 5.6 D1

**The issue:** The plan sequences 5.5 M1 → 5.5 M2 → 5.5 M3 (Paid Pilot packaging) → then all of 5.6.

M3 includes building CI integrations (GitHub Actions, AzDO), a policy file schema, audit trail, KPI reports, and a pilot runbook. These are valid, but M3 delivered *without* D1 (exposure classification) means the pilot story is: "we fixed 22 CVEs" — the same story any scanner tells.

Delivered *with* D1, the story is: "we fixed 22 CVEs, reduced your RUNTIME_REACHABLE exposure by 17, and the remaining 5 are CI_ONLY dev tools below your blast-radius threshold." That's an enterprise sale, not a developer tool.

**Suggested reorder:**
```
5.5 M1 (security + canonical API)
5.5 M2 (evidence model + outcome taxonomy)
5.6 D1 (exposure classification + hygiene)     ← moved before M3
5.5 M3 (pilot packaging, now with exposure context in KPI reports)
5.6 D2 (migration navigator)
5.6 D3 (patch/backport)
Phase 6 (UI, built on canonical API from M1.3 + exposure from D1)
```

This is a sequence change within the same work, not a scope change. M3's KPI reports become more meaningful, and pilot customers get a differentiated answer to "what actually matters in production."

**Confidence in this disagreement:** Medium. It's a prioritization judgment, not a technical objection. If the user prefers the original ordering (finish all 5.5 before any 5.6) for cleaner delivery milestones, that is a valid choice.

---

## Minor note on D2.4 (Prototype branches + behavioral comparison)

Not challenging this, but flagging: D2.4 (automated prototype branches, replay representative inputs, normalize and compare outputs) is the most ambitious item in 5.6. It's correctly marked "Where policy permits" which gates it. Worth treating D2.4 as a stretch goal within D2 — implement D2.1–D2.3 first, and D2.4 only if D2.1–D2.3 are verified and time permits.

---

## Document Update Plan (if user approves)

If the user agrees on the overall direction (and optionally the D1-before-M3 reorder), the following files need updating:

1. **`Master_Roadmap.md`** — insert 5.5 and 5.6, reorder Phase 6 downstream, add status for each mission
2. **`NEXT_MISSION.md`** — add 5.5 M1–M3 and 5.6 D1–D3 with gate conditions, mark 5.5 M1 as current
3. **`CODEBASE.md`** — update "Next:" line to reflect Phase 5.5 M1
4. **`CLAUDE.md`** — update architecture description to note canonical orchestration layer (planned), update test baseline note
5. **`docs/ROADMAP.md`** — sync with Master_Roadmap.md structure

No code changes until the user approves the plan.

---

## Verification (after doc updates)

- `npx jest --no-coverage` must still show 332/332 passing (docs-only change, no risk)
- `node mendfix.js analyze --report <path>` must still show A:5 B:0 C:3
