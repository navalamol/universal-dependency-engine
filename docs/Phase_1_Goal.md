Phase 1 Goal

Not:

Build dependency intelligence.

Not:

Build AI.

Not:

Build a framework.

Goal:

Replicate my current Mend remediation process with minimal manual work.

If the tool cannot do what I currently do manually, Phase 1 is incomplete.

Scenario 1
Read Mend Excel

Input

Mend Excel Report

Should extract

Package
Version
Severity
CVE
CVSS
Recommendation
Fixed Version(s)
Advisory URL
Description

No manual parsing.

Scenario 2

Package Lock Analysis

Given

package-lock.json

Tool should determine

Installed version
Every occurrence
Parent packages
Full dependency chain

Example

root

↓

webpack

↓

ajv

↓

fast-uri

No manual searching.

Scenario 3

SemVer Compatibility

Current

^6.4.2

Recommended

6.5.7

Should classify

SAFE

Another

6.4.2

↓

6.5.7

Should classify

Requires Review

Exactly how you currently work.

Scenario 4

Parent Upgrade

Instead of immediately overriding

Child

↓

Parent

↓

Grandparent

Tool should check

Can parent be upgraded?

If yes

Prefer parent upgrade.

Exactly matching your workflow.

Scenario 5

Temporary Override

When safe

Tool should

Add override.

Run

npm install --package-lock-only --legacy-peer-deps

Verify

Package updated.

Scenario 6

Override Cleanup

After install

If package naturally resolves

Override removed automatically.

This is one of the biggest advantages of your process.

Scenario 7

Unnecessary Overrides

Detect

Override exists

↓

No longer needed

Automatically remove.

Scenario 8

Runtime vs Build

Tool should classify

Runtime

Build

Test

Development

using dependency ancestry.

Not guesses.

Scenario 9

False Positive

When

No fix available
Build only
Not shipped

Generate

False Positive Justification

Automatically.

Scenario 10

Multiple Dependency Chains

Package appears

webpack

↓

fast-uri

AND

eslint

↓

fast-uri

Tool should analyse BOTH.

Scenario 11

Highest Safe Version

Suppose Mend recommends

3.1.4

4.1.1

2.4.3

Tool should choose

Highest compatible version.

Not highest version.

Scenario 12

Direct Dependency

Package exists in

package.json

Tool should recommend

Direct upgrade

instead of override.

Scenario 13

Override vs Parent Upgrade

Priority

Direct upgrade

↓

Parent upgrade

↓

Override

Never reverse.

Scenario 14

Confidence

Every recommendation must include

Confidence

Reason

Evidence

Alternative
Scenario 15

High Confidence Commit

Automatically generate

High confidence fixes

Only

Safe updates.

Scenario 16

Medium Confidence Commit

Separate

Riskier

Overrides

Exact versions

Potentially breaking.

Scenario 17

Markdown Report

Should include

Package

Current

Recommended

Reason

Confidence

Action

Parent

Runtime

Commit

Scenario 18

PR Description

Automatically generated.

Scenario 19

Dry Run

Most important.

Support

mendfix analyze

No files changed.

Only report.

Scenario 20

Apply

Support

mendfix apply

Actually modify repository.

Scenario 21

Idempotency

Running

mendfix apply

Twice

Should produce

No additional changes.

Scenario 22

Rollback

If install fails

Restore

Original

package.json

package-lock

Scenario 23

Logging

Every decision

Should explain

WHY.

Never

Just

Updated.
Scenario 24

Manual Review

Anything below confidence threshold

Must move into

manual-review.md

Never silently apply.

Scenario 25

Final PR Ready

End result

package.json

package-lock

reports

commits

PR description

false positive report

Ready to push.

One Important Missing Scenario

I don't think we explicitly discussed this earlier, but it will make the tool much more practical:

Scenario 26 – Preserve Human Changes

Suppose you manually changed two overrides.

Running the tool again should:

Detect user-managed changes.
Avoid overwriting them blindly.
Clearly report any conflicts instead of silently replacing them.

This prevents automation from undoing intentional engineering decisions.