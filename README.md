✨
# ✨ Zeryo Chat ✨

## How to Run
  ```bash
  git clone https://github.com/xrwaow/zeryo.git
  cd zeryo
  ```

        *   Provide LLM credentials in `api_keys.yaml` (see `api_keys_example.yaml`).
        *   Provide dedicated Google Custom Search credentials in `search_api_keys.yaml` (see `search_api_keys_example.yaml`). Set `SEARCH_API_KEYS_PATH` if you keep the file elsewhere.

    ```bash
    pip install PyYAML fastapi requests pydantic uvicorn httpx trafilatura
    ```
  ```bash
  python api.py
  ```
  or
  ```bash
  uvicorn api:app --reload --host 0.0.0.0 --port 8000
  ```
  *   Open the `index.html` file in your web browser.

## Features

*   **Multi-Provider Support:** Connect to different LLM APIs via:
    *   OpenRouter
    *   Google Generative AI (Untested)
    *   Local models (Tested with llama.cpp server, compatible with OpenAI API format)
*   **Chat Interface:**
    *   Markdown rendering with code highlighting (via `highlight.js`).
    *   LaTeX rendering (via KaTeX).
    *   Collapsible `think`, `code` and `tool` blocks.
*   **Message Management:**
    *   Persistent chat history stored in SQLite.
    *   **Branching:** Generate multiple responses for a single prompt and switch between them.
    *   Edit existing messages.
    *   Delete messages (including subsequent branches).
    *   Regenerate responses (replacing or creating a new branch).
    *   Continue generating incomplete responses.
*   **Attachments:**
    *   Attach images (requires model support).
    *   Attach text files (`.txt`, `.py`, `.js`, etc.) - content is included in the prompt.
*   **Customization:**
    *   **Characters:** Define custom characters with unique system prompts.
    *   **Themes:** Switch between different UI themes (Dark, White, Solarized, Claude White).
    *   **Generation Settings:** Adjust parameters like temperature, max tokens, min_p via a modal.
    *   **Settings Modal:** Central modal with tabs (Main, Appearance, Generation, Tools, CoT Formatting).
    *   **Configurable CoT Tags:** Change start/end tags for chain-of-thought blocks (default `<think>` / `</think>`).
*   **Tool Usage (Beta):**
    *   Enable/disable tool usage for the LLM.
    *   Built-in tools: `search` (Google Custom Search), `scrape` (trafilatura web extraction), and `add`.
    *   Collapsible display for tool calls and results within the chat.
*   **UI:**
    *   Waow

## Stuff that sucks rn

*   **Tool Usage is Beta:**
    *   Tool integration is experimental and it barelly works.

rn:
![image](https://github.com/user-attachments/assets/b0506057-00da-4afb-8ecd-528e21792276)

before:
![image](https://github.com/user-attachments/assets/5b759472-da7e-44db-b8ff-c6644faabbb9)
    *   It doesn't work well with thinking models and it doesn't continue after tool call with Anthropic ones.
*   **Google Models:** hasn't been tested. The formatting logic is included, but functionality is not guaranteed.
*   **Local Models:** Tested primarily with `llama.cpp`'s server.

## New Settings & CoT Tag Customization

The settings gear now opens a centered modal with tabs:

* Main: toggle tools, autoscroll, default codeblock collapse.
* Appearance: pick a theme (also duplicates prior theme modal functionality for convenience).
* Generation: sliders for temperature, min_p, max_tokens, top_p.
* Tools: read-only preview of the current tools system prompt fetched from backend.
* CoT Formatting: customize the start/end tags that delimit the model's thought process.

CoT tags are stored in `localStorage` under `cotTags` as `{start, end}`. They must differ; if identical, the end tag reverts to `</think>`. Existing stored messages remain unchanged; only new generations are parsed with updated tags.

Autoscroll now uses a throttled animation-frame strategy to reduce jank with very fast streaming models.
