# Local grading models (Ollama)

A grading model ("judge") reads an answer and decides whether it is correct, grounded or
relevant. It can run in the cloud (OpenAI and others: fast, paid per call, the answers are sent
to the provider) or on your own PC with Ollama (free per call, nothing leaves the PC, slower).

> **Third-party notice.** Ollama and the models it downloads are third-party software. They are
> not made, endorsed, reviewed or supported by Assay, and the links below go to external
> websites. You download and install them at your own risk. Check each model's licence and
> terms, and your organisation's rules on installing software and on data; IT approval may be
> required. Assay gives no warranty for the availability, accuracy, safety or performance of
> third-party models and is not responsible for their output. Downloads are large (1–10 GB) and
> running a model uses your PC's memory, disk and power. Models whose names end in `-cloud` or
> `:cloud` run on the provider's servers: questions and answers leave your PC even though they
> are reached through the local Ollama. This notice is information, not legal advice.
>
> Assay asks you to accept this notice once (Settings > Models & keys) before its first
> model download, and records when.

## Is it free?

The software is free and there is no bill per grading call. You pay in other ways:

| Cost | What it means |
|---|---|
| Memory and disk | An 8-billion-parameter model (`llama3.1:8b`) needs about 5–8 GB of free memory and a ~5 GB download. |
| Time | Without a graphics card, tens of seconds per grading call (about 30 s for an 8B model on an ordinary laptop). |
| Quality | Small models agree with people less often than large cloud models. Calibrate before trusting one. |
| Licences and rules | Each model has its own licence; installing software at work may need approval. |

## Set it up

1. Install Ollama from <https://ollama.com/download> (external site) and open the app. It then
   runs in the background at `http://localhost:11434`.
2. In Assay, open **Settings > Models & keys**. The Ollama card ticks *running* within a few
   seconds.
3. Accept the third-party notice, then **Download** the suggested model. The table shows each
   model's size, the memory it needs, and the expected time per grading call on this PC (read
   from its free memory and whether it has a graphics card).
4. **Use for grading**: Assay connects the model and runs a 5-call check (speed, JSON
   reliability).
5. **Calibrate**: label about 30 answers in *Calibration*. Assay measures how often the model
   agrees with you; the *judge bake-off* compares it with other models on your labels.

## Choosing a model

Pick the largest model that fits in free memory and still answers in about half a minute. Close
other large programs first. Without a graphics card, a 3B model is a practical start; 8B is a
better judge if you can wait. Rough guide:

| Model | Download | Needs memory | Per call, no GPU | Per call, GPU |
|---|---|---|---|---|
| `llama3.2:1b` | ~1.3 GB | ~2.5 GB | ~6 s | ~1 s |
| `llama3.2:3b` | ~2.0 GB | ~4 GB | ~12 s | ~2 s |
| `llama3.1:8b` | ~4.9 GB | ~7 GB | ~30 s | ~4 s |
| `qwen2.5:14b` | ~9 GB | ~12 GB | ~70 s | ~7 s |

Time against cost, for 100 answers graded on 2 meaning checks (200 calls): an 8B model on a
laptop processor takes about 100 minutes and costs nothing; a cloud model takes a few minutes at
4 in parallel and is paid per call (a cloud model's *Check* shows its cost per 100 calls).

## LM Studio instead

LM Studio (also third-party) serves models through an OpenAI-compatible address, usually
`http://localhost:1234/v1`. Connect it under *Connect a provider > LM Studio*; it counts as local
because the address is on this PC.

## "Local grading models only"

A connection can be restricted to local judges (on its page). Runs and re-grades of that
connection are then refused with any judge whose address is not on this machine, **and with any
Ollama `-cloud` model**, which is reached locally but runs on Ollama's servers.

## Troubleshooting

- **Not answering at localhost:11434**: open the Ollama app. If another program uses port 11434,
  close it or point the model's base URL at Ollama's actual address.
- **Out of memory, or very slow**: choose a smaller model, close other programs, or grade fewer
  answers at a time.
- **Download stopped**: press Download again; Ollama resumes where it stopped.
- **Answers marked "not evaluated"**: the model replied without valid JSON or timed out. Run its
  Check; small models fail the JSON test more often.
