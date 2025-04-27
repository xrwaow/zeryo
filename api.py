# api.py
import base64
import json
import os
import time
import uuid
import yaml
import sqlite3
import httpx # <-- NEW: For async requests to LLM providers
import asyncio # <-- NEW: For cancellation
from enum import Enum
from contextlib import asynccontextmanager
from typing import List, Dict, Any, Optional, Union, AsyncGenerator
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse # <-- NEW: For SSE
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError
import traceback # <-- NEW: For detailed error logging
import re # Add 're' import at the top of the file
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="Chat Data API")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Allow frontend origin
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load configurations
def load_config(file_path):
    if os.path.exists(file_path):
        with open(file_path, 'r') as f:
            return yaml.safe_load(f)
    return {}

api_keys_config = load_config('api_keys.yaml') # Raw keys NOT sent to frontend
model_configs = load_config('model_config.yaml')

# Database setup (Same as before)
DB_PATH = "chat_db_branching.sqlite"

def get_db_connection():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA busy_timeout = 5000;")
    except Exception as e:
        print(f"Warning: Could not set WAL mode or busy_timeout: {e}")
    return conn

# --- Database Initialization (Add tool_calls column) ---
def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()
    # --- Schema definitions ---
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS chats (
        chat_id TEXT PRIMARY KEY,
        timestamp_created INTEGER,
        timestamp_updated INTEGER,
        character_id TEXT,
        FOREIGN KEY (character_id) REFERENCES characters (character_id) ON DELETE SET NULL
    )
    ''')
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        chat_id TEXT,
        role TEXT, -- user, llm, tool
        message TEXT,
        model_name TEXT, -- Store the model used for the response
        timestamp INTEGER,
        parent_message_id TEXT,
        active_child_index INTEGER DEFAULT 0,
        tool_call_id TEXT, -- Optional: Store ID if this is a tool result message OR the ID of the call made by an assistant msg
        tool_calls TEXT, -- Optional: Store LLM's requested tool calls (JSON) for assistant messages
        FOREIGN KEY (chat_id) REFERENCES chats (chat_id) ON DELETE CASCADE,
        FOREIGN KEY (parent_message_id) REFERENCES messages (message_id) ON DELETE CASCADE
    )
    ''')
    # Add columns if they don't exist (simple migration)
    try: cursor.execute("ALTER TABLE messages ADD COLUMN tool_call_id TEXT")
    except sqlite3.OperationalError: pass
    try: cursor.execute("ALTER TABLE messages ADD COLUMN tool_calls TEXT") # Ensure this is added
    except sqlite3.OperationalError: pass

    cursor.execute('''
    CREATE TABLE IF NOT EXISTS attachments (
        attachment_id TEXT PRIMARY KEY,
        message_id TEXT,
        type TEXT, -- 'image', 'file'
        content TEXT, -- Base64 for image, formatted text for file
        name TEXT,
        FOREIGN KEY (message_id) REFERENCES messages (message_id) ON DELETE CASCADE
    )
    ''')
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS characters (
        character_id TEXT PRIMARY KEY,
        character_name TEXT UNIQUE,
        sysprompt TEXT,
        settings TEXT -- JSON string for future use
    )
    ''')
    # --- Indexes ---
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages (chat_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_messages_parent_id ON messages (parent_message_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments (message_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chats_timestamp_updated ON chats (timestamp_updated DESC)")
    conn.commit()
    conn.close()

TOOL_CALL_REGEX = re.compile(r'<tool\s+name="(\w+)"((?:\s+\w+="[^"]*")+)\s*\/>')

ACTIVE_GENERATIONS: Dict[str, asyncio.Event] = {}

init_db()

# Pydantic models
class MessageRole(str, Enum):
    USER = "user"
    LLM = "llm"
    SYSTEM = "system"
    TOOL = "tool"

class AttachmentType(str, Enum):
    IMAGE = "image"
    FILE = "file"

class Attachment(BaseModel):
    type: AttachmentType
    content: str
    name: Optional[str] = None

class Message(BaseModel):
    message_id: str
    chat_id: str
    role: MessageRole
    message: str
    model_name: Optional[str] = None
    timestamp: int
    parent_message_id: Optional[str] = None
    active_child_index: int = 0
    attachments: List[Attachment] = []
    child_message_ids: List[str] = []
    tool_call_id: Optional[str] = None
    tool_calls: Optional[Any] = None


class AddMessageRequest(BaseModel):
    role: MessageRole
    message: str
    attachments: List[Attachment] = []
    parent_message_id: Optional[str] = None
    model_name: Optional[str] = None
    tool_call_id: Optional[str] = None
    tool_calls: Optional[Any] = None


class EditMessageRequest(BaseModel):
    message: str
    model_name: Optional[str] = None
    attachments: List[Attachment] = []
    tool_calls: Optional[Any] = None


class Chat(BaseModel):
    chat_id: str
    messages: List[Message]
    timestamp_created: int
    timestamp_updated: int
    character_id: Optional[str] = None

class ChatListItem(BaseModel):
    chat_id: str
    preview: str
    timestamp_updated: int

class NewChatRequest(BaseModel):
    character_id: Optional[str] = None

class SetActiveCharacterRequest(BaseModel):
    character_id: Optional[str] = None

class Character(BaseModel):
    character_name: str
    sysprompt: str
    settings: Optional[Dict[str, Any]] = {}

class UpdateCharacterRequest(Character):
    pass

class SetActiveBranchRequest(BaseModel):
    child_index: int

class ExecuteToolRequest(BaseModel):
    tool_name: str
    arguments: Dict[str, Any]

class ToolDefinition(BaseModel):
    name: str
    description: str
    parameters: Dict[str, Any]

class GenerateRequest(BaseModel):
    parent_message_id: str
    model_name: str
    generation_args: Optional[Dict[str, Any]] = {} # e.g., temperature, max_tokens
    tools_enabled: bool = False # <-- NEW field with default

# --- Tool Implementation ---
import tools

def tool_add(a: Union[float, str], b: Union[float, str]) -> str:
    """
    Calculates the sum of two numbers, a and b.
    Use this tool whenever you need to perform addition.
    Arguments:
        a (int): The first number.
        b (int): The second number.
    """
    try:
        num_a = float(a)
        num_b = float(b)
        result = num_a + num_b
        return f"The sum of {num_a} and {num_b} is {result}."
    except ValueError:
        return f"Error: Could not add '{a}' and '{b}'. Both arguments must be valid numbers."
    except Exception as e:
        return f"Error performing addition: {e}"


# --- Tool Registry and Descriptions ---
from tools import search

TOOL_REGISTRY = {
    "add": tool_add,
    "search": search,
}

TOOLS_AVAILABLE: List[ToolDefinition] = [
    ToolDefinition(
        name="add",
        description=tool_add.__doc__.strip().split('\n')[0], # First line
        parameters={
            "a": {"type": "int", "description": "The first number"},
            "b": {"type": "int", "description": "The second number"}
        }
    ),
    ToolDefinition(
        name="search",
        description=search.__doc__.strip().split('\n')[0],
        parameters={
            "query": {"type": "str", "description": "The search query string."}
        }
    ),
]

def format_tools_for_prompt(tools: List[ToolDefinition]) -> str:
    """ Formats tool definitions into a string for the system prompt. """
    if not tools:
        return ""

    prompt = "You have access to the following tools. Use them when appropriate by emitting XML-like tags:\n"
    prompt += "<tools>\n"
    for tool in tools:
        prompt += f'  <tool name="{tool.name}" description="{tool.description}">\n'
        prompt += "    <parameters>\n"
        for param_name, param_info in tool.parameters.items():
             prompt += f'      <parameter name="{param_name}" type="{param_info.get("type", "any")}" description="{param_info.get("description", "")}" />\n'
        prompt += "    </parameters>\n"
        # *** FIXED: Simplified and corrected example usage string generation ***
        param_examples = " ".join([f'{p}="[value]"' for p in tool.parameters])
        prompt += f'    Example Usage: <tool name="{tool.name}" {param_examples} />\n'
        prompt += "  </tool>\n"
    prompt += "</tools>\n"
    prompt += "Only use the tools listed above. Format your tool usage exactly as shown in the example usage."
    return prompt


# Database Helper Functions

def build_context_from_db(
    conn: sqlite3.Connection,
    cursor: sqlite3.Cursor,
    chat_id: str,
    stop_at_message_id: str, # This is the ID of the *last message to include*
    system_prompt: Optional[str] = None
) -> List[Dict[str, Any]]:
    """
    Fetches message history from DB up to and including the stop_at_message_id,
    formats it for LLM context, including attachments, tool calls/results,
    and excluding <think> blocks from final output.
    """
    context = []
    messages_map = {} # message_id -> {data, attachments, children_ids, active_child_index}

    # Fetch all messages for the chat to build the tree structure
    # Order by timestamp is crucial for reconstructing branches correctly
    cursor.execute("SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp", (chat_id,))
    all_messages_data = cursor.fetchall()

    if not all_messages_data:
        if system_prompt:
            context.append({"role": "system", "message": system_prompt, "attachments": []})
        return context

    # Populate map and identify roots
    root_ids = []
    for msg_data in all_messages_data:
        msg_id = msg_data["message_id"]
        cursor.execute("SELECT type, content, name FROM attachments WHERE message_id = ?", (msg_id,))
        attachments = [{"type": row["type"], "content": row["content"], "name": row["name"]} for row in cursor.fetchall()]

        # Deserialize tool_calls JSON string back into a list/dict
        tool_calls_data = None
        if msg_data["tool_calls"]:
            try: tool_calls_data = json.loads(msg_data["tool_calls"])
            except json.JSONDecodeError: print(f"Warning: Could not parse tool_calls JSON for msg {msg_id}")

        messages_map[msg_id] = {
            "data": dict(msg_data),
            "attachments": attachments,
            "children_ids": [],
            "active_child_index": msg_data["active_child_index"] or 0,
            "tool_calls_deserialized": tool_calls_data, # Store deserialized version
            "tool_call_id": msg_data["tool_call_id"] # Store tool_call_id
        }
        parent_id = msg_data["parent_message_id"]
        if parent_id and parent_id in messages_map:
            messages_map[parent_id]["children_ids"].append(msg_id)
        elif not parent_id:
            root_ids.append(msg_id)

    # Add system prompt first if provided
    if system_prompt:
        context.append({"role": "system", "message": system_prompt, "attachments": []})

    processed_ids = set()

    def traverse_active(message_id: str) -> bool:
        """Recursively traverses the active branch, adding messages to context."""
        if not message_id or message_id not in messages_map or message_id in processed_ids:
            return False # Stop if invalid ID, not found, or already processed in this path

        node = messages_map[message_id]
        msg = node["data"]
        msg_attachments = node["attachments"]
        msg_tool_calls = node["tool_calls_deserialized"] # Use deserialized
        msg_tool_call_id = node["tool_call_id"] # Get the ID
        processed_ids.add(message_id)

        role_for_context = msg["role"] # user, llm, tool
        content_for_context = msg["message"] or ''

        # Strip <think> blocks from LLM messages before adding to context
        is_llm = role_for_context == 'llm'
        think_pattern = r"<think>.*?</think>\s*"
        if is_llm and "<think>" in content_for_context:
            content_for_context = re.sub(think_pattern, "", content_for_context, flags=re.DOTALL).strip()
            # print(f"Stripped think block from message {message_id} for context")

        # Map internal roles to standard API roles ('llm' -> 'assistant')
        context_role = "assistant" if role_for_context == "llm" else role_for_context

        context_entry = {
            "role": context_role,
            "message": content_for_context if content_for_context else None,
            "attachments": msg_attachments, # Include attachments
            # Include tool data based on role
            "tool_calls": msg_tool_calls if context_role == "assistant" else None,
            "tool_call_id": msg_tool_call_id if context_role == "tool" else None,
        }

        # --- Refine context_entry based on role and content ---
        # Ensure tool messages have content (the result) and tool_call_id
        if context_role == "tool":
            if not context_entry["message"]: context_entry["message"] = "[Tool Execution Result Missing]" # Add placeholder if empty
            if not context_entry["tool_call_id"]: print(f"Warning: Tool message {message_id} missing tool_call_id in context.")
        # Ensure assistant messages making tool calls have the tool_calls structure
        if context_role == "assistant" and context_entry["tool_calls"]:
             if context_entry["message"] is None: context_entry["message"] = "" # Ensure content isn't null if tool_calls present
        # Ensure assistant messages *not* making calls don't have empty tool_calls field
        if context_role == "assistant" and not context_entry["tool_calls"]:
             context_entry.pop("tool_calls", None) # Remove key if null/empty

        # Remove tool_call_id if not a tool message
        if context_role != "tool": context_entry.pop("tool_call_id", None)
        # Remove attachments if empty
        if not context_entry["attachments"]: context_entry.pop("attachments", None)
        # Remove message if None (unless tool calls are present)
        if context_entry["message"] is None and not context_entry.get("tool_calls"):
             context_entry.pop("message", None)

        # Add the potentially refined entry to context if it's not entirely empty
        if context_entry.get("message") is not None or \
           context_entry.get("attachments") or \
           context_entry.get("tool_calls"):
            context.append(context_entry)
        else:
            print(f"Skipping empty context entry for message {message_id}")


        # Stop condition: We've processed the target message
        if message_id == stop_at_message_id:
            print(f"Context build reached and included stop message: {message_id}")
            return True # Found the target message

        # Recurse to the active child
        active_child_id = None
        if node["children_ids"]:
            # Re-fetch sorted children to be sure index is correct relative to timestamp
            cursor.execute("SELECT message_id FROM messages WHERE parent_message_id = ? ORDER BY timestamp", (message_id,))
            sorted_children_ids = [row['message_id'] for row in cursor.fetchall()]
            if sorted_children_ids:
                 child_index = min(max(0, node["active_child_index"]), len(sorted_children_ids) - 1)
                 active_child_id = sorted_children_ids[child_index]

        if active_child_id:
            # Before recursing, check if the child is the stop message
            if traverse_active(active_child_id):
                return True # Propagate the 'found' signal up

        return False # Stop message not found down this path

    # Start traversal from all roots, stop if target message is found
    for root_id in root_ids:
        if traverse_active(root_id):
            break

    print(f"Built context with {len(context)} entries for chat {chat_id}, stopping at {stop_at_message_id}.")
    # print("Final context sample:", json.dumps(context[-3:], indent=2)) # Debug: print last few entries
    return context

# (NEW) Database Helper Function
def save_assistant_message_tx(
    conn: sqlite3.Connection, # Use existing connection/cursor
    cursor: sqlite3.Cursor,
    chat_id: str,
    content: str,
    parent_message_id: Optional[str],
    model_name: Optional[str],
    message_id_to_edit: Optional[str] = None # If editing an existing partial save
) -> str:
    """
    Saves or updates an assistant message within an existing transaction.
    Returns the message_id (new or edited).
    """
    timestamp = int(time.time() * 1000)
    role = MessageRole.LLM

    if message_id_to_edit:
        # Update existing message (likely a partial save)
        cursor.execute(
            """UPDATE messages SET message = ?, model_name = ?, timestamp = ?
               WHERE message_id = ? AND chat_id = ? AND role = ?""",
            (content, model_name, timestamp, message_id_to_edit, chat_id, role.value)
        )
        message_id = message_id_to_edit
        print(f"Updated assistant message {message_id} in transaction.")
    else:
        # Insert new message
        message_id = str(uuid.uuid4())
        cursor.execute(
            """INSERT INTO messages
               (message_id, chat_id, role, message, model_name, timestamp, parent_message_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (message_id, chat_id, role.value, content, model_name, timestamp, parent_message_id)
        )
        print(f"Inserted new assistant message {message_id} in transaction.")

        # Update parent's active child index
        if parent_message_id:
            try:
                cursor.execute("SELECT message_id FROM messages WHERE parent_message_id = ? ORDER BY timestamp", (parent_message_id,))
                children_ids = [row['message_id'] for row in cursor.fetchall()]
                new_idx = children_ids.index(message_id) if message_id in children_ids else len(children_ids) - 1
                cursor.execute("UPDATE messages SET active_child_index = ? WHERE message_id = ?", (new_idx, parent_message_id))
            except Exception as update_err:
                print(f"Warning: Failed to update parent active index during save_assistant_message_tx: {update_err}")

    # Update chat timestamp
    cursor.execute("UPDATE chats SET timestamp_updated = ? WHERE chat_id = ?", (timestamp, chat_id))
    return message_id

# (Replace the existing format_messages_for_provider function with this one)
def format_messages_for_provider(messages: List[Dict[str, Any]], provider: str) -> List[Dict[str, Any]]:
    """
    Formats an array of internal message objects (including attachments)
    into the structure required by a specific LLM provider.
    """
    formatted = []
    provider_lower = provider.lower()
    print(f"Formatting {len(messages)} messages for provider: {provider_lower}")

    for msg in messages:
        internal_role = msg.get("role") # user, llm, system, tool
        content = msg.get("message") # Text content
        attachments = msg.get("attachments", []) # List of {type, content, name}
        tool_calls = msg.get("tool_calls") # For native tool use
        tool_call_id = msg.get("tool_call_id") # For native tool use

        # --- Role Mapping ---
        provider_role = internal_role
        if provider_lower == 'google':
            if internal_role == 'assistant' or internal_role == 'llm': provider_role = 'model'
            elif internal_role == 'system': continue # Skip system for Google's message list
            elif internal_role == 'tool': provider_role = 'function' # Google uses 'function' for tool results
        elif provider_lower in ['openrouter', 'local', 'openai']: # OpenAI / Compatible
            if internal_role == 'llm': provider_role = 'assistant'
            # System prompt IS part of the messages list
            # Tool role is 'tool'
        else: # Default to OpenAI compatible
             if internal_role == 'llm': provider_role = 'assistant'

        # --- Content Formatting (Handles Text, Images, Files) ---
        content_parts = []
        final_message_obj = {"role": provider_role}

        # 1. Add Text Part
        if content:
            if provider_lower == 'google':
                content_parts.append({"text": content})
            else: # OpenAI / Compatible
                content_parts.append({"type": "text", "text": content})

        # 2. Add Attachment Parts
        files_content_buffer = "" # Buffer to combine text file contents
        image_attachments = []
        for attachment in attachments:
            if attachment['type'] == 'image':
                # Handle image data based on provider
                if attachment['content']: # Ensure content exists
                    image_attachments.append(attachment) # Collect images first
                else:
                    print(f"Warning: Skipping image attachment with missing content (Name: {attachment.get('name', 'N/A')})")
            elif attachment['type'] == 'file':
                # Append formatted file content to buffer
                if attachment['content']:
                     files_content_buffer += f"\n\n--- Attached File: {attachment.get('name', 'file')} ---\n{attachment['content']}\n--- End File ---"
                else:
                     print(f"Warning: Skipping file attachment with missing content (Name: {attachment.get('name', 'N/A')})")

        # Append buffered file content to the last text part or add a new one
        if files_content_buffer:
            if provider_lower == 'google':
                # Find last part that has 'text' key
                last_text_part = next((part for part in reversed(content_parts) if 'text' in part), None)
                if last_text_part:
                    last_text_part['text'] += files_content_buffer
                else:
                    content_parts.append({"text": files_content_buffer.lstrip()}) # Add as new part
            else: # OpenAI / Compatible
                # Find last part with type 'text'
                last_text_part = next((part for part in reversed(content_parts) if part.get('type') == 'text'), None)
                if last_text_part:
                    last_text_part['text'] += files_content_buffer
                else:
                    content_parts.append({"type": "text", "text": files_content_buffer.lstrip()}) # Add as new part

        # Add collected image attachments
        for img_attachment in image_attachments:
             img_content = img_attachment['content']
             if provider_lower == 'google':
                 content_parts.append({"inline_data": {"mime_type": "image/jpeg", "data": img_content}})
             else: # OpenAI / Compatible
                 # Assume JPEG for now, could be enhanced to detect mime type if needed
                 content_parts.append({
                     "type": "image_url",
                     "image_url": {"url": f"data:image/jpeg;base64,{img_content}"}
                 })

        # 3. Assign Content/Parts and Tool Info to Final Object
        if provider_lower == 'google':
            if content_parts:
                final_message_obj["parts"] = content_parts
            # Handle Google function calls/responses if using native tools (requires specific structure)
            # Example for function call result: role='function', parts=[{function_response: {name: ..., response: ...}}]
            # This example assumes manual tool handling where result is in 'message'
            elif provider_role == 'function': # Handle tool results added manually to context
                 # Need to know the tool name if mapping to Google's native format
                 # For manual flow, the result is likely just text, add it as such
                  if content: # If result text was stored in 'message'
                       final_message_obj["parts"] = [{"text": f"[Tool Result]: {content}"}] # Simple text representation
                  else:
                       print(f"Warning: Skipping Google function role message with no content.")
                       continue # Skip empty function result message
            else:
                # Skip message if no parts and not a function call placeholder
                 print(f"Warning: Skipping Google message with no parts (Role: {provider_role})")
                 continue # Skip empty messages

        else: # OpenAI / Compatible
            if content_parts:
                # Use array content if multiple parts (text + images), otherwise just string for text-only
                if len(content_parts) > 1:
                    final_message_obj["content"] = content_parts
                elif len(content_parts) == 1 and content_parts[0]['type'] == 'text':
                     final_message_obj["content"] = content_parts[0]['text']
                elif len(content_parts) == 1 and content_parts[0]['type'] == 'image_url':
                     # API might require text part even if empty? Check specs.
                     # Sending as array is safer for multimodal.
                     final_message_obj["content"] = content_parts
                else: # Should not happen if logic is correct
                     final_message_obj["content"] = None

            # Add native tool calls (assistant asks to call tools)
            if provider_role == 'assistant' and tool_calls:
                 if final_message_obj.get("content") is None: final_message_obj["content"] = "" # Some models might require non-null content with tool_calls
                 final_message_obj["tool_calls"] = tool_calls

            # Add native tool result message
            elif provider_role == 'tool':
                 # Requires content (result string) and tool_call_id
                 if not content and attachments: # If result was only in attachment? Unlikely for tools.
                      print("Warning: Tool message has no text content, using placeholder.")
                      final_message_obj["content"] = "[Tool result data in attachment]" # Placeholder
                 elif not content:
                      print("Warning: Tool message has no text content, skipping.")
                      continue
                 else:
                     final_message_obj["content"] = content # Content is the tool result string

                 if not tool_call_id:
                      print(f"Warning: Tool message missing tool_call_id.")
                      # Cannot send without tool_call_id for native flow, skip?
                      # continue # This would break manual flow where ID might not be tracked.
                      # For manual flow, we shouldn't hit role='tool' formatted this way.
                 else:
                      final_message_obj["tool_call_id"] = tool_call_id

            # Handle system message (content is string)
            elif provider_role == 'system':
                 final_message_obj["content"] = content # System prompt is plain text

            # Skip message if it ended up with no content and no tool calls
            elif final_message_obj.get("content") is None and not tool_calls:
                 print(f"Warning: Skipping OpenAI message with no content/tool_calls (Role: {provider_role})")
                 continue

        formatted.append(final_message_obj)

    # --- Provider Specific Cleaning (Optional but good practice) ---
    # (Keep existing cleaning logic - removing consecutive identical roles etc.)
    cleaned = []
    last_role = None
    for i, msg in enumerate(formatted):
        current_role = msg.get("role")
        # Allow assistant followed by tool, or tool followed by assistant (for native flow)
        is_tool_assistant_sequence = (last_role == 'assistant' and current_role == 'tool') or \
                                     (last_role == 'tool' and current_role == 'assistant')

        if i > 0 and current_role == last_role and not is_tool_assistant_sequence:
             # Don't remove consecutive user/model for Google - it expects alternation
             if provider_lower == 'google' and current_role in ['user', 'model']:
                 pass # Allow but warn later if needed
             elif current_role != 'system': # Allow multiple system prompts? Maybe not.
                 print(f"Warning: Skipping consecutive message with role {current_role}")
                 continue

        # Example: Ensure Google alternates user/model (Warn only)
        if provider_lower == 'google':
            if last_role == 'model' and current_role not in ['user', 'function']: # Allow function after model
                print(f"Warning: Google API often expects user message after model message. Got {current_role}.")
            if last_role == 'user' and current_role not in ['model']:
                 print(f"Warning: Google API often expects model message after user message. Got {current_role}.")
            if last_role == 'function' and current_role not in ['model']:
                 print(f"Warning: Google API often expects model message after function message. Got {current_role}.")


        cleaned.append(msg)
        last_role = current_role

    # Final check: Google API might complain if the last message is 'model'
    if provider_lower == 'google' and cleaned and cleaned[-1].get("role") == 'model':
         print("Warning: Last message role is 'model' for Google API request.")

    # print("Formatted message sample:", json.dumps(cleaned[:2], indent=2)) # Debugging
    return cleaned

async def _perform_generation_stream(
    chat_id: str,
    parent_message_id: str,
    model_name: str,
    gen_args: Dict[str, Any],
    tools_enabled: bool,
    abort_event: asyncio.Event
) -> AsyncGenerator[str, None]:
    """
    Performs LLM generation, handles streaming, tool calls, saving distinct messages, and abortion.
    Yields Server-Sent Events (SSE) formatted strings targeting a *single* frontend message bubble.
    """
    conn_check = None # Used only for initial setup checks, not passed around
    full_response_content_for_frontend = "" # Tracks cumulative content sent to frontend this turn
    current_llm_history = []
    stream_error = None
    generation_completed_normally = False
    last_saved_message_id = parent_message_id # Track the ID of the last *saved* message in the sequence
    provider = None
    backend_is_streaming_reasoning = False

    try:
        # Get connection only for initial setup/context building, do not pass to create_message
        conn_check = get_db_connection()
        cursor_check = conn_check.cursor()

        print(f"[Gen Start] Chat: {chat_id}, Parent: {parent_message_id}, Model: {model_name}, Tools: {tools_enabled}")
        cursor_check.execute("SELECT character_id FROM chats WHERE chat_id = ?", (chat_id,))
        chat_info = cursor_check.fetchone()
        if not chat_info: raise HTTPException(status_code=404, detail="Chat not found")

        system_prompt = ""
        if chat_info["character_id"]:
             cursor_check.execute("SELECT sysprompt FROM characters WHERE character_id = ?", (chat_info["character_id"],))
             char_info = cursor_check.fetchone(); system_prompt = char_info["sysprompt"] if char_info else ""

        tool_system_prompt = format_tools_for_prompt(TOOLS_AVAILABLE) if tools_enabled else ""
        effective_system_prompt = (system_prompt + ("\n\n" + tool_system_prompt if tool_system_prompt else "")).strip()

        model_config = get_model_config(model_name)
        if not model_config: raise ValueError(f"Configuration for model '{model_name}' not found.")
        provider = model_config.get('provider', 'openrouter')
        model_identifier = model_config.get('model_identifier', model_name)
        api_details = get_llm_api_details(provider)
        print(f"[Gen Setup] Provider: {provider}, Identifier: {model_identifier}")

        # Build initial context stopping at the parent of the first segment
        current_llm_history = build_context_from_db(conn_check, cursor_check, chat_id, last_saved_message_id, effective_system_prompt)

        # Close the check connection, it's no longer needed
        conn_check.close()
        conn_check = None
        cursor_check = None

        tool_call_count = 0
        max_tool_calls = 5 # Limit recursion

        while tool_call_count < max_tool_calls:
            if abort_event.is_set():
                print(f"[Gen Abort] Before LLM call {tool_call_count + 1} for chat {chat_id}.")
                stream_error = asyncio.CancelledError("Aborted before LLM call")
                break

            print(f"[Gen LLM Call {tool_call_count + 1}] Chat: {chat_id}, History Len: {len(current_llm_history)}")
            llm_messages = format_messages_for_provider(current_llm_history, provider)
            llm_body = {"model": model_identifier, "messages": llm_messages, "stream": True, **gen_args}
            request_url = f"{api_details['base_url'].rstrip('/')}/chat/completions"
            headers = {'Content-Type': 'application/json', 'Accept': 'text/event-stream'}
            if api_details['api_key']: headers['Authorization'] = f"Bearer {api_details['api_key']}"

            current_turn_content_accumulated = "" # Accumulates text *for this specific LLM call*
            detected_tool_call_info = None # Stores {'name': ..., 'arguments': ..., 'raw_tag': ..., 'id': ...}

            try:
                async with httpx.AsyncClient(timeout=600.0) as client:
                    async with client.stream("POST", request_url, json=llm_body, headers=headers) as response:
                        if response.status_code != 200:
                            error_body = await response.aread()
                            detail = f"LLM API Error ({response.status_code})"
                            try: detail += f" - {error_body.decode()}"
                            except Exception: pass
                            raise HTTPException(status_code=response.status_code, detail=detail)

                        async for line in response.aiter_lines():
                            if abort_event.is_set():
                                print(f"[Gen Abort] During LLM stream for chat {chat_id}.")
                                stream_error = asyncio.CancelledError("Aborted by user during stream")
                                break # Exit inner async for loop

                            if not line.startswith("data:"): continue
                            data_str = line[len("data:"):].strip()
                            if data_str == "[DONE]":
                                if backend_is_streaming_reasoning:
                                    yield f"data: {json.dumps({'type': 'chunk', 'data': '</think>\n'})}\n\n"
                                    full_response_content_for_frontend += "</think>\n"
                                    backend_is_streaming_reasoning = False
                                break # Exit inner async for loop
                            if not data_str: continue

                            try:
                                data = json.loads(data_str)
                                content_chunk, reasoning_chunk = None, None
                                potential_tool_calls = None

                                # --- Extract data based on provider ---
                                if provider in ['openrouter', 'local', 'openai']: # OpenAI compatible
                                    delta = data.get("choices", [{}])[0].get("delta", {})
                                    content_chunk = delta.get("content")
                                    reasoning_chunk = delta.get("reasoning")
                                    potential_tool_calls = delta.get("tool_calls")
                                elif provider == 'google':
                                    part = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0]
                                    content_chunk = part.get("text")

                                processed_yield = ""; processed_save = ""

                                if reasoning_chunk:
                                    if not backend_is_streaming_reasoning:
                                        processed_yield = "<think>" + reasoning_chunk; processed_save="<think>" + reasoning_chunk
                                        backend_is_streaming_reasoning = True
                                    else:
                                        processed_yield = reasoning_chunk; processed_save = reasoning_chunk
                                    yield f"data: {json.dumps({'type': 'chunk', 'data': processed_yield})}\n\n"
                                    full_response_content_for_frontend += processed_yield
                                    current_turn_content_accumulated += processed_save

                                if content_chunk:
                                    if backend_is_streaming_reasoning:
                                        processed_yield = "</think>\n" + content_chunk; processed_save = "</think>\n" + content_chunk
                                        backend_is_streaming_reasoning = False
                                    else:
                                        processed_yield = content_chunk; processed_save = content_chunk
                                    yield f"data: {json.dumps({'type': 'chunk', 'data': processed_yield})}\n\n"
                                    full_response_content_for_frontend += processed_yield
                                    current_turn_content_accumulated += processed_save

                                # --- Tool Call Detection (Manual XML-like Tag) ---
                                if not potential_tool_calls and tools_enabled:
                                    match = TOOL_CALL_REGEX.search(current_turn_content_accumulated)
                                    if match:
                                        tool_name = match.group(1)
                                        args_str = match.group(2)
                                        raw_tag = match.group(0)
                                        print(f"Manual Tool Call Detected: {raw_tag}")
                                        args = {}
                                        arg_matches = re.findall(r'(\w+)="([^"]*)"', args_str)
                                        for k, v in arg_matches: args[k] = v
                                        tool_call_id = f"tool_{uuid.uuid4().hex[:8]}"
                                        detected_tool_call_info = {
                                            "name": tool_name, "arguments": args,
                                            "raw_tag": raw_tag, "id": tool_call_id,
                                            "type": "manual"
                                        }
                                        # Remove the tag from the *accumulated* content that will be saved
                                        # or potentially used in the next history turn.
                                        current_turn_content_accumulated = current_turn_content_accumulated[:match.start()]
                                        break # Stop processing this LLM stream

                                # --- TODO: Handle Native Tool Calls (`potential_tool_calls`) ---
                                # if potential_tool_calls and tools_enabled: ...

                            except json.JSONDecodeError as json_err:
                                print(f"Warning: JSON decode error: {json_err} - Data: '{data_str}'")
                            except Exception as parse_err:
                                print(f"Error parsing LLM chunk: {parse_err}")
                                stream_error = parse_err
                                break # Break inner loop

                        # --- After inner stream loop finishes/breaks ---
                        if backend_is_streaming_reasoning and not stream_error:
                            yield f"data: {json.dumps({'type': 'chunk', 'data': '</think>\n'})}\n\n"
                            full_response_content_for_frontend += "</think>\n"
                            current_turn_content_accumulated += "</think>\n" # Add to saved content too
                            backend_is_streaming_reasoning = False

                        if stream_error: raise stream_error # Re-raise to be caught by outer try/except

            except (httpx.RequestError, HTTPException, asyncio.CancelledError, Exception) as e:
                print(f"[Gen Stream Error Caught] Type: {type(e).__name__}, Msg: {e}")
                stream_error = e
                if backend_is_streaming_reasoning:
                     yield f"data: {json.dumps({'type': 'chunk', 'data': '</think>\n'})}\n\n"; backend_is_streaming_reasoning = False
                error_message = f"Streaming Error: {e}"
                if isinstance(e, asyncio.CancelledError): error_message = "Generation stopped by user."
                elif isinstance(e, HTTPException): error_message = f"LLM API Error: {e.detail}"
                elif isinstance(e, httpx.RequestError): error_message = f"Network Error: {e}"
                yield f"data: {json.dumps({'type': 'error', 'message': error_message})}\n\n"
                break # Break outer while loop on stream error

            # --- Process after stream attempt (either completed or tool detected) ---

            if not detected_tool_call_info:
                # No tool detected, this is the final message segment for this turn.
                print(f"[Gen Success] Finished chat {chat_id} normally (or final segment).")
                if current_turn_content_accumulated: # Only save if there's content
                    message_id_final = create_message(
                        chat_id=chat_id,
                        role=MessageRole.LLM,
                        content=current_turn_content_accumulated,
                        parent_message_id=last_saved_message_id,
                        model_name=model_name,
                        commit=True # Commit this final segment
                    )
                    last_saved_message_id = message_id_final
                    print(f"Saved final LLM message segment: {message_id_final}")
                else:
                    print("[Gen Info] Final LLM segment empty, not saving.")
                generation_completed_normally = True
                break # Exit the outer generation loop
            else:
                # --- Tool Call Detected ---
                tool_call_count += 1
                tool_name = detected_tool_call_info["name"]
                tool_args = detected_tool_call_info["arguments"]
                tool_call_id = detected_tool_call_info["id"]
                tool_call_type = detected_tool_call_info["type"]
                raw_tag = detected_tool_call_info.get("raw_tag")

                print(f"[Gen Tool] Executing Tool {tool_call_count}: '{tool_name}' (ID: {tool_call_id})")

                # 1. Save Assistant Message (Part 1 - Requesting the tool)
                content_for_msg_A = current_turn_content_accumulated # Content *before* the tag
                # *** Append the raw_tag ONLY if it exists (manual detection) ***
                if raw_tag:
                    content_for_msg_A += raw_tag
                    print(f"Appending raw tool tag to content for Message A: {raw_tag}")

                tool_calls_for_db = [{"id": tool_call_id, "type": "function", "function": {"name": tool_name, "arguments": json.dumps(tool_args)}}]

                message_id_A = create_message(
                    chat_id=chat_id,
                    role=MessageRole.LLM,
                    content=content_for_msg_A, # Now includes the raw tag if applicable
                    parent_message_id=last_saved_message_id,
                    model_name=model_name,
                    tool_calls=tool_calls_for_db,
                    commit=True
                )
                last_saved_message_id = message_id_A
                print(f"Saved Assistant Message (Part 1 - Call): {message_id_A}")

                # Add Message A to history for the *next* LLM call context
                # Use the *original* content without the appended tag
                assistant_msg_for_history = {
                    "role": "assistant",
                    "message": current_turn_content_accumulated, # Original content before tag append
                    "tool_calls": tool_calls_for_db
                }
                if assistant_msg_for_history["message"] is None and assistant_msg_for_history["tool_calls"]:
                    assistant_msg_for_history["message"] = ""
                current_llm_history.append(assistant_msg_for_history)

                # 2. Yield Tool Start to Frontend
                # The frontend stream already received the tag via chunk if manual.
                # Send the structured event regardless.
                yield f"data: {json.dumps({'type': 'tool_start', 'name': tool_name, 'args': tool_args})}\n\n"

                # 3. Execute Tool
                tool_result_content = None; tool_error = None
                if tool_name not in TOOL_REGISTRY:
                    tool_error = f"Tool '{tool_name}' not found."
                else:
                    try:
                        tool_function = TOOL_REGISTRY[tool_name]
                        if asyncio.iscoroutinefunction(tool_function):
                             tool_result_content = await tool_function(**tool_args)
                        else:
                             tool_result_content = await asyncio.to_thread(tool_function, **tool_args) # Run sync in executor
                        print(f"Tool '{tool_name}' executed, result: {str(tool_result_content)[:100]}...")
                    except Exception as e:
                        tool_error = f"Error executing tool '{tool_name}': {e}"
                        print(f"Tool error: {tool_error}")
                        traceback.print_exc()
                result_for_llm = str(tool_result_content) if not tool_error else tool_error

                # 4. Save Tool Result Message (Part 2)
                message_id_B = create_message(
                    chat_id=chat_id,
                    role=MessageRole.TOOL,
                    content=result_for_llm,
                    parent_message_id=message_id_A,
                    model_name=None,
                    tool_call_id=tool_call_id,
                    commit=True
                )
                last_saved_message_id = message_id_B
                print(f"Saved Tool Result Message (Part 2): {message_id_B}")

                # Add Message B to history for the *next* LLM call context
                tool_msg_for_history = {"role": "tool", "message": result_for_llm, "tool_call_id": tool_call_id}
                current_llm_history.append(tool_msg_for_history)

                # 5. Yield Tool End to Frontend
                # Construct the result tag for visual display (streamed via chunk)
                result_attr_value = json.dumps(str(result_for_llm))[1:-1]
                result_tag = f'<tool_result tool_name="{tool_name}" result="{result_attr_value}" />'
                full_response_content_for_frontend += result_tag
                yield f"data: {json.dumps({'type': 'chunk', 'data': result_tag})}\n\n"
                yield f"data: {json.dumps({'type': 'tool_end', 'name': tool_name, 'result': str(tool_result_content), 'error': tool_error})}\n\n"

                detected_tool_call_info = None
                # Loop continues...

        # --- End of Outer Generation Loop ---

    except (HTTPException, ValueError, asyncio.CancelledError) as e:
        stream_error = e
        err_msg = f"Error: {getattr(e, 'detail', str(e))}"
        if isinstance(e, asyncio.CancelledError): err_msg = "Generation stopped by user."
        print(f"[Gen Handled Error Outer] Chat {chat_id}: {err_msg}")
        if not isinstance(e, (httpx.RequestError, HTTPException, asyncio.CancelledError)):
             try: yield f"data: {json.dumps({'type': 'error', 'message': err_msg})}\n\n"
             except Exception: pass
    except Exception as e:
        stream_error = e
        print(f"[Gen Unhandled Error Outer] Chat {chat_id}: {e}\n{traceback.format_exc()}")
        try: yield f"data: {json.dumps({'type': 'error', 'message': 'Internal Server Error: Please check backend logs.'})}\n\n"
        except Exception: pass
    finally:
        print(f"[Gen Finally] Reached finally block for chat {chat_id}. Abort set: {abort_event.is_set()}, StreamError: {type(stream_error).__name__ if stream_error else 'None'}, Completed Normally: {generation_completed_normally}")

        if backend_is_streaming_reasoning:
             print("[Gen Finally Warning] Closing dangling think block in finally.")
             try: yield f"data: {json.dumps({'type': 'chunk', 'data': '</think>\n'})}\n\n"
             except Exception: pass

        # Close check connection if it somehow remained open
        if conn_check:
            try: conn_check.close(); print("[Gen Finally Warning] Closed leftover check connection.")
            except Exception: pass

        if chat_id in ACTIVE_GENERATIONS: del ACTIVE_GENERATIONS[chat_id]
        print(f"[Gen Finish] Stream processing complete for chat {chat_id}.")

        if generation_completed_normally and not stream_error and not abort_event.is_set():
            print("[Gen Finish] Yielding done event.")
            try: yield f"data: {json.dumps({'type': 'done'})}\n\n"
            except Exception: pass
        else:
             print("[Gen Finish] Skipping done event due to incomplete/error/abort.")
     
def create_message(
    chat_id: str,
    role: MessageRole,
    content: str,
    attachments: Optional[List[Attachment]] = None,
    parent_message_id: Optional[str] = None,
    model_name: Optional[str] = None,
    tool_call_id: Optional[str] = None, # ID *of the tool call* if this is a tool response msg, or ID *for the tool call* if assistant msg
    tool_calls: Optional[List[Dict[str, Any]]] = None, # The actual tool calls requested by an assistant
    commit: bool = True
) -> str:
    """
    Creates a message in the database. Handles attachments and tool call data.
    """
    if attachments is None: attachments = []
    message_id = str(uuid.uuid4())
    timestamp = int(time.time() * 1000)
    # Serialize tool_calls list to JSON string for storage
    tool_calls_str = json.dumps(tool_calls) if tool_calls else None

    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            """INSERT INTO messages
               (message_id, chat_id, role, message, model_name, timestamp, parent_message_id, tool_call_id, tool_calls)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (message_id, chat_id, role.value, content, model_name, timestamp, parent_message_id, tool_call_id, tool_calls_str)
        )
        for attachment in attachments:
            attachment_id = str(uuid.uuid4())
            # Ensure content is string (primarily for potential non-string data like base64)
            attach_content_str = attachment.content if isinstance(attachment.content, str) else str(attachment.content)
            attach_name = attachment.name
            cursor.execute(
                "INSERT INTO attachments (attachment_id, message_id, type, content, name) VALUES (?, ?, ?, ?, ?)",
                (attachment_id, message_id, attachment.type.value, attach_content_str, attach_name)
            )
        cursor.execute("UPDATE chats SET timestamp_updated = ? WHERE chat_id = ?", (timestamp, chat_id))

        # --- Update parent active index (only if adding LLM/Tool response and parent exists) ---
        # This ensures the newly added message becomes the active one on its parent's branch
        if role in (MessageRole.LLM, MessageRole.TOOL) and parent_message_id:
            try:
                # Fetch children IDs including the newly inserted one
                cursor.execute("SELECT message_id FROM messages WHERE parent_message_id = ? ORDER BY timestamp", (parent_message_id,))
                children_ids = [row['message_id'] for row in cursor.fetchall()]
                # Set index to the position of the new message
                new_idx = children_ids.index(message_id) if message_id in children_ids else len(children_ids) - 1
                cursor.execute("UPDATE messages SET active_child_index = ? WHERE message_id = ?", (new_idx, parent_message_id))
                print(f"Updated parent {parent_message_id} active index to {new_idx} for new child {message_id}")
            except Exception as update_err:
                # Log error but don't fail the whole message creation
                print(f"Warning: Failed to update parent active index during message creation: {update_err}")

        if commit:
            conn.commit()
            print(f"Committed message {message_id} (Role: {role.value})")
    except sqlite3.Error as e:
        if commit: conn.rollback() # Only rollback if we intended to commit here
        print(f"Error creating message: {e}")
        # Re-raise as HTTPException for FastAPI handling if needed, or handle internally
        raise HTTPException(status_code=500, detail=f"Database error creating message: {e}")
    finally:
        # Only close if we were managing the connection for this single operation
        if commit: conn.close()
    return message_id

def get_message(message_id):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM messages WHERE message_id = ?", (message_id,))
    message_data = cursor.fetchone()
    if not message_data:
        conn.close(); return None

    message_dict = dict(message_data)
    cursor.execute("SELECT type, content, name FROM attachments WHERE message_id = ?", (message_id,))
    attachments = [{"type": row["type"], "content": row["content"], "name": row["name"]} for row in cursor.fetchall()]
    message_dict["attachments"] = attachments
    cursor.execute("SELECT message_id FROM messages WHERE parent_message_id = ? ORDER BY timestamp", (message_id,))
    child_message_ids = [row["message_id"] for row in cursor.fetchall()]
    message_dict["child_message_ids"] = child_message_ids
    if message_dict.get("tool_calls"):
        try: message_dict["tool_calls"] = json.loads(message_dict["tool_calls"])
        except json.JSONDecodeError: pass
    conn.close()
    try: return Message(**message_dict).dict()
    except ValidationError as e: return message_dict # Return raw on validation error


def get_chat_messages(chat_id):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp", (chat_id,))
    messages_data = cursor.fetchall()
    messages = []
    for message_data in messages_data:
        msg_id = message_data["message_id"]
        message_dict = dict(message_data)
        cursor.execute("SELECT type, content, name FROM attachments WHERE message_id = ?", (msg_id,))
        attachments = [{"type": row["type"], "content": row["content"], "name": row["name"]} for row in cursor.fetchall()]
        message_dict["attachments"] = attachments
        cursor.execute("SELECT message_id FROM messages WHERE parent_message_id = ? ORDER BY timestamp", (msg_id,))
        child_message_ids = [row["message_id"] for row in cursor.fetchall()]
        message_dict["child_message_ids"] = child_message_ids
        if message_dict.get("tool_calls"):
            try: message_dict["tool_calls"] = json.loads(message_dict["tool_calls"])
            except json.JSONDecodeError: pass
        try: messages.append(Message(**message_dict))
        except ValidationError as e: pass # Skip invalid messages
    conn.close()
    return [msg.dict() for msg in messages]


# --- NEW: Helper to get model config ---
def get_model_config(model_name: str) -> Optional[Dict[str, Any]]:
    """Finds the configuration for a given model name."""
    for config in model_configs.get('models', []):
        if config.get('name') == model_name:
            return config
    return None

# --- NEW: Helper to get LLM API details ---
def get_llm_api_details(provider: str) -> Dict[str, Any]:
    """Gets the base URL and API key for a given provider."""
    details = {"base_url": None, "api_key": None}
    provider_lower = provider.lower()

    if provider_lower == 'openrouter':
        details["base_url"] = api_keys_config.get("openrouter_base_url", "https://openrouter.ai/api/v1")
        details["api_key"] = api_keys_config.get("openrouter")
    elif provider_lower == 'google':
        # Google doesn't have a single base URL like OpenAI spec, handled directly in request logic
        details["base_url"] = "https://generativelanguage.googleapis.com" # Placeholder, specific path used later
        details["api_key"] = api_keys_config.get("google")
    elif provider_lower == 'local':
        details["base_url"] = api_keys_config.get("local_base_url", "http://127.0.0.1:8080")
        # Local key might be optional depending on the server
        details["api_key"] = api_keys_config.get("local_api_key")

    # Validate required info (except for local key)
    if not details["base_url"] and provider_lower != 'google':
        raise ValueError(f"Base URL for provider '{provider}' not configured in api_keys.yaml")
    if not details["api_key"] and provider_lower not in ['local']: # Allow missing local key
        raise ValueError(f"API key for provider '{provider}' not configured in api_keys.yaml")

    return details

# --- FastAPI Lifespan Manager (NEW) ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Initialize resources if needed (like connection pools)
    print("API starting up...")
    yield
    # Shutdown: Cleanup resources
    print("API shutting down...")
    # Cancel any potentially running generation tasks (optional, good practice)
    tasks_to_cancel = list(ACTIVE_GENERATIONS.keys())
    for chat_id in tasks_to_cancel:
        if chat_id in ACTIVE_GENERATIONS:
            print(f"Cancelling generation task for chat {chat_id} on shutdown.")
            ACTIVE_GENERATIONS[chat_id].set() # Signal task to stop
            del ACTIVE_GENERATIONS[chat_id] # Remove from tracking
    await asyncio.sleep(0.1) # Allow tasks a moment to react


# --- API Endpoints (Rest are mostly unchanged) ---

@app.get("/health")
async def health_check():
    return {"status": "ok", "version": "1.3.0-data-api"}

@app.get("/config")
async def get_config():
    config_data = {
        "openrouter_base_url": api_keys_config.get("openrouter_base_url", "https://openrouter.ai/api/v1"),
        "local_base_url": api_keys_config.get("local_base_url", "http://127.0.0.1:8080"),
        "openrouter": None, "google": None, "local_api_key": None,
    }
    if 'openrouter' in api_keys_config: config_data['openrouter'] = api_keys_config['openrouter']
    if 'google' in api_keys_config: config_data['google'] = api_keys_config['google']
    if 'local_api_key' in api_keys_config: config_data['local_api_key'] = api_keys_config['local_api_key']
    # print("Sending config to frontend:", {k: (v[:2] + '...' if isinstance(v, str) and k != 'local_base_url' and v else v) for k, v in config_data.items()})
    return config_data

@app.get("/models")
async def get_available_models():
    available_models = []
    for model_config in model_configs.get('models', []):
        model_name = model_config.get('name');
        if not model_name: continue
        provider = model_config.get('provider', 'openrouter')
        supports_images = model_config.get('supports_images', False)
        display_name = model_name.split('/')[-1].replace('-', ' ').replace('_', ' ').title()
        model_identifier = model_config.get('model_identifier', model_name)
        available_models.append({
            "name": model_name, "model_identifier": model_identifier, "displayName": display_name,
            "supportsImages": supports_images, "provider": provider
        })
    return available_models

# (NEW) API Endpoint
@app.post("/chat/{chat_id}/generate")
async def generate_response(chat_id: str, request: GenerateRequest):
    """
    Initiates server-side streaming generation for a chat.
    Returns a StreamingResponse with Server-Sent Events.
    """
    if chat_id in ACTIVE_GENERATIONS:
        raise HTTPException(status_code=409, detail="A generation task is already running for this chat.")

    abort_event = asyncio.Event()
    ACTIVE_GENERATIONS[chat_id] = abort_event

    # Filter generation args (ensure they are valid types if needed)
    # For now, pass them directly, assuming frontend sends reasonable values
    filtered_gen_args = request.generation_args or {}

    stream_generator = _perform_generation_stream(
        chat_id=chat_id,
        parent_message_id=request.parent_message_id,
        model_name=request.model_name,
        gen_args=filtered_gen_args,
        tools_enabled=request.tools_enabled, # <-- Pass the flag
        abort_event=abort_event
    )

    return StreamingResponse(stream_generator, media_type="text/event-stream")

# (NEW) API Endpoint
@app.post("/chat/{chat_id}/abort_generation")
async def abort_generation(chat_id: str):
    """Signals the backend to abort the active generation task for a chat."""
    if chat_id not in ACTIVE_GENERATIONS:
        # It's okay if the task already finished, just inform the client
        print(f"Received abort request for chat {chat_id}, but no active generation found.")
        return {"status": "ok", "message": "No active generation found or already stopped."}

    print(f"Received abort request for chat {chat_id}. Signaling task...")
    abort_event = ACTIVE_GENERATIONS[chat_id]
    abort_event.set() # Signal the generator task to stop

    # Remove immediately - the task will clean itself up from the dict on exit
    # del ACTIVE_GENERATIONS[chat_id]

    return {"status": "ok", "message": "Abort signal sent."}

@app.post("/chat/create_character", response_model=Dict[str, str])
async def create_character(character: Character):
    character_id = str(uuid.uuid4())
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("INSERT INTO characters (character_id, character_name, sysprompt, settings) VALUES (?, ?, ?, ?)",
                       (character_id, character.character_name, character.sysprompt, json.dumps(character.settings or {})))
        conn.commit()
    except sqlite3.IntegrityError as e:
        conn.rollback()
        if "UNIQUE constraint failed: characters.character_name" in str(e): raise HTTPException(status_code=409, detail=f"Character name '{character.character_name}' already exists.")
        raise HTTPException(status_code=400, detail=f"Failed to create character: {e}")
    finally: conn.close()
    return {"character_id": character_id}

@app.get("/chat/list_characters")
async def list_characters():
    conn = get_db_connection(); cursor = conn.cursor()
    cursor.execute("SELECT character_id, character_name, sysprompt, settings FROM characters ORDER BY character_name")
    characters = [{"character_id": row["character_id"], "character_name": row["character_name"], "sysprompt": row["sysprompt"], "settings": json.loads(row["settings"]) if row["settings"] else {}} for row in cursor.fetchall()]
    conn.close(); return characters

@app.get("/chat/get_character/{character_id}")
async def get_character(character_id: str):
    conn = get_db_connection(); cursor = conn.cursor()
    cursor.execute("SELECT character_id, character_name, sysprompt, settings FROM characters WHERE character_id = ?", (character_id,))
    char_data = cursor.fetchone(); conn.close()
    if not char_data: raise HTTPException(status_code=404, detail="Character not found")
    return {"character_id": char_data["character_id"], "character_name": char_data["character_name"], "sysprompt": char_data["sysprompt"], "settings": json.loads(char_data["settings"]) if char_data["settings"] else {}}

@app.put("/chat/update_character/{character_id}")
async def update_character(character_id: str, character: UpdateCharacterRequest):
    conn = get_db_connection(); cursor = conn.cursor()
    cursor.execute("SELECT character_id FROM characters WHERE character_id = ?", (character_id,))
    if not cursor.fetchone(): conn.close(); raise HTTPException(status_code=404, detail="Character not found")
    try:
        cursor.execute("UPDATE characters SET character_name = ?, sysprompt = ?, settings = ? WHERE character_id = ?",
                       (character.character_name, character.sysprompt, json.dumps(character.settings or {}), character_id))
        conn.commit()
    except sqlite3.IntegrityError as e:
        conn.rollback()
        if "UNIQUE constraint failed: characters.character_name" in str(e): raise HTTPException(status_code=409, detail=f"Character name '{character.character_name}' already exists.")
        raise HTTPException(status_code=500, detail=f"Database error: {e}")
    except sqlite3.Error as e: conn.rollback(); raise HTTPException(status_code=500, detail=f"Database error: {e}")
    finally: conn.close()
    return {"status": "ok"}

@app.delete("/chat/delete_character/{character_id}")
async def delete_character(character_id: str):
    conn = get_db_connection(); cursor = conn.cursor()
    cursor.execute("SELECT character_id FROM characters WHERE character_id = ?", (character_id,))
    if not cursor.fetchone(): conn.close(); raise HTTPException(status_code=404, detail="Character not found")
    try: cursor.execute("DELETE FROM characters WHERE character_id = ?", (character_id,)); conn.commit()
    except sqlite3.Error as e: conn.rollback(); raise HTTPException(status_code=500, detail=f"Database error: {e}")
    finally: conn.close()
    return {"status": "ok"}

@app.post("/chat/new_chat", response_model=Dict[str, str])
async def new_chat(request: NewChatRequest):
    chat_id = str(uuid.uuid4()); timestamp = int(time.time() * 1000)
    conn = get_db_connection(); cursor = conn.cursor()
    try:
        if request.character_id:
             cursor.execute("SELECT character_id FROM characters WHERE character_id = ?", (request.character_id,))
             if not cursor.fetchone(): raise HTTPException(status_code=404, detail="Character not found")
        cursor.execute("INSERT INTO chats (chat_id, timestamp_created, timestamp_updated, character_id) VALUES (?, ?, ?, ?)",
                       (chat_id, timestamp, timestamp, request.character_id))
        conn.commit()
    except sqlite3.Error as e: conn.rollback(); raise HTTPException(status_code=500, detail=f"Database error creating chat: {e}")
    finally: conn.close()
    return {"chat_id": chat_id}

@app.get("/chat/get_chats", response_model=List[ChatListItem])
async def get_chats(offset: int = 0, limit: int = 50):
    conn = get_db_connection(); cursor = conn.cursor()
    cursor.execute("SELECT chat_id, timestamp_updated FROM chats ORDER BY timestamp_updated DESC LIMIT ? OFFSET ?", (limit, offset))
    chat_infos = cursor.fetchall(); chat_list = []
    for row in chat_infos:
        chat_id = row["chat_id"]
        cursor.execute("SELECT message_id, message FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY timestamp DESC LIMIT 1", (chat_id,))
        last_user_msg_data = cursor.fetchone()
        preview_text = "Empty Chat"
        if last_user_msg_data:
            last_user_msg = last_user_msg_data["message"]; last_user_msg_id = last_user_msg_data["message_id"]
            if last_user_msg and last_user_msg.strip() != "": preview_text = last_user_msg[:50].strip() + ("..." if len(last_user_msg) > 50 else "")
            else:
                cursor.execute("SELECT COUNT(*) as count FROM attachments WHERE message_id = ?", (last_user_msg_id,))
                attach_count = cursor.fetchone()['count']
                if attach_count > 0: preview_text = "[Attachment Message]"
                else: preview_text = "..."
        chat_list.append(ChatListItem(chat_id=chat_id, preview=preview_text, timestamp_updated=row["timestamp_updated"]))
    conn.close(); return chat_list

@app.get("/chat/{chat_id}", response_model=Chat)
async def get_chat(chat_id: str):
    conn = get_db_connection(); cursor = conn.cursor()
    cursor.execute("SELECT * FROM chats WHERE chat_id = ?", (chat_id,))
    chat_data = cursor.fetchone()
    if not chat_data: conn.close(); raise HTTPException(status_code=404, detail="Chat not found")
    messages = get_chat_messages(chat_id) # Gets list of dicts
    # Convert list of dicts back to Message models for Chat model validation
    validated_messages = [Message(**msg_dict) for msg_dict in messages]
    chat = Chat(chat_id=chat_data["chat_id"], timestamp_created=chat_data["timestamp_created"],
                timestamp_updated=chat_data["timestamp_updated"], character_id=chat_data["character_id"],
                messages=validated_messages)
    conn.close(); return chat

@app.delete("/chat/{chat_id}")
async def delete_chat(chat_id: str):
    conn = get_db_connection(); cursor = conn.cursor()
    cursor.execute("SELECT chat_id FROM chats WHERE chat_id = ?", (chat_id,))
    if not cursor.fetchone(): conn.close(); raise HTTPException(status_code=404, detail="Chat not found")
    try: cursor.execute("DELETE FROM chats WHERE chat_id = ?", (chat_id,)); conn.commit()
    except sqlite3.Error as e: conn.rollback(); raise HTTPException(status_code=500, detail=f"Database error: {e}")
    finally: conn.close()
    return {"status": "ok"}

@app.post("/chat/{chat_id}/set_active_character")
async def set_active_character(chat_id: str, request: SetActiveCharacterRequest):
    character_id = request.character_id
    conn = get_db_connection(); cursor = conn.cursor()
    cursor.execute("SELECT chat_id FROM chats WHERE chat_id = ?", (chat_id,))
    if not cursor.fetchone(): conn.close(); raise HTTPException(status_code=404, detail="Chat not found")
    if character_id:
        cursor.execute("SELECT character_id FROM characters WHERE character_id = ?", (character_id,))
        if not cursor.fetchone(): conn.close(); raise HTTPException(status_code=404, detail="Character not found")
    try:
        cursor.execute("UPDATE chats SET character_id = ? WHERE chat_id = ?", (character_id, chat_id))
        timestamp = int(time.time() * 1000)
        cursor.execute("UPDATE chats SET timestamp_updated = ? WHERE chat_id = ?", (timestamp, chat_id))
        conn.commit()
    except sqlite3.Error as e: conn.rollback(); raise HTTPException(status_code=500, detail=f"Database error: {e}")
    finally: conn.close()
    return {"status": "ok"}

@app.post("/chat/{chat_id}/add_message", response_model=Dict[str, str])
async def add_message(chat_id: str, request: AddMessageRequest):
    conn = get_db_connection(); cursor = conn.cursor()
    cursor.execute("SELECT chat_id FROM chats WHERE chat_id = ?", (chat_id,))
    if not cursor.fetchone(): conn.close(); raise HTTPException(status_code=404, detail="Chat not found")
    if request.parent_message_id:
        cursor.execute("SELECT message_id FROM messages WHERE message_id = ? AND chat_id = ?", (request.parent_message_id, chat_id))
        if not cursor.fetchone(): conn.close(); raise HTTPException(status_code=404, detail="Parent message not found")
    conn.close()
    message_id = None # Initialize message_id
    try:
        # Create the message using the helper function (handles DB transaction internally)
        message_id = create_message(
            chat_id=chat_id, role=request.role, content=request.message, attachments=request.attachments,
            parent_message_id=request.parent_message_id, model_name=request.model_name,
            tool_call_id=request.tool_call_id, tool_calls=request.tool_calls,
            commit=True # Commit immediately since this is a direct endpoint call
        )
        # --- REDUNDANT UPDATE BLOCK REMOVED ---
        # The logic to update parent index is now handled *inside* create_message only for LLM roles.
        # No need for a separate update block here.
        # --- END REMOVED BLOCK ---

    except HTTPException as http_exc: # Catch potential HTTP exceptions from create_message
        raise http_exc
    except Exception as e:
        print(f"Unexpected error in add_message endpoint: {e}")
        raise HTTPException(status_code=500, detail=f"An internal error occurred: {e}")

    if message_id is None: # Should not happen if no exception, but safety check
        raise HTTPException(status_code=500, detail="Failed to create message, unknown error.")

    return {"message_id": message_id}

@app.post("/chat/{chat_id}/delete_message/{message_id}")
async def delete_message(chat_id: str, message_id: str):
    conn = get_db_connection(); cursor = conn.cursor()
    cursor.execute("SELECT message_id, parent_message_id FROM messages WHERE message_id = ? AND chat_id = ?", (message_id, chat_id))
    msg_data = cursor.fetchone()
    if not msg_data: conn.close(); raise HTTPException(status_code=404, detail="Message not found")
    parent_id = msg_data['parent_message_id']
    try:
        cursor.execute("DELETE FROM messages WHERE message_id = ?", (message_id,))
        timestamp = int(time.time() * 1000)
        cursor.execute("UPDATE chats SET timestamp_updated = ? WHERE chat_id = ?", (timestamp, chat_id))
        if parent_id:
            cursor.execute("SELECT COUNT(*) as count FROM messages WHERE parent_message_id = ?", (parent_id,))
            remaining_children_count = cursor.fetchone()['count']
            # Update parent index only if children remain, set to last remaining child index
            new_parent_index = max(0, remaining_children_count - 1)
            cursor.execute("UPDATE messages SET active_child_index = ? WHERE message_id = ?", (new_parent_index, parent_id))
        conn.commit()
    except sqlite3.Error as e: conn.rollback(); raise HTTPException(status_code=500, detail=f"Database error: {e}")
    finally: conn.close()
    return {"status": "ok"}

@app.post("/chat/{chat_id}/edit_message/{message_id}")
async def edit_message(chat_id: str, message_id: str, request: EditMessageRequest):
    conn = get_db_connection(); cursor = conn.cursor()
    cursor.execute("SELECT role FROM messages WHERE message_id = ? AND chat_id = ?", (message_id, chat_id))
    if not cursor.fetchone(): conn.close(); raise HTTPException(status_code=404, detail="Message not found")
    tool_calls_str = json.dumps(request.tool_calls) if request.tool_calls else None
    try:
        timestamp = int(time.time() * 1000)
        cursor.execute("UPDATE messages SET message = ?, model_name = ?, timestamp = ?, tool_calls = ? WHERE message_id = ?",
                       (request.message, request.model_name, timestamp, tool_calls_str, message_id))
        cursor.execute("DELETE FROM attachments WHERE message_id = ?", (message_id,))
        for attachment in request.attachments:
            attachment_id = str(uuid.uuid4())
            attach_content_str = attachment.content if isinstance(attachment.content, str) else str(attachment.content)
            attach_name = attachment.name
            cursor.execute("INSERT INTO attachments (attachment_id, message_id, type, content, name) VALUES (?, ?, ?, ?, ?)",
                           (attachment_id, message_id, attachment.type.value, attach_content_str, attach_name))
        cursor.execute("UPDATE chats SET timestamp_updated = ? WHERE chat_id = ?", (timestamp, chat_id))
        conn.commit()
    except sqlite3.Error as e: conn.rollback(); raise HTTPException(status_code=500, detail=f"Database error: {e}")
    finally: conn.close()
    return {"status": "ok"}

@app.post("/chat/{chat_id}/set_active_branch/{parent_message_id}")
async def set_active_branch(chat_id: str, parent_message_id: str, request: SetActiveBranchRequest):
    new_index = request.child_index; conn = get_db_connection(); cursor = conn.cursor()
    cursor.execute("SELECT message_id FROM messages WHERE message_id = ? AND chat_id = ?", (parent_message_id, chat_id))
    if not cursor.fetchone(): conn.close(); raise HTTPException(status_code=404, detail="Parent message not found")
    cursor.execute("SELECT COUNT(*) as count FROM messages WHERE parent_message_id = ?", (parent_message_id,))
    count = cursor.fetchone()["count"]
    if not (0 <= new_index < count): conn.close(); raise HTTPException(status_code=400, detail=f"Invalid child index {new_index} for {count} children.")
    try:
        cursor.execute("UPDATE messages SET active_child_index = ? WHERE message_id = ?", (new_index, parent_message_id))
        timestamp = int(time.time() * 1000)
        cursor.execute("UPDATE chats SET timestamp_updated = ? WHERE chat_id = ?", (timestamp, chat_id))
        conn.commit()
    except sqlite3.Error as e: conn.rollback(); raise HTTPException(status_code=500, detail=f"Database error: {e}")
    finally: conn.close()
    return {"status": "ok"}

# --- NEW Tool Endpoints ---

@app.get("/tools/system_prompt")
async def get_tools_system_prompt():
    """ Returns the formatted system prompt describing available tools. """
    prompt = format_tools_for_prompt(TOOLS_AVAILABLE)
    return {"prompt": prompt}

@app.post("/tools/execute")
async def execute_tool(request: ExecuteToolRequest):
    """ Executes the requested tool and returns the result. """
    tool_name = request.tool_name
    arguments = request.arguments
    print(f"Executing tool: {tool_name} with args: {arguments}")
    if tool_name not in TOOL_REGISTRY:
        raise HTTPException(status_code=404, detail=f"Tool '{tool_name}' not found.")
    tool_function = TOOL_REGISTRY[tool_name]
    try:
        # Basic attempt to execute by unpacking args
        result = tool_function(**arguments)
        print(f"Tool '{tool_name}' result: {result}")
        return {"result": str(result)}
    except TypeError as e:
         # Catch argument mismatches (e.g., wrong number, wrong names)
         print(f"Tool execution error (TypeError): {e}")
         # Provide a slightly more helpful error message if possible
         import inspect
         sig = inspect.signature(tool_function)
         expected_args = list(sig.parameters.keys())
         raise HTTPException(status_code=400, detail=f"Invalid arguments for tool '{tool_name}'. Expected: {expected_args}. Got: {list(arguments.keys())}. Error: {e}")
    except Exception as e:
        print(f"Tool execution error: {e}")
        raise HTTPException(status_code=500, detail=f"Error executing tool '{tool_name}'.")

app.mount("/", StaticFiles(directory=".", html = True), name="static")

if __name__ == "__main__":
    import uvicorn
    print("Starting Zeryo Chat Data API...")
    print(f"Using Database: {DB_PATH}")
    # Ensure DB init runs before starting server
    try:
        init_db()
        print("Database initialized successfully.")
    except Exception as db_err:
        print(f"FATAL: Database initialization failed: {db_err}")
        exit(1) # Exit if DB can't be initialized

    print("Model Configs Loaded:", len(model_configs.get('models', [])))
    print("Available Tools:", list(TOOL_REGISTRY.keys()))

    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)
