# ADR 0004 — Numbers from code, words from AI

- Status: accepted
- Date: 2026-11-01

## Context

The assistant answers requests like "bring avoidable energy down to 5%" with options people can apply. That goes
further than [ADR 0003](0003-rules-decide-ai-explains.md), where the AI only explained a finding: a figure in a reply
now sits next to a button that creates measures. A language model can write a plausible saving that nothing supports,
and the people reading it may have to defend that figure in an energy performance contract.

## Decision

- Every kWh, cost, percentage and target check is computed by `packages/core`, from the building's own data, through
  the rules and strategies it already uses. The model reads the request and writes prose. It never produces a number
  that is shown as a result.
- The model sees the computed plan and is told to use only the numbers in it. The request reaches it in a delimited,
  escaped block, as data, and the numbers in it are not the plan's: a person cannot add a figure by typing one. A goal
  someone typed may be named as the goal, in those words, and as nothing else. Option cards are drawn from the plan: a reply only adds a title and a sentence to an option the plan already has, and every
  figure on a card is read from the plan.
- That rule is checked, not trusted. Every number in a reply has to match a figure of the plan for its unit (a date or
  a floor label does not make "saves 2026 kWh" true), and an amount written in words fails outright. A reply that
  fails is dropped whole for the template. The check runs on the draft as well, because a draft is on screen while it
  is written: a figure that fails never reaches anyone, even for a moment.
- After-figures are labelled expected and carry their basis and range. The expected figure assumes 80 % of the covered
  avoidable energy is really saved and the range 60 % to 95 % (`REALISATION`), and the interface states all three.
  A measure the data has not measured yet carries its plan's figure, a week at a time, on the same window and
  realisation with the same range, so a figure does not change by moving from a card to the Measures page. Simulated
  figures are never presented as measured, and a strategy published from a building counts as measured only after
  enough complete days to say so.
- Everything works without AI. With no API key, when the model fails, or past a demo organisation's AI quota, a
  templated reply in the right language goes out over the same plan and the turn records `model: null`. A turn no model
  was asked about stays out of that quota.
- Applying an option goes through the path behind adopting a finding, so the result is an ordinary measure that the
  data later verifies. Nothing bypasses finding, strategy, measure, in effect, verified, and only days with data verify
  anything: a day without data is not a day without waste.
- The digital twin follows the same rule. Its brightness and power are computed by pure functions and reported as they
  come out, with no target value written into them, and the page says it is a simulation.

## Consequences

- A plan is reproducible and unit tested, and a model upgrade cannot change a saving.
- The demo survives an API outage, and the AI can be switched off with only the wording getting plainer.
- Replies cannot volunteer a number the planner did not compute, even a useful one. New insight has to be added to
  the planner, not to a prompt.
- The check on a reply's sentences is deliberately strict, so it sometimes drops a good reply for the template. That
  costs the wording and never a figure. It reads digits and common amounts in words in both languages; prose it cannot
  read is the limit of it. The figures on cards and in the before and after split are safe either way, because they
  never pass through the model.
- A figure can look worse than someone hoped. It is shown anyway: the model is not there to round it up.
