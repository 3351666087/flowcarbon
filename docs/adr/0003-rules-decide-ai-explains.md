# ADR 0003 — Rules decide, AI explains

- Status: accepted
- Date: 2026-10-16

## Context

Facility managers and energy engineers have to defend every saving claim, often in an energy performance
contract where money changes hands on verified savings. Interviews with practitioners stressed that thresholds
must have a basis and that the platform must not "tell the professionals what to do".

## Decision

- Waste and opportunities are detected by deterministic rules in `packages/core/src/rules.ts`. Every threshold
  has a written rationale, can be overridden per building, and the parameters in force are stored with each
  finding.
- Each interval's HVAC energy is attributed to at most one rule, so totals never double count.
- A finding is presented as an opportunity with evidence. People decide its status (acknowledged, fixed,
  dismissed); the system never changes building settings.
- The AI component only reads a finding's evidence, the forecast and the strategy list. It explains what
  happened, gives likely causes, recommends **one** action from the fixed strategy list, cites its basis and
  states what is uncertain. Its output is stored with the model, prompt version and token counts.

## Consequences

- Results are reproducible and testable; the simulator injects known events to measure detection.
- The AI can be switched off without losing any functionality other than the explanation text.
