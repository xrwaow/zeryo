✨
# ✨ Zeryo Chat ✨

## How to Run
  ```bash
  git clone https://github.com/xrwaow/zeryo.git
  cd zeryo
  ```

  *   You need to provide API keys for OpenRouter, Google AI in a file named `api_keys.yaml`, like api_keys_example.yaml.

  ```bash
  pip install PyYAML fastapi requests beautifulsoup4 pydantic uvicorn httpx
  ```
  ```bash
  python api.py
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
*   **Tool Usage (Beta):**
    *   Enable/disable tool usage for the LLM.
    *   Includes basic `search` (DuckDuckGo) and `add` tools.
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
