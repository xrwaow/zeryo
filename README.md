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

## Screenshots

<img width="2339" height="1397" alt="Screenshot_20251208_120033" src="https://github.com/user-attachments/assets/0881e855-8a12-4523-9928-d794be169d79" />
<img width="2335" height="1396" alt="Screenshot_20251208_120000" src="https://github.com/user-attachments/assets/14cb4611-0502-40a7-97a3-e792bd1cf9f4" />
<img width="2334" height="1395" alt="Screenshot_20251208_120138" src="https://github.com/user-attachments/assets/ddb8fd75-c1d2-4476-82a7-fb3ff4a40a87" />
<img width="2321" height="1393" alt="Screenshot_20251208_120226" src="https://github.com/user-attachments/assets/ff9a6b4e-b014-43d2-826c-3f974a8b5bba" />
