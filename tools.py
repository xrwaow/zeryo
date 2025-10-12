# search.py
import os
from typing import List, Dict, Union, Callable, Any

import requests
import yaml

try:
    import trafilatura
except ImportError:  # pragma: no cover - graceful degradation if optional dep missing
    trafilatura = None


def _load_yaml_file(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = yaml.safe_load(handle) or {}
            return data if isinstance(data, dict) else {}
    except Exception as exc:
        print(f"Warning: Failed to load YAML file {path}: {exc}")
        return {}


API_KEYS = _load_yaml_file(os.environ.get("API_KEYS_PATH", "api_keys.yaml"))
SEARCH_KEYS = _load_yaml_file(os.environ.get("SEARCH_API_KEYS_PATH", "search_api_keys.yaml"))


def _extract_key(data: Dict[str, Any], *candidates: str) -> str | None:
    for key in candidates:
        if key in data and data[key]:
            return data[key]
        lower_key = key.lower()
        if lower_key in data and data[lower_key]:
            return data[lower_key]
    return None


GOOGLE_SEARCH_API_KEY = _extract_key(
    SEARCH_KEYS,
    "SEARCH_API_KEY",
    "GOOGLE_CUSTOM_SEARCH_API_KEY",
    "GOOGLE_SEARCH_API_KEY",
)
GOOGLE_SEARCH_ENGINE_ID = _extract_key(
    SEARCH_KEYS,
    "SEARCH_ENGINE_ID",
    "GOOGLE_CUSTOM_SEARCH_CX",
    "GOOGLE_SEARCH_ENGINE_ID",
)

if not GOOGLE_SEARCH_API_KEY:
    GOOGLE_SEARCH_API_KEY = _extract_key(
        API_KEYS,
        "SEARCH_API_KEY",
        "GOOGLE_CUSTOM_SEARCH_API_KEY",
        "GOOGLE_SEARCH_API_KEY",
        "GOOGLE",
    )

if not GOOGLE_SEARCH_ENGINE_ID:
    GOOGLE_SEARCH_ENGINE_ID = _extract_key(
        API_KEYS,
        "SEARCH_ENGINE_ID",
        "GOOGLE_CUSTOM_SEARCH_CX",
        "GOOGLE_SEARCH_ENGINE_ID",
    )

def search(query: str, *, max_results: int = 5, safe_search: str = "off") -> str:
    """Perform a Google Custom Search query and format the top results."""
    if not query or not query.strip():
        return "Error: Search query must be a non-empty string."

    if not GOOGLE_SEARCH_API_KEY or not GOOGLE_SEARCH_ENGINE_ID:
        return (
            "Error: Google Custom Search credentials are missing. "
            "Populate SEARCH_API_KEY and SEARCH_ENGINE_ID in search_api_keys.yaml (or set SEARCH_API_KEYS_PATH)."
        )

    params = {
        "key": GOOGLE_SEARCH_API_KEY,
        "cx": GOOGLE_SEARCH_ENGINE_ID,
        "q": query.strip(),
        "num": max(1, min(int(max_results), 10)),
    }
    if safe_search:
        params["safe"] = safe_search

    try:
        response = requests.get("https://www.googleapis.com/customsearch/v1", params=params, timeout=10)
        response.raise_for_status()
    except requests.exceptions.RequestException as exc:
        print(f"Error during Google Custom Search request for '{query}': {exc}")
        return f"Search results for '{query}':\n\nError performing search: {exc}"

    data = response.json()
    items = data.get("items", [])
    if not items:
        error_message = data.get("error", {}).get("message")
        if error_message:
            return f"Search results for '{query}':\n\nError from Google Custom Search API: {error_message}"
        return f"Search results for '{query}':\n\nNo results found."

    results_lines = [f"Search results for '{query}':", ""]
    for index, item in enumerate(items[: params["num"]], start=1):
        title = item.get("title") or "(No title provided)"
        link = item.get("link") or item.get("formattedUrl") or "(No link provided)"
        snippet = (item.get("snippet") or item.get("htmlSnippet") or "").replace("\n", " ").strip()
        results_lines.append(f"{index}. {title}")
        results_lines.append(f"   URL: {link}")
        if snippet:
            results_lines.append(f"   Snippet: {snippet}")
        results_lines.append("")

    return "\n".join(results_lines).strip()


def scrape(url: str) -> str:
    """Download and extract cleaned text content from a webpage using trafilatura."""
    if not url or not isinstance(url, str):
        return "Error: URL must be a non-empty string."

    if trafilatura is None:
        return "Error: trafilatura is not installed. Please add it to your environment to use the scrape tool."

    try:
        downloaded = trafilatura.fetch_url(url)
    except Exception as exc:
        print(f"Error fetching URL '{url}': {exc}")
        return f"Error fetching URL: {exc}"

    if not downloaded:
        return "Error: Unable to download the requested page."

    try:
        result = trafilatura.extract(downloaded)
    except Exception as exc:
        print(f"Error extracting content from '{url}': {exc}")
        return f"Error extracting content: {exc}"

    if not result:
        return "No extractable content found at the provided URL."

    return result.strip()


def tool_add(a: Union[float, str], b: Union[float, str]) -> str:
    """
    Calculates the sum of two numbers, a and b.
    Use this tool whenever you need to perform addition.
    Arguments:
        a (int | float | str): The first number.
        b (int | float | str): The second number.
    """
    try:
        num_a = float(a)
        num_b = float(b)
        result = num_a + num_b
        return f"The sum of {num_a} and {num_b} is {result}."
    except (TypeError, ValueError):
        return f"Error: Could not add '{a}' and '{b}'. Both arguments must be valid numbers."
    except Exception as exc:
        return f"Error performing addition: {exc}"


TOOL_SPECS: List[Dict[str, Any]] = [
    {
        "name": "add",
        "description": "Calculates the sum of two numbers.",
        "parameters": {
            "a": {"type": "number", "description": "First addend."},
            "b": {"type": "number", "description": "Second addend."}
        },
        "handler": tool_add,
    },
    {
        "name": "search",
        "description": "Retrieves top results from Google Custom Search for a query.",
        "parameters": {
            "query": {"type": "string", "description": "Search query string."}
        },
        "handler": search,
    },
    {
        "name": "scrape",
        "description": "Fetches and extracts readable text from a webpage using trafilatura.",
        "parameters": {
            "url": {"type": "string", "description": "Fully qualified URL to scrape."}
        },
        "handler": scrape,
    },
]


TOOL_REGISTRY: Dict[str, Callable[..., Union[str, Dict[str, Any]]]] = {
    spec["name"]: spec["handler"] for spec in TOOL_SPECS
}


TOOL_DEFINITIONS: List[Dict[str, Any]] = [
    {
        "name": spec["name"],
        "description": spec["description"],
        "parameters": spec["parameters"],
    }
    for spec in TOOL_SPECS
]

# Example usage (optional, for testing)
if __name__ == "__main__":
    search_query = "what is a capybara"
    print(search(search_query))
    print("-" * 20)
    print(tool_add(2, 3))