import json
import os
from typing import List, Dict, Union, Callable, Any

import requests
import yaml

from bs4 import BeautifulSoup
import trafilatura


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
        result = trafilatura.bare_extraction(downloaded)
    except Exception as exc:
        print(f"Error extracting content from '{url}': {exc}")
        return f"Error extracting content: {exc}"

    def _normalize_extraction(data: Any) -> tuple[str, str]:
        text_value = ""
        description_value = ""

        if isinstance(data, dict):
            text_value = (data.get("text") or "").strip()
            description_value = (
                data.get("description")
                or data.get("title")
                or ""
            ).strip()
        elif isinstance(data, str):
            text_value = data.strip()
        elif data is not None and hasattr(data, "text_content"):
            try:
                text_value = data.text_content().strip()
            except Exception:
                text_value = ""

        return text_value, description_value

    text, description = _normalize_extraction(result)

    if not text:
        try:
            json_payload = trafilatura.extract(
                downloaded,
                output_format="json",
                include_comments=False,
                include_tables=False,
            )
        except Exception as exc:
            print(f"Fallback JSON extraction failed for '{url}': {exc}")
            json_payload = None

        if json_payload:
            try:
                json_data = json.loads(json_payload)
            except json.JSONDecodeError:
                json_data = None

            if isinstance(json_data, dict):
                text, metadata_description = _normalize_extraction(json_data)
                if metadata_description:
                    description = description or metadata_description

    if not text:
        try:
            fallback_text = trafilatura.extract(downloaded)
            if isinstance(fallback_text, str):
                text = fallback_text.strip()
        except Exception as exc:
            print(f"Fallback plain extraction failed for '{url}': {exc}")

    if not text:
        return "No extractable content found at the provided URL."

    if len(text) <= 4096:
        return text

    # Provide a short summary when the content exceeds the maximum length.
    excerpt = text[:100].strip()
    summary_lines = [
        "Summary (content truncated because it exceeded 4096 characters)."
    ]
    if description:
        summary_lines.append(f"Description: {description}")
    if excerpt:
        summary_lines.append(f"Excerpt: {excerpt}...")

    return "\n".join(summary_lines)


def get_lesswrong_post(url: str) -> str:
    """Fetch the main LessWrong post content (title and body) without comments or sidebar."""
    if not url or not isinstance(url, str):
        return "Error: URL must be a non-empty string."

    if BeautifulSoup is None:
        return "Error: BeautifulSoup (bs4) is not installed."

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    }

    try:
        response = requests.get(url, headers=headers, timeout=15)
        response.raise_for_status()
    except requests.exceptions.RequestException as exc:
        print(f"Error fetching LessWrong post '{url}': {exc}")
        return f"Error fetching LessWrong post: {exc}"

    soup = BeautifulSoup(response.text, "html.parser")

    title_elem = soup.find("h1", class_="PostsPageTitle-title")
    title = title_elem.get_text(strip=True) if title_elem else ""

    post_content = soup.find("div", class_=lambda value: value and "PostsPage-postContent" in value)
    if not post_content:
        post_content = soup.find("div", class_="PostsPage-postBody")

    if not post_content:
        return "Error: Could not find post content on the LessWrong page."

    body = post_content.get_text(separator="\n\n", strip=True)

    if title:
        return f"{title}\n\n{body}" if body else title
    return body or "Error: Post content was empty."


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


