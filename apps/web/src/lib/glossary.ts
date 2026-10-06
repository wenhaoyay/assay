// Plain-English meanings of the terms GaugeLab shows. The terms stay on screen; these appear on
// hover (always) and inline when "Explain" is on.

export const GLOSSARY: Record<string, { term: string; plain: string }> = {
  pass_rate: { term: 'Pass rate', plain: 'Share of test questions the bot got right on every gating check. Averaged per question first, so repeating a question does not count twice.' },
  ci: { term: '95% interval', plain: 'The range the true value probably lies in, given how many questions were tested. Wide range = few questions or uneven results.' },
  pass_at_k: { term: 'pass@k', plain: 'Would the bot get it right at least once if you asked k times? High pass@k but low pass^k means it can do it, but not reliably.' },
  pass_hat_k: { term: 'pass^k', plain: 'Does the bot get it right every one of k times? This is the number that matters when users only ask once.' },
  within_noise: { term: 'Within noise', plain: 'The difference is small compared with the run-to-run uncertainty: the interval crosses zero, so it could easily be chance.' },
  likely_better: { term: 'Likely better', plain: 'The whole 95% interval is on the better side of zero: the improvement is unlikely to be chance.' },
  likely_worse: { term: 'Likely worse', plain: 'The whole 95% interval is on the worse side of zero: the regression is unlikely to be chance.' },
  point_estimate: { term: 'Point estimate', plain: 'A single measured number with no interval (latency, tokens, cost): read it as "about this much", not as a proven difference.' },
  recall_at_k: { term: 'Recall@k', plain: 'Of the documents a person marked as needed, how many did retrieval find in its top k? 1.0 = it found all of them.' },
  precision_at_k: { term: 'Precision@k', plain: 'Of the top k documents retrieval returned, how many were actually relevant?' },
  mrr: { term: 'MRR', plain: 'How high the first relevant document ranks. 1.0 = always first; 0.5 = typically second.' },
  ndcg: { term: 'nDCG@k', plain: 'Ranking quality of the top k: relevant documents near the top score higher than the same documents lower down.' },
  mcnemar: { term: 'McNemar test', plain: 'Looks only at questions where the two versions disagreed. A small p means the split is unlikely if both were equally good. It says nothing about how big the difference is.' },
  kappa: { term: "Cohen's kappa", plain: 'How often you and the judge agree, beyond what chance alone would give. 0.4 moderate, 0.6 substantial, 0.8 near-perfect.' },
  not_applicable: { term: 'Not applicable', plain: 'The test question does not ask for this check (e.g. no expected documents, so no recall).' },
  not_evaluated: { term: 'Not evaluated', plain: 'The check applies but could not run: the bot did not report what it needs (sources, tokens...) or no judge was set.' },
  heuristic: { term: 'Heuristic judge', plain: 'Scores by word overlap with the reference, not by an LLM. Free and offline, but cannot recognise paraphrase or negation. Shown hatched.' },
  flaky: { term: 'Flaky', plain: 'Passed on some tries and failed on others: the bot is not consistent on this question.' },
  gating: { term: 'Gating check', plain: 'A check that can fail a test question. Diagnostic checks are shown but never fail anything.' },
  calibrated: { term: 'Calibrated', plain: 'You labelled some answers yourself and GaugeLab measured how often this judge agrees with you. Uncalibrated judges are unvalidated.' },
  comparable: { term: 'Comparable runs', plain: 'Runs on the same questions, with the same checks and the same judge. Only these can be read side by side.' },
  p95: { term: 'p95 latency', plain: '95% of answers came faster than this. The slow tail users actually notice.' },
  p50: { term: 'p50 latency', plain: 'The median: half the answers came faster than this.' },
  gate: { term: 'Regression gate', plain: 'Release rules: minimum scores and maximum drops versus a baseline. PASS, FAIL or not evaluated - never a blended score.' },
  stage: { term: 'Pipeline stage', plain: 'Where in answering a question the failure started: finding documents, using tools, writing the answer, grounding it, or speed and cost.' },
}

export type GlossaryKey = keyof typeof GLOSSARY
