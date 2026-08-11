# Plan: Mend AutoFixer Demo Artifact

## Context

The user wants a polished demo presentation for the Mend AutoFixer tool — a Node.js CLI that automates 90-95% of the Mend vulnerability triage process. The demo is for a mixed audience (developers, team leads, managers, security team). It must be scoped only to Mend remediation (not a broader dependency intelligence roadmap) and must cover both npm and Maven workflows since multiple product teams across different stacks use Mend.

## Demo Artifact Structure

Single-page HTML artifact with a navigation sidebar and scrollable sections. Elegant, professional — suits a mixed technical/non-technical audience.

### Sections

1. **Hero** — Tool name, one-line value prop, time-saved stat (2–4 hrs → ~15 min)

2. **The Problem** — Visual timeline showing the manual process pain: read report → look up CVE → trace semver → edit package.json → run install → verify → repeat. Annotated with time costs and failure points.

3. **Architecture Diagram** — Inline SVG pipeline:
   ```
   Mend Report (JSON/Excel)
     → Parser → SemVer Engine → (optional) Registry Verify
     → Phase Classifier → Overrides/POM Writer → Report Generator
   ```
   With file names annotated on each node (`src/parser.js`, etc.)

4. **3-Phase Confidence Model** — Three cards (A / B / C) with confidence %, criteria, output artifact, and human action required. This is the central concept — most visually prominent section.

5. **End-to-End Workflow** — Tabbed: **npm** tab and **Maven** tab. Each shows:
   - CLI command example
   - Step-by-step flow with outputs
   - What gets auto-applied vs. what needs review
   - Rollback safety note

6. **What's Built** — Grouped feature checklist:
   - Core pipeline (parsing, semver, classification)
   - npm-specific (lock file, overrides, direct dep detection, install + verify, rollback, manifest)
   - Maven-specific (registry, POM writer, apply + rollback)
   - Claude AI integration (Phase C structured triage workflow)

7. **What Can Be Improved** — Honest, scoped gaps (not the full roadmap):
   - Maven dep-tree parser (needed for Phase B promotions in Java)
   - Deeper mixed dev/runtime chain classification
   - `mendfix analyze` / `mendfix apply` subcommands
   - Auto git commits by confidence tier
   - Excel column auto-mapping improvements

8. **Code Snapshot** — For the technical audience: a few annotated code excerpts showing the key algorithmic pieces (resolveFixVersion, classifyPhase) with plain-English annotations.

## Design Decisions

- **Navigation**: Fixed left sidebar with section anchors — lets different audience members jump to what matters to them (manager → problem + Phase model; dev → architecture + code; security → Phase C workflow)
- **Color system**: Phase A = green, Phase B = amber, Phase C = red — consistent throughout all diagrams and tables
- **Diagrams**: Inline SVG (no external libs) — CSP-safe
- **Theme-aware**: Light/dark using CSS tokens per artifact design guidelines
- **No external CDN**: All styling inline

## Verification

1. Read the written HTML file before publishing to confirm accuracy
2. Check that CLI commands match actual flags in `mend-fix.js`
3. Confirm Phase A/B/C criteria match `src/phases.js` logic
4. Confirm Maven flow steps match `src/pom-writer.js` and `src/maven-registry.js`
5. Publish artifact and verify rendering in both light and dark themes
