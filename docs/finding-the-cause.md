# Why answers failed, and what to change

A run tells you which answers failed. To improve the bot you need to know why, because the fix
depends on it: a search problem is fixed in the documents or the retriever, a model problem in
the prompt or the model, and a test problem in the question set. Assay gives every failed
answer a **likely cause**, shows the evidence for it, and says what to change.

## The loop

1. Run the question set against the current version (the baseline).
2. Open the run. **What to fix first** counts the failing questions by cause, the bot's own
   causes first, largest first. Each cause opens to its examples and the fix.
3. Change **one** thing in the bot, save it as a new version of the connection, and run the
   same question set again.
4. **Compare** the two runs. *By cause* shows what the change fixed (why those questions
   failed before) and what it broke (why they fail now). Keep the change if it fixed what you
   meant it to and broke nothing that matters.
5. When a real user hits a bad answer, keep it as a case (*Add to a dataset* on its page).

## How the cause is found

For a retrieval chatbot, an answer goes wrong at one of a few points (after Barnett et al.,
*Seven Failure Points When Engineering a Retrieval Augmented Generation System*, 2024). For
each failed answer, Assay takes what a correct answer needed (missing must-mention phrases,
required patterns that did not match, the exact answer, or the codes and numbers of the
reference answer when a grading model judged the answer wrong) and looks for it:

| Found | Cause | What to change |
|---|---|---|
| In none of the uploaded documents | **Not in the documents** | Add or update the document, or correct the expected answer |
| In a document, not in the passages the bot read | **Search missed it** | Titles and headings, splitting long documents, keywords and synonyms, more passages |
| In a passage the bot read, not in the answer | **Found but not used** | The prompt (use every source, copy values exactly), or a stronger model |

It also flags:

- **Read a wrong or outdated passage**: what the answer must not say is in a passage the bot read.
- **Made up**: numbers or claims no passage supports. A count or sum the bot worked out
  itself is flagged too; check those by hand.
- **Cited the wrong source**: a code or number cited to a passage that does not contain it.
- **Answered when it should decline**, **wrong tool use**, **wrong format**, **too slow**.
- **Suspect test**: the question failed in every run, whatever changed. Often the expected
  answer is wrong or outdated.
- **Written for another chatbot**: the question set belongs to another chatbot. New run
  refuses such a mix unless you confirm it.
- **Bot too busy** (rate limits, time-outs) and **the bot returned an error**: not answer quality.

This is plain text matching: free, instant, and the evidence is shown ("'ZP17' was in [8] PP
Blueprint v28, p. 173, but not in the answer"). When the evidence does not decide it, the
verdict is **Can't tell yet** rather than a guess.

Two things make the verdicts sharper:

- **Let the connection read the bot's sources.** Without them Assay cannot tell "search
  missed it" from "found but not used". See *Reading the reply* on the connection's page:
  it shows what a reply already stored contains, reads it with one click, and re-reads past
  runs from their stored replies. No questions are asked again; checks that need no grading
  model run again; grading-model verdicts are carried over. Each re-read is a new run.
- **Upload the bot's documents** (a dataset's *Build* tab or *Generate from documents*). Then
  "not in the documents" can be told from "search missed it".

## When the rules cannot place a failure

- **Ask the grading model.** One short call per failure: it picks a cause from the same list
  and says why in one sentence. It respects *local grading models only*. It can be wrong;
  its explanation is labelled as such.
- **Set the cause yourself** on the answer's page. Your choice wins and is counted everywhere.

## Your notes, grouped

Reading failures and writing one line on each ("ignores the plant", "too formal") finds
problems no check was written for. Write the note under *Kind of failure > Change > Why*.
On the chatbot's page, *Your notes on failures* groups them into themes and counts them,
either by shared words (free) or with a model you choose. The biggest theme is usually the
next thing to fix, and often the next check to write.

## Testing search on its own

Search changes are the ones you try most often, and asking a paid model for every answer to
test them is expensive. If the bot can return what it would read without writing an answer
(the PP Assistant has `POST /api/search`), connect that as its own connection and use the
**Search only** preset on New run. Its check, *Search found it*, passes when every
must-mention phrase is in the passages read; no document labels needed.