def python_interpreter(code: str) -> str:
    """
    Execute Python code in a REPL-like environment and return the output.
    
    The last expression in the code will be automatically returned as output,
    similar to a Jupyter notebook or Python REPL. Images (matplotlib plots, PIL images)
    are automatically captured and returned as base64-encoded data.
    
    Arguments:
        code (str): The Python code to execute.
    
    Returns:
        str: The output from executing the code. Can include:
             - The value of the last expression
             - Any printed output (stdout)
             - Base64-encoded images prefixed with [IMAGE:base64:...]
             - Error messages if execution fails
    """
    import subprocess
    import sys
    import tempfile
    import os
    
    if not code or not isinstance(code, str):
        return "Error: Code must be a non-empty string."
    
    code = code.strip()
    if not code:
        return "Error: Code cannot be empty."
    
    # Create temp directory for our files
    temp_dir = tempfile.mkdtemp()
    user_code_file = os.path.join(temp_dir, 'user_code.py')
    wrapper_file = os.path.join(temp_dir, 'wrapper.py')
    
    try:
        # Write user code to a separate file
        with open(user_code_file, 'w', encoding='utf-8') as f:
            f.write(code)
        
        # Wrapper script that reads and executes the user code
        wrapper_code = f'''
import sys
import io
import base64
import ast
import traceback

# Redirect stdout to capture prints
_stdout_capture = io.StringIO()
_original_stdout = sys.stdout
sys.stdout = _stdout_capture

_result = None
_images = []

def _capture_matplotlib():
    """Capture any matplotlib figures as base64 images."""
    try:
        import matplotlib
        matplotlib.use('Agg')  # Use non-interactive backend
        import matplotlib.pyplot as plt
        figs = [plt.figure(i) for i in plt.get_fignums()]
        for fig in figs:
            buf = io.BytesIO()
            fig.savefig(buf, format='png', bbox_inches='tight', dpi=100)
            buf.seek(0)
            img_base64 = base64.b64encode(buf.read()).decode('utf-8')
            _images.append(img_base64)
            buf.close()
        plt.close('all')
    except ImportError:
        pass
    except Exception as e:
        print(f"[Warning: Could not capture matplotlib figure: {{e}}]", file=_original_stdout)

def _encode_pil_image(img):
    """Encode a PIL image to base64."""
    try:
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        buf.seek(0)
        return base64.b64encode(buf.read()).decode('utf-8')
    except Exception as e:
        return None

def _is_pil_image(obj):
    """Check if an object is a PIL Image."""
    try:
        from PIL import Image
        return isinstance(obj, Image.Image)
    except ImportError:
        return False

try:
    # Read the user code from file
    with open({repr(user_code_file)}, 'r', encoding='utf-8') as f:
        _user_code = f.read()
    
    try:
        _tree = ast.parse(_user_code)
    except SyntaxError as e:
        print(f"SyntaxError: {{e}}", file=_original_stdout)
        sys.exit(1)
    
    # Check if last statement is an expression (not assignment, etc.)
    _last_expr = None
    if _tree.body and isinstance(_tree.body[-1], ast.Expr):
        _last_expr = _tree.body.pop()
    
    # Execute all statements except the last expression
    _exec_code = compile(ast.Module(body=_tree.body, type_ignores=[]), '<code>', 'exec')
    _globals = {{'__name__': '__main__', '__builtins__': __builtins__}}
    exec(_exec_code, _globals)
    
    # Evaluate the last expression if it exists
    if _last_expr is not None:
        _eval_code = compile(ast.Expression(body=_last_expr.value), '<expr>', 'eval')
        _result = eval(_eval_code, _globals)
    
    # Check for matplotlib figures - but only if result is not already a figure
    # (to avoid duplicate capture when user returns fig explicitly)
    _is_mpl_figure = False
    try:
        import matplotlib.figure
        _is_mpl_figure = isinstance(_result, matplotlib.figure.Figure)
    except ImportError:
        pass
    
    if not _is_mpl_figure:
        _capture_matplotlib()
    
except Exception as e:
    sys.stdout = _original_stdout
    traceback.print_exc()
    sys.exit(1)

# Restore stdout
sys.stdout = _original_stdout

# Build output
_output_parts = []

# Add captured stdout
_stdout_text = _stdout_capture.getvalue()
if _stdout_text:
    _output_parts.append(_stdout_text.rstrip())

# Add images
for img_b64 in _images:
    _output_parts.append(f"[IMAGE:base64:{{img_b64}}]")

# Add last expression result
if _result is not None:
    if _is_pil_image(_result):
        img_b64 = _encode_pil_image(_result)
        if img_b64:
            _output_parts.append(f"[IMAGE:base64:{{img_b64}}]")
        else:
            _output_parts.append(repr(_result))
    else:
        # Check if result is a matplotlib figure
        try:
            import matplotlib.figure
            if isinstance(_result, matplotlib.figure.Figure):
                buf = io.BytesIO()
                _result.savefig(buf, format='png', bbox_inches='tight', dpi=100)
                buf.seek(0)
                img_b64 = base64.b64encode(buf.read()).decode('utf-8')
                _output_parts.append(f"[IMAGE:base64:{{img_b64}}]")
                buf.close()
            else:
                _output_parts.append(repr(_result))
        except ImportError:
            _output_parts.append(repr(_result))

if _output_parts:
    print("\\n".join(_output_parts))
else:
    print("(No output)")
'''
        
        # Write wrapper code
        with open(wrapper_file, 'w', encoding='utf-8') as f:
            f.write(wrapper_code)
        
        # Run the wrapper code with a timeout
        result = subprocess.run(
            [sys.executable, wrapper_file],
            capture_output=True,
            text=True,
            timeout=30,  # 30 second timeout
            cwd=temp_dir
        )
        
        output_parts = []
        if result.stdout:
            output_parts.append(result.stdout)
        if result.stderr:
            output_parts.append(f"STDERR:\n{result.stderr}")
        
        output = "\n".join(output_parts).strip()
        
        if not output:
            output = "(No output)"
        
        if result.returncode != 0 and "Error" not in output and "Traceback" not in output:
            output = f"Exit code: {result.returncode}\n{output}"
        
        return output
        
    except subprocess.TimeoutExpired:
        return "Error: Code execution timed out (30 second limit)."
    except Exception as exc:
        return f"Error executing Python code: {exc}"
    finally:
        # Clean up temporary files
        import shutil
        try:
            if 'temp_dir' in locals():
                shutil.rmtree(temp_dir, ignore_errors=True)
        except:
            pass


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
    {
        "name": "get_lesswrong_post",
        "description": "Retrieves the title and main body content from a LessWrong post (no comments).",
        "parameters": {
            "url": {"type": "string", "description": "Fully qualified LessWrong post URL."}
        },
        "handler": get_lesswrong_post,
    },
    {
        "name": "python_interpreter",
        "description": """Execute Python code in a REPL-like environment. 
The last expression is automatically returned (like Jupyter/REPL). 
Images (matplotlib plots, PIL images) are captured and displayed to the user.
When an image is generated, the output will show "[image]" - this means the image was successfully created and displayed.

Examples:
- `2 + 2` returns `4`
- `x = 5\nx * 2` returns `10`  
- For matplotlib, return the figure object (don't use plt.show()):
  ```
  fig, ax = plt.subplots()
  ax.plot([1,2,3])
  fig
  ```
  Output: [image] (means the plot was displayed successfully)
- `from PIL import Image\nimg = Image.new('RGB', (100,100), 'red')\nimg` shows the image

Use for: calculations, data analysis, generating charts/plots, image manipulation, or any Python task.""",
        "parameters": {
            "code": {"type": "string", "description": "The Python code to execute. The last expression's value is returned."}
        },
        "handler": python_interpreter,
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


def convert_tools_to_openai_format(tool_definitions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Converts internal TOOL_DEFINITIONS format to OpenAI/MCP-compatible tools array.
    
    Input format (internal):
    {
        "name": "add",
        "description": "Calculates the sum of two numbers.",
        "parameters": {
            "a": {"type": "number", "description": "First addend."},
            "b": {"type": "number", "description": "Second addend."}
        }
    }
    
    Output format (OpenAI/MCP):
    {
        "type": "function",
        "function": {
            "name": "add",
            "description": "Calculates the sum of two numbers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "a": {"type": "number", "description": "First addend."},
                    "b": {"type": "number", "description": "Second addend."}
                },
                "required": ["a", "b"]
            }
        }
    }
    """
    openai_tools = []
    
    for tool_def in tool_definitions:
        name = tool_def.get("name", "")
        description = tool_def.get("description", "")
        params = tool_def.get("parameters", {})
        
        # Build OpenAI-style parameters schema
        properties = {}
        required = []
        
        for param_name, param_info in params.items():
            param_type = param_info.get("type", "string")
            param_desc = param_info.get("description", "")
            
            properties[param_name] = {
                "type": param_type,
                "description": param_desc
            }
            
            # Assume all parameters are required unless marked optional
            if not param_info.get("optional", False):
                required.append(param_name)
        
        openai_tool = {
            "type": "function",
            "function": {
                "name": name,
                "description": description,
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": required
                }
            }
        }
        
        openai_tools.append(openai_tool)
    
    return openai_tools


# Pre-computed OpenAI format tools for efficiency
TOOLS_OPENAI_FORMAT: List[Dict[str, Any]] = convert_tools_to_openai_format(TOOL_DEFINITIONS)


# Example usage (optional, for testing)
if __name__ == "__main__":
    search_query = "what is a capybara"
    print(search(search_query))
    print("-" * 20)
    print(tool_add(2, 3))