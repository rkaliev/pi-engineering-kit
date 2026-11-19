# Failure evidence: controls, signals and hypotheses

Facts are what sources report (errors, logs, CI output, config, versions, history); hypotheses are inferred from them. A fact that looks wrong is gathered again, never adjusted to fit.

## Pick a control

Compare the broken case with a control that ideally differs in one thing: the base commit, the flag off, the previous release. Say which control you use and why you trust it; one broken the same way hides every signal. A case that fails differently, and is better understood, can serve too.

## Signal and noise

A data point in the broken case and not in the control is a signal: it may point at the cause. One in both is noise: it can rule a hypothesis out, never point at one. Counts (queries, retries, bytes, time) compare better than descriptions.

## Hypotheses × facts

Hypotheses are rows, facts are columns; mark where each fits.
- By column: the signal the fewest hypotheses fit is the strongest. Pursue its hypothesis, not each in turn.
- By row: a hypothesis must fit every fact, noise included. One contradicting fact discards it.

When no row fits: re-check how each fact was gathered (host, time window, version), split a hypothesis that names no mechanism, merge per-instance ones into what the instances share, or combine two whose causes are each necessary. Form a new one only from facts you hold; never elaborate a hypothesis to explain a fact away.

## Facts, cheapest first

The report, then errors, logs and telemetry, then the failing job's output, then git history. Read code last, to explain a signal you already have. Stop at the first strong signal.

## A reproduction is a hypothesis

It must show the report's strongest signal (the same error and frame, the same counts). One that merely fails may be another defect: note it and set it aside.
