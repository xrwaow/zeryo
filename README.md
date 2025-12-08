# Zeryo Chat

A self-hosted chat interface for LLMs with branching conversations, tool use, and persistent history.

## Setup

```bash
git clone https://github.com/xrwaow/zeryo.git
cd zeryo
pip install PyYAML fastapi requests pydantic uvicorn httpx trafilatura
```

Configure API keys:
- Copy `api_keys_example.yaml` to `api_keys.yaml` and add your LLM credentials
- Copy `search_api_keys_example.yaml` to `search_api_keys.yaml` for search tool (optional)

Run:
```bash
python api.py
```

Open http://localhost:8000 in a browser.

## Features

**LLM Providers**
- OpenRouter
- Google Generative AI
- Local models (llama.cpp server or OpenAI-compatible endpoints)

**Chat**
- Markdown rendering with syntax highlighting
- LaTeX support (KaTeX)
- Collapsible think/code/tool blocks
- SQLite-backed persistent history
- Message branching (generate multiple responses, switch between them)
- Edit, delete, regenerate messages
- Image and text file attachments
- Hex color preview in messages

**Characters**
- Define characters with custom system prompts, preferred models, and CoT tags
- Per-character model selection and settings

**Tools**
- `search` - Google Custom Search
- `scrape` - Web page extraction via trafilatura
- `python_interpreter` - Execute Python code with image output support (matplotlib, PIL)
- `add` - Addition (example tool)

**Settings**
- Multiple themes (Dark, White, Solarized, Claude White, GPT Dark, Gruvbox Light/Dark)
- Generation parameters (temperature, min_p, max_tokens, top_p)
- Autoscroll toggle
- Collapsible codeblocks by default

## Screenshot

![screenshot](https://github.com/user-attachments/assets/b0506057-00da-4afb-8ecd-528e21792276)
