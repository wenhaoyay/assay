# local/ - private connectors (not committed)

Everything in this folder except this README is ignored by git. Put configuration here
that names internal systems, hosts or data you do not want in a public repository:

- `targets/*.yaml` - experiment configs that point GaugeLab at your own chatbots or agents
- `imports/*.yaml` - mappings for importing results a system already logged
- `datasets/*.yaml` - golden datasets built from internal material

Nothing in GaugeLab's code is specific to any one system: a new chatbot is connected by
writing one of these files (HTTP adapter + response mapping, or an import mapping), never by
changing code. See `docs/connecting-a-target.md`.
