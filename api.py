#!/home/xr/.venv/bin/python
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
import html
from enum import Enum
from contextlib import asynccontextmanager
from typing import List, Dict, Any, Optional, AsyncGenerator, Callable, Tuple, Set
from fastapi import FastAPI, HTTPException, Request, Query
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

# Database setup (Schema v2: adds preferred_model, cot_start_tag, cot_end_tag to characters)
# Use a new filename to avoid clobbering old schema; no automatic migration performed here.
DB_PATH = "chat_db_branching_v2.sqlite"

def get_db_connection():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys = ON;")  # Enable foreign key constraints for CASCADE delete
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA busy_timeout = 5000;")
    except Exception as e:
        print(f"Warning: Could not set pragmas: {e}")
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
        preferred_model TEXT,
        preferred_model_supports_images INTEGER DEFAULT 0,
        -- Embedded model fields (new unified schema)
        model_name TEXT,
        model_provider TEXT,
        model_identifier TEXT,
        model_supports_images INTEGER,
        cot_start_tag TEXT,
        cot_end_tag TEXT,
        settings TEXT -- JSON string for future use / extra metadata
    )
    ''')
    # --- Simple migration guards for characters table (in case existing DB predates new columns) ---
    try: cursor.execute("ALTER TABLE characters ADD COLUMN preferred_model_supports_images INTEGER DEFAULT 0")
    except sqlite3.OperationalError: pass
    try: cursor.execute("ALTER TABLE characters ADD COLUMN cot_start_tag TEXT")
    except sqlite3.OperationalError: pass
    try: cursor.execute("ALTER TABLE characters ADD COLUMN cot_end_tag TEXT")
    except sqlite3.OperationalError: pass
    try: cursor.execute("ALTER TABLE characters ADD COLUMN settings TEXT")
    except sqlite3.OperationalError: pass
    # New embedded model columns (idempotent)
    try: cursor.execute("ALTER TABLE characters ADD COLUMN model_name TEXT")
    except sqlite3.OperationalError: pass
    try: cursor.execute("ALTER TABLE characters ADD COLUMN model_provider TEXT")
    except sqlite3.OperationalError: pass
    try: cursor.execute("ALTER TABLE characters ADD COLUMN model_identifier TEXT")
    except sqlite3.OperationalError: pass
    try: cursor.execute("ALTER TABLE characters ADD COLUMN model_supports_images INTEGER")
    except sqlite3.OperationalError: pass
    # --- Indexes ---
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages (chat_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_messages_parent_id ON messages (parent_message_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments (message_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chats_timestamp_updated ON chats (timestamp_updated DESC)")
    conn.commit()
    conn.close()

TOOL_CALL_REGEX = re.compile(r'<tool_call\s+name="([\w\-.]+)"(?:\s+id="([\w\-]+)")?\s*>(.*?)</tool_call>', re.DOTALL)

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
    # Legacy fields (kept for backward compatibility)
    preferred_model: Optional[str] = None
    preferred_model_supports_images: Optional[bool] = False
    # New embedded model fields (unify model + character)
    model_name: Optional[str] = None
    model_provider: Optional[str] = None
    model_identifier: Optional[str] = None
    model_supports_images: Optional[bool] = None
    # CoT tags
    cot_start_tag: Optional[str] = None
    cot_end_tag: Optional[str] = None
    settings: Optional[Dict[str, Any]] = {}

class UpdateCharacterRequest(Character):
    character_name: Optional[str] = None  # Allow partial updates (overrides base requirement)
    sysprompt: Optional[str] = None
    preferred_model: Optional[str] = None
    preferred_model_supports_images: Optional[bool] = None
    model_name: Optional[str] = None
    model_provider: Optional[str] = None
    model_identifier: Optional[str] = None
    model_supports_images: Optional[bool] = None
    cot_start_tag: Optional[str] = None
    cot_end_tag: Optional[str] = None
    settings: Optional[Dict[str, Any]] = None

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
    # Extended fields from new frontend contract
    character_id: Optional[str] = None
    cot_start_tag: Optional[str] = None
    cot_end_tag: Optional[str] = None
    enabled_tool_names: Optional[List[str]] = None
    resolve_local_runtime_model: bool = False

from tools import TOOL_REGISTRY, TOOL_DEFINITIONS
# --- Tool Registry and Descriptions ---

TOOLS_AVAILABLE: List[ToolDefinition] = [
    ToolDefinition(**tool_def) for tool_def in TOOL_DEFINITIONS
]


def resolve_tools_subset(tool_names: Optional[List[str]]) -> Tuple[List[ToolDefinition], Dict[str, Callable[..., Any]]]:
    if tool_names is None:
        subset = TOOLS_AVAILABLE
    else:
        names_lower = {name.lower() for name in tool_names}
        subset = [tool for tool in TOOLS_AVAILABLE if tool.name.lower() in names_lower]

    registry = {tool.name: TOOL_REGISTRY[tool.name] for tool in subset if tool.name in TOOL_REGISTRY}
    return subset, registry

def format_tools_for_prompt(tools: List[ToolDefinition]) -> str:
    """ Formats tool definitions into a MCP-compatible string for the system prompt. """
    if not tools:
        return ""

    lines = [
        "Model Context Protocol Tool Instructions:",
        #"- To invoke a tool, respond with a message that contains only a single <tool_call> block.",
        #"- To invoke a tool, respond with a <tool_call> block.",
        "- To invoke a tool you *must* respond with a <tool_call> block, following the exact tool calling format below.",
        "- The block must wrap a JSON object with the arguments you intend to send.",
        #"- Do not include natural language before or after the block.",
        "Tool calling format:",
        "<tool_call name=\"tool_name\">",
        "{",
        "  \"arguments\": { ... }",
        "}",
        "</tool_call>",
    "",
    "Available tools:"
    ]

    for tool in tools:
        lines.append(f"- {tool.name}: {tool.description}")
        if tool.parameters:
            lines.append("  Arguments:")
            for param_name, param_info in tool.parameters.items():
                arg_type = param_info.get("type", "any")
                arg_desc = param_info.get("description", "")
                lines.append(f"    - {param_name} ({arg_type}): {arg_desc}")
        example_args = {param: f"<{param}>" for param in tool.parameters.keys()}
        example_payload = json.dumps({"arguments": example_args}, indent=4)
        lines.append(f"  Example call:")
        lines.append(f"    <tool_call name=\"{tool.name}\">")
        for example_line in example_payload.splitlines():
            lines.append(f"      {example_line}")
        lines.append("    </tool_call>")
        lines.append("")

    lines.append("Always provide valid JSON inside the tool_call block and include every required argument.")
    return "\n".join(lines).strip()


# Database Helper Functions

def build_context_from_db(
    conn: sqlite3.Connection,
    cursor: sqlite3.Cursor,
    chat_id: str,
    stop_at_message_id: str, # This is the ID of the *last message to include*
    system_prompt: Optional[str] = None,
    cot_start_tag: Optional[str] = None,
    cot_end_tag: Optional[str] = None
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

    sanitized_start = (cot_start_tag or "").strip() or None
    sanitized_end = (cot_end_tag or "").strip() or None
    cot_tag_pairs: List[Tuple[str, str]] = []
    seen_pairs: Set[Tuple[str, str]] = set()
    for candidate in ((sanitized_start, sanitized_end), ("<think>", "</think>")):
        start_tag, end_tag = candidate
        if start_tag and end_tag:
            key = (start_tag, end_tag)
            if key not in seen_pairs:
                seen_pairs.add(key)
                cot_tag_pairs.append(key)

    cot_strip_patterns: List[Tuple[str, str, re.Pattern[str]]] = [
        (start_tag, end_tag, re.compile(rf"{re.escape(start_tag)}.*?{re.escape(end_tag)}\\s*", re.DOTALL))
        for start_tag, end_tag in cot_tag_pairs
    ]

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

        # Strip CoT blocks from LLM messages before adding to context
        is_llm = role_for_context == 'llm'
        if is_llm and cot_strip_patterns:
            cleaned_content = content_for_context or ''
            content_changed = False
            for start_tag, end_tag, pattern in cot_strip_patterns:
                if start_tag in cleaned_content and end_tag in cleaned_content:
                    updated = pattern.sub("", cleaned_content)
                    if updated != cleaned_content:
                        content_changed = True
                        cleaned_content = updated
            if content_changed:
                cleaned_content = cleaned_content.strip()
            content_for_context = cleaned_content

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
            elif internal_role == 'system':
                # System prompts for Google are handled by 'systemInstruction' field in the main request,
                # not as part of the 'contents' array. So, skip them here.
                continue
            elif internal_role == 'tool': provider_role = 'function' # Google uses 'function' for tool results
        elif provider_lower in ['openrouter', 'local', 'openai']: # OpenAI / Compatible
            if internal_role == 'llm': provider_role = 'assistant'
            # System prompt IS part of the messages list for OpenAI
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
                if attachment['content']:
                    image_attachments.append(attachment)
                else:
                    print(f"Warning: Skipping image attachment with missing content (Name: {attachment.get('name', 'N/A')})")
            elif attachment['type'] == 'file':
                if attachment['content']:
                     files_content_buffer += f"\n\n--- Attached File: {attachment.get('name', 'file')} ---\n{attachment['content']}\n--- End File ---"
                else:
                     print(f"Warning: Skipping file attachment with missing content (Name: {attachment.get('name', 'N/A')})")

        if files_content_buffer:
            if provider_lower == 'google':
                last_text_part = next((part for part in reversed(content_parts) if 'text' in part), None)
                if last_text_part:
                    last_text_part['text'] += files_content_buffer
                else:
                    content_parts.append({"text": files_content_buffer.lstrip()})
            else: # OpenAI / Compatible
                last_text_part = next((part for part in reversed(content_parts) if part.get('type') == 'text'), None)
                if last_text_part:
                    last_text_part['text'] += files_content_buffer
                else:
                    content_parts.append({"type": "text", "text": files_content_buffer.lstrip()})

        for img_attachment in image_attachments:
             img_content = img_attachment['content']
             # Determine MIME type (very basic, assuming JPEG if not specified)
             mime_type = "image/jpeg" # Default
             # Could add more sophisticated MIME type detection here if name or content has hints
             # e.g., if img_attachment['name'] has .png, .jpeg, etc.
             # For now, sticking to JPEG as it was before.
             if provider_lower == 'google':
                 content_parts.append({"inlineData": {"mimeType": mime_type, "data": img_content}}) # inlineData, mimeType, data
             else: # OpenAI / Compatible
                 content_parts.append({
                     "type": "image_url",
                     "image_url": {"url": f"data:{mime_type};base64,{img_content}"}
                 })

        # 3. Assign Content/Parts and Tool Info to Final Object
        if provider_lower == 'google':
            if content_parts:
                final_message_obj["parts"] = content_parts
            elif provider_role == 'function': # Tool result message
                 # For manual tool flow, content is the string result
                 if content:
                      final_message_obj["parts"] = [{"text": content}]
                 else: # Should have content if it's a tool result
                      final_message_obj["parts"] = [{"text": "[Tool Execution Result Missing]"}]
            elif provider_role in ['user', 'model'] and not content_parts:
                # Google API requires 'parts' to be non-empty for user/model roles.
                # If after processing text and attachments, parts is still empty, add an empty text part.
                print(f"Warning: Google message (Role: {provider_role}) has no content parts. Adding empty text part.")
                final_message_obj["parts"] = [{"text": ""}] # Ensure parts is not empty
            else:
                 print(f"Warning: Skipping Google message with no parts (Role: {provider_role}, Content: '{content}')")
                 continue

        else: # OpenAI / Compatible
            if content_parts:
                if len(content_parts) > 1:
                    final_message_obj["content"] = content_parts
                elif len(content_parts) == 1 and content_parts[0]['type'] == 'text':
                     final_message_obj["content"] = content_parts[0]['text']
                elif len(content_parts) == 1 and content_parts[0]['type'] == 'image_url':
                     final_message_obj["content"] = content_parts
                else:
                     final_message_obj["content"] = None

            if provider_role == 'assistant' and tool_calls:
                 if final_message_obj.get("content") is None: final_message_obj["content"] = ""
                 final_message_obj["tool_calls"] = tool_calls
            elif provider_role == 'tool':
                 if not content and attachments:
                      final_message_obj["content"] = "[Tool result data in attachment]"
                 elif not content:
                      print("Warning: Tool message has no text content, skipping.")
                      continue
                 else:
                     final_message_obj["content"] = content
                 if not tool_call_id:
                      print(f"Warning: Tool message missing tool_call_id.")
                 else:
                      final_message_obj["tool_call_id"] = tool_call_id
            elif provider_role == 'system':
                 final_message_obj["content"] = content
            elif final_message_obj.get("content") is None and not tool_calls:
                 print(f"Warning: Skipping OpenAI message with no content/tool_calls (Role: {provider_role})")
                 continue

        formatted.append(final_message_obj)

    cleaned = []
    last_role = None
    for i, msg in enumerate(formatted):
        current_role = msg.get("role")
        is_tool_assistant_sequence = (last_role == 'assistant' and current_role == 'tool') or \
                                     (last_role == 'tool' and current_role == 'assistant')

        if i > 0 and current_role == last_role and not is_tool_assistant_sequence:
             if provider_lower == 'google' and current_role in ['user', 'model']:
                 # Google strictly requires user/model alternation.
                 # If this happens, it's an issue with the input message history construction.
                 print(f"ERROR: Consecutive identical roles '{current_role}' for Google provider. This will likely cause an API error.")
                 # Potentially raise an error or try to fix, but for now just warn and proceed.
             elif current_role != 'system':
                 print(f"Warning: Skipping consecutive message with role {current_role} for non-Google provider.")
                 continue

        if provider_lower == 'google':
            if last_role == 'model' and current_role not in ['user', 'function']:
                print(f"Warning: Google API expects user/function message after model message. Got {current_role}.")
            if last_role == 'user' and current_role not in ['model']:
                 print(f"Warning: Google API expects model message after user message. Got {current_role}.")
            if last_role == 'function' and current_role not in ['model']:
                 print(f"Warning: Google API expects model message after function message. Got {current_role}.")

        cleaned.append(msg)
        last_role = current_role
    
    if provider_lower == 'google' and cleaned and cleaned[0].get("role") == 'model':
        print("Warning: First message for Google API request is 'model'. This might be an issue if no prior user message context exists (e.g. system prompt).")
    if provider_lower == 'google' and cleaned and cleaned[-1].get("role") == 'model':
         print("Warning: Last message role is 'model' for Google API request. Awaiting user input usually follows.")

    return cleaned

async def _perform_generation_stream(
    chat_id: str,
    parent_message_id: str,
    model_name: str,
    gen_args: Dict[str, Any],
    tools_enabled: bool,
    abort_event: asyncio.Event,
    cot_start_tag: Optional[str] = None,
    cot_end_tag: Optional[str] = None,
    enabled_tool_names: Optional[List[str]] = None
) -> AsyncGenerator[str, None]:
    """
    Performs LLM generation, handles streaming, tool calls, saving distinct messages, and abortion.
    Yields Server-Sent Events (SSE) formatted strings targeting a *single* frontend message bubble.
    Saves partial content if aborted by the user.
    """
    conn_check = None
    full_response_content_for_frontend = "" # For display logging, not directly used by frontend from here
    current_llm_history = []
    stream_error = None
    generation_completed_normally = False
    last_saved_message_id = parent_message_id
    provider = None
    backend_is_streaming_reasoning = False # Specific to OpenRouter/OpenAI CoT tags (customizable)
    current_turn_content_accumulated = "" # Accumulates all text from current LLM turn (segment)
    # Custom CoT tag handling
    effective_cot_start = (cot_start_tag or "").strip() or None
    effective_cot_end = (cot_end_tag or "").strip() or None
    think_open_tag = effective_cot_start or "<think>"
    base_close_tag = effective_cot_end or "</think>"
    newline_suffix = "" if base_close_tag.endswith("\n") else "\n"
    think_close_tag = base_close_tag + newline_suffix

    active_tool_defs: List[ToolDefinition] = []
    active_tool_registry: Dict[str, Callable[..., Any]] = {}

    try:
        conn_check = get_db_connection()
        cursor_check = conn_check.cursor()
        print(f"[Gen Start] Chat: {chat_id}, Parent: {parent_message_id}, Model: {model_name}, Tools: {tools_enabled}")
        cursor_check.execute("SELECT character_id FROM chats WHERE chat_id = ?", (chat_id,))
        chat_info = cursor_check.fetchone()
        if not chat_info:
            raise HTTPException(status_code=404, detail="Chat not found")

        system_prompt_text = ""
        char_info: Optional[Dict[str, Any]] = None
        provider_hint: Optional[str] = None
        if chat_info["character_id"]:
            cursor_check.execute("SELECT sysprompt, model_name, model_provider, model_identifier, model_supports_images, preferred_model FROM characters WHERE character_id = ?", (chat_info["character_id"],))
            char_info_row = cursor_check.fetchone()
            if char_info_row:
                char_info = dict(char_info_row)
                system_prompt_text = char_info.get("sysprompt", "") or ""
                candidate_provider = (char_info.get("model_provider") or "").strip().lower()
                if candidate_provider:
                    provider_hint = candidate_provider
                else:
                    for name_candidate in (char_info.get("model_name"), char_info.get("preferred_model")):
                        if name_candidate and name_candidate.strip().lower() == "local":
                            provider_hint = "local"
                            break
            else:
                system_prompt_text = ""

        tool_system_prompt_text = ""
        if tools_enabled:
            active_tool_defs, active_tool_registry = resolve_tools_subset(enabled_tool_names)
            if enabled_tool_names and not active_tool_defs:
                print(f"[Gen Tools] Warning: No registered tools match requested names: {enabled_tool_names}")
            if not active_tool_registry:
                print("[Gen Tools] No active tools after filtering; disabling tool usage for this generation.")
                tools_enabled = False
            else:
                tool_system_prompt_text = format_tools_for_prompt(active_tool_defs)

        effective_system_prompt = (system_prompt_text + ("\n\n" + tool_system_prompt_text if tool_system_prompt_text else "")).strip()
        
        model_config = get_model_config(model_name)
        if not model_config and char_info:
            # Fast path fallback using already-fetched character row
            possible_names = []
            if char_info.get('model_name'): possible_names.append(char_info['model_name'])
            if char_info.get('preferred_model'): possible_names.append(char_info['preferred_model'])
            if any(model_name.lower() == p.lower() for p in possible_names if p):
                model_config = {
                    'name': model_name,
                    'provider': char_info.get('model_provider') or 'openrouter',
                    'model_identifier': char_info.get('model_identifier') or model_name,
                    'supports_images': bool(char_info.get('model_supports_images'))
                }
                print(f"[Gen Fallback] Using embedded character model config for '{model_name}' (provider={model_config['provider']}).")
                provider_hint = (model_config.get('provider') or provider_hint)

        if not provider_hint:
            model_name_lower = (model_name or "").strip().lower()
            if model_name_lower == "local":
                provider_hint = "local"
            elif model_name and (model_name.startswith('/') or model_name.startswith('~') or '\\' in model_name or model_name_lower.endswith((".gguf", ".ggml", ".bin", ".pth", ".safetensors"))):
                provider_hint = "local"

        if not model_config and provider_hint == "local":
            supports_images = False
            if char_info and char_info.get('model_supports_images') is not None:
                supports_images = bool(char_info.get('model_supports_images'))
            else:
                local_template = next((cfg for cfg in model_configs.get('models', []) if (cfg.get('provider') or '').lower() == 'local'), None)
                if local_template:
                    supports_images = bool(local_template.get('supports_images', False))
            model_config = {
                'name': model_name,
                'provider': 'local',
                'model_identifier': model_name,
                'supports_images': supports_images
            }
            print(f"[Gen Fallback] Synthesized local model config for '{model_name}'.")
        if not model_config: raise ValueError(f"Configuration for model '{model_name}' not found.")
        provider = model_config.get('provider', 'openrouter').lower()
        model_identifier = model_config.get('model_identifier', model_name)
        api_details = get_llm_api_details(provider)
        print(f"[Gen Setup] Provider: {provider}, Identifier: {model_identifier}")

        _system_prompt_for_context_build = effective_system_prompt if provider not in ['google'] else None
        current_llm_history = build_context_from_db(
            conn_check,
            cursor_check,
            chat_id,
            last_saved_message_id,
            _system_prompt_for_context_build,
            cot_start_tag=effective_cot_start,
            cot_end_tag=effective_cot_end
        )

        conn_check.close(); conn_check = None; cursor_check = None

        tool_call_count = 0 # For manual tool loop (currently only for non-Google)
        max_tool_calls = 10

        while tool_call_count < max_tool_calls:
            if abort_event.is_set():
                stream_error = asyncio.CancelledError("Aborted before LLM call")
                break

            print(f"[Gen LLM Call {tool_call_count + 1}] Chat: {chat_id}, History Len: {len(current_llm_history)}")
            
            llm_messages_for_api = format_messages_for_provider(current_llm_history, provider)
            
            request_url: str; llm_body: Dict[str, Any]; headers: Dict[str, str]

            if provider == 'google':
                request_url = f"{api_details['base_url'].rstrip('/')}/v1beta/models/{model_identifier}:streamGenerateContent?key={api_details['api_key']}"
                llm_body = {"contents": llm_messages_for_api}
                google_gen_config = {}
                if gen_args: # Map standard args to Google's generationConfig
                    if "temperature" in gen_args: google_gen_config["temperature"] = gen_args["temperature"]
                    if "max_tokens" in gen_args: google_gen_config["maxOutputTokens"] = gen_args["max_tokens"]
                    if "top_p" in gen_args: google_gen_config["topP"] = gen_args["top_p"]
                    if "top_k" in gen_args: google_gen_config["topK"] = gen_args["top_k"]
                if google_gen_config: llm_body["generationConfig"] = google_gen_config
                if effective_system_prompt:
                    llm_body["systemInstruction"] = {"parts": [{"text": effective_system_prompt}]}
                headers = {'Content-Type': 'application/json'}
            else: # OpenAI / OpenRouter / Local
                request_url = f"{api_details['base_url'].rstrip('/')}/chat/completions"
                llm_body = {"model": model_identifier, "messages": llm_messages_for_api, "stream": True, **gen_args}
                headers = {'Content-Type': 'application/json', 'Accept': 'text/event-stream'}
                if api_details['api_key']: headers['Authorization'] = f"Bearer {api_details['api_key']}"
            
            # Reset per LLM call, tool calls might append to current_turn_content_accumulated from previous segment
            # current_turn_content_accumulated = "" # This was reset outside, should be fine.
            detected_tool_call_info = None 
            native_tool_call_accumulators: Dict[str, Dict[str, Any]] = {}
            native_tool_call_order: List[str] = []
            native_tool_call_chunk_emitted = False
            # is_done_signal_from_llm: Indicates the current LLM call has finished sending content.
            # For Google, it's when ']' of the array is processed or stream ends.
            # For OpenAI, it's when "data: [DONE]" is received.
            is_done_signal_from_llm = False


            try:
                async with httpx.AsyncClient(timeout=600.0) as client:
                    async with client.stream("POST", request_url, json=llm_body, headers=headers) as response:
                        if response.status_code != 200:
                            error_body_bytes = await response.aread()
                            detail = f"LLM API Error ({response.status_code})"
                            try: detail += f" - {error_body_bytes.decode()}"
                            except Exception: pass
                            print(f"LLM API Error: {detail} for URL: {request_url}")
                            raise HTTPException(status_code=response.status_code, detail=detail)

                        if provider == 'google':
                            json_stream_decoder = json.JSONDecoder()
                            buffer = ""
                            first_bracket_parsed = False # True after '[' of the main array is consumed

                            async for text_chunk in response.aiter_text(): # Iterate over text chunks for Google
                                if abort_event.is_set():
                                    stream_error = asyncio.CancelledError("Aborted by user during Google stream")
                                    break
                                buffer += text_chunk
                                
                                if not first_bracket_parsed:
                                    stripped_buffer = buffer.lstrip()
                                    if stripped_buffer.startswith('['):
                                        first_bracket_parsed = True
                                        buffer = stripped_buffer[1:] # Consume '['
                                    elif not stripped_buffer: # Buffer is all whitespace
                                        buffer = "" 
                                        continue
                                    elif len(buffer) > 4096: # Safety for very long non-JSON start
                                        stream_error = ValueError("Google stream did not start with '[' or is too large before finding it.")
                                        break
                                    else: # Still waiting for '[' or more data
                                        continue
                                if not first_bracket_parsed: continue # Should not happen if break conditions are met

                                # Process buffer for JSON objects
                                while buffer:
                                    obj_start_idx = 0
                                    # Skip leading whitespace and commas before the next object
                                    while obj_start_idx < len(buffer) and (buffer[obj_start_idx].isspace() or buffer[obj_start_idx] == ','):
                                        obj_start_idx += 1
                                    
                                    if obj_start_idx >= len(buffer): buffer = ""; break # Only whitespace/commas left

                                    if buffer[obj_start_idx] == ']': # End of the main array
                                        is_done_signal_from_llm = True; buffer = buffer[obj_start_idx+1:]; break 

                                    try:
                                        # Attempt to decode one JSON object (GenerateContentResponse)
                                        decoded_obj, consumed_length = json_stream_decoder.raw_decode(buffer, obj_start_idx)
                                        buffer = buffer[consumed_length:] # Update buffer by removing the consumed part

                                        if "error" in decoded_obj:
                                            err_detail = decoded_obj["error"].get("message", str(decoded_obj["error"]))
                                            raise HTTPException(status_code=decoded_obj["error"].get("code", 500), detail=f"Google API Stream Error: {err_detail}")

                                        current_text_from_google_obj = ""
                                        candidates = decoded_obj.get("candidates")
                                        if candidates and isinstance(candidates, list) and len(candidates) > 0:
                                            candidate = candidates[0]
                                            if candidate.get("content") and candidate["content"].get("parts"):
                                                text_parts = [part.get("text", "") for part in candidate["content"]["parts"] if "text" in part]
                                                if text_parts: current_text_from_google_obj = "".join(text_parts)
                                            # Check finishReason to see if this is the last piece of content
                                            # if candidate.get("finishReason") in ["STOP", "MAX_TOKENS", "SAFETY", "RECITATION", "OTHER"]:
                                            #    is_done_signal_from_llm = True # Content from this LLM call is finished.
                                        
                                        if current_text_from_google_obj:
                                            yield f"data: {json.dumps({'type': 'chunk', 'data': current_text_from_google_obj})}\n\n"
                                            full_response_content_for_frontend += current_text_from_google_obj
                                            current_turn_content_accumulated += current_text_from_google_obj
                                        
                                    except json.JSONDecodeError: # Not enough data in buffer for a complete JSON object
                                        break # Break from 'while buffer' to get more text_chunks
                                    except HTTPException as e_http: stream_error = e_http; break # Propagate

                                if stream_error or is_done_signal_from_llm : break # Break from 'while buffer' and 'aiter_text'
                            
                            # After Google's aiter_text loop
                            if stream_error: pass # Will be raised later
                            elif not is_done_signal_from_llm and first_bracket_parsed: # Stream ended without ']'
                                if buffer.strip() and buffer.strip() != ']': # Check for unprocessed remnants
                                    print(f"Warning: Google stream ended with unprocessed buffer: '{buffer[:200].strip()}'")
                                is_done_signal_from_llm = True # Consider done as stream has ended
                            elif not first_bracket_parsed and not stream_error :
                                stream_error = ValueError("Google stream ended before '[' was found or processed.")
                        
                        else: # OpenAI / OpenRouter / Local (uses aiter_lines)
                            async for line in response.aiter_lines():
                                if abort_event.is_set():
                                    stream_error = asyncio.CancelledError("Aborted by user during stream")
                                    break
                                
                                line_strip = line.strip()
                                if not line_strip: continue

                                if not line_strip.startswith("data:"): continue
                                data_str = line_strip[len("data:"):].strip()
                                if not data_str: continue # Handle "data: " lines with only whitespace after

                                if data_str == "[DONE]":
                                    is_done_signal_from_llm = True
                                    if backend_is_streaming_reasoning:
                                        yield f"data: {json.dumps({'type': 'chunk', 'data': think_close_tag})}\n\n"
                                        full_response_content_for_frontend += think_close_tag
                                        current_turn_content_accumulated += think_close_tag
                                        backend_is_streaming_reasoning = False
                                    break # Exit aiter_lines loop

                                try:
                                    data = json.loads(data_str)
                                    choice = data.get("choices", [{}])[0]
                                    delta = choice.get("delta", {}) if isinstance(choice, dict) else {}
                                    finish_reason = choice.get("finish_reason") if isinstance(choice, dict) else None
                                    content_chunk = delta.get("content") if isinstance(delta, dict) else None
                                    reasoning_chunk = delta.get("reasoning") if isinstance(delta, dict) else None # OpenRouter specific
                                    potential_tool_calls = delta.get("tool_calls") if isinstance(delta, dict) else None # OpenAI native
                                    if potential_tool_calls and isinstance(potential_tool_calls, list):
                                        for idx_tc, tool_delta in enumerate(potential_tool_calls):
                                            if not isinstance(tool_delta, dict):
                                                continue
                                            call_id = tool_delta.get("id") or f"tool_native_{len(native_tool_call_order) + idx_tc}"
                                            function_info = tool_delta.get("function") or {}
                                            if tool_delta.get("type") and tool_delta.get("type") != "function":
                                                continue
                                            accumulator = native_tool_call_accumulators.setdefault(call_id, {
                                                "name": None,
                                                "arguments_chunks": []
                                            })
                                            call_name = function_info.get("name")
                                            if call_name:
                                                accumulator["name"] = call_name
                                            arguments_fragment = function_info.get("arguments")
                                            if arguments_fragment:
                                                accumulator["arguments_chunks"].append(arguments_fragment)
                                            if call_id not in native_tool_call_order:
                                                native_tool_call_order.append(call_id)
                                    elif potential_tool_calls is not None and not isinstance(potential_tool_calls, list):
                                        print(f"[Gen Tool] Warning: Unexpected tool_calls payload type: {type(potential_tool_calls)}")

                                    processed_yield_openai = ""; processed_save_openai = ""
                                    if reasoning_chunk:
                                        if not backend_is_streaming_reasoning:
                                            processed_yield_openai = think_open_tag + reasoning_chunk; processed_save_openai = think_open_tag + reasoning_chunk
                                            backend_is_streaming_reasoning = True
                                        else:
                                            processed_yield_openai = reasoning_chunk; processed_save_openai = reasoning_chunk
                                        yield f"data: {json.dumps({'type': 'chunk', 'data': processed_yield_openai})}\n\n"
                                        full_response_content_for_frontend += processed_yield_openai
                                        current_turn_content_accumulated += processed_save_openai

                                    if content_chunk:
                                        content_chunk_stripped = content_chunk.lstrip() if isinstance(content_chunk, str) else ""
                                        chunk_is_tool_markup = content_chunk_stripped.startswith("<tool_call") or content_chunk_stripped.startswith("<tool_result")
                                        if backend_is_streaming_reasoning and not chunk_is_tool_markup:
                                            processed_yield_openai = think_close_tag + content_chunk; processed_save_openai = think_close_tag + content_chunk
                                            backend_is_streaming_reasoning = False
                                        else:
                                            processed_yield_openai = content_chunk; processed_save_openai = content_chunk
                                        yield f"data: {json.dumps({'type': 'chunk', 'data': processed_yield_openai})}\n\n"
                                        full_response_content_for_frontend += processed_yield_openai
                                        current_turn_content_accumulated += processed_save_openai
                                    
                                    # --- Manual Tool Call Detection (for non-Google, if tools_enabled and no native calls) ---
                                    if not potential_tool_calls and tools_enabled and '</tool_call>' in current_turn_content_accumulated:
                                        matches = list(TOOL_CALL_REGEX.finditer(current_turn_content_accumulated))
                                        if matches:
                                            pre_tool_text = current_turn_content_accumulated[:matches[0].start()]
                                            trailing_text = current_turn_content_accumulated[matches[-1].end():]

                                            calls = []
                                            raw_tags = []
                                            for m in matches:
                                                tool_name = m.group(1)
                                                tag_supplied_id = m.group(2)
                                                payload_str = (m.group(3) or "").strip()

                                                parsed_payload = None
                                                tool_args = {}
                                                parse_error = None
                                                if payload_str:
                                                    try:
                                                        parsed_payload = json.loads(payload_str)
                                                        candidate_args = parsed_payload.get("arguments", parsed_payload.get("input", parsed_payload))
                                                        tool_args = candidate_args if isinstance(candidate_args, dict) else {"value": candidate_args}
                                                    except Exception as e_parse:
                                                        parse_error = e_parse
                                                        tool_args = {}

                                                call_id = tag_supplied_id
                                                if not call_id and isinstance(parsed_payload, dict) and isinstance(parsed_payload.get("id"), str):
                                                    call_id = parsed_payload["id"]
                                                if not call_id:
                                                    call_id = f"tool_{uuid.uuid4().hex[:8]}"

                                                raw_tag = m.group(0)
                                                raw_tags.append(raw_tag)
                                                calls.append({
                                                    "name": tool_name,
                                                    "id": call_id,
                                                    "arguments": tool_args,
                                                    "raw_payload": payload_str,
                                                    "raw_tag": raw_tag,
                                                    "parse_error": parse_error,
                                                    "enabled": tool_name in active_tool_registry,
                                                    "parsed_payload": parsed_payload
                                                })

                                            # Keep only the text before the first tool_call in the assistant message content
                                            current_turn_content_accumulated = pre_tool_text

                                            detected_tool_call_info = {
                                                "name": calls[0]["name"],
                                                "arguments": calls[0]["arguments"],
                                                "raw_tag": "".join(raw_tags),
                                                "id": calls[0]["id"],
                                                "type": "manual",
                                                "payload": calls[0].get("parsed_payload"),
                                                "payload_raw": calls[0]["raw_payload"],
                                                "parse_error": calls[0]["parse_error"],
                                                "trailing_text": trailing_text,
                                                "enabled": calls[0]["enabled"],
                                                "pre_text": pre_tool_text,
                                                "calls": calls
                                            }
                                            break # Break from aiter_lines to process these tool calls
                                    
                                    # --- TODO: Handle Native OpenAI Tool Calls (potential_tool_calls) ---
                                    # if potential_tool_calls:
                                    #   ... populate detected_tool_call_info ...
                                    #   ... possibly yield tool_call events to frontend ...
                                    #   ... break to process tool call ...

                                    if finish_reason == "tool_calls" and detected_tool_call_info is None and native_tool_call_order:
                                        native_calls_info = []
                                        raw_tag_fragments: List[str] = []
                                        for queued_call_id in native_tool_call_order:
                                            accumulator = native_tool_call_accumulators.get(queued_call_id)
                                            if not accumulator:
                                                continue
                                            name = accumulator.get("name") or "unknown_tool"
                                            arguments_text = "".join(accumulator.get("arguments_chunks", []))
                                            parsed_args: Dict[str, Any] = {}
                                            payload_for_raw = arguments_text
                                            parse_error: Optional[Exception] = None
                                            if arguments_text:
                                                try:
                                                    parsed_payload_obj = json.loads(arguments_text)
                                                    if isinstance(parsed_payload_obj, dict):
                                                        candidate_args = parsed_payload_obj.get("arguments", parsed_payload_obj)
                                                        parsed_args = candidate_args if isinstance(candidate_args, dict) else {"value": candidate_args}
                                                    else:
                                                        parsed_args = {"value": parsed_payload_obj}
                                                except Exception as parse_err_native:
                                                    parse_error = parse_err_native
                                                    parsed_args = {}
                                            raw_tag_native = f'<tool_call name="{name}" id="{queued_call_id}">{payload_for_raw}</tool_call>'
                                            raw_tag_fragments.append(raw_tag_native)
                                            native_calls_info.append({
                                                "name": name,
                                                "id": queued_call_id,
                                                "arguments": parsed_args,
                                                "raw_payload": payload_for_raw,
                                                "raw_tag": raw_tag_native,
                                                "parse_error": parse_error,
                                                "enabled": name in active_tool_registry
                                            })

                                        if native_calls_info:
                                            combined_raw_tags = "".join(raw_tag_fragments)
                                            if not native_tool_call_chunk_emitted:
                                                try:
                                                    yield f"data: {json.dumps({'type': 'chunk', 'data': combined_raw_tags})}\n\n"
                                                    full_response_content_for_frontend += combined_raw_tags
                                                except Exception as emit_err:
                                                    print(f"[Gen Tool] Warning: Failed to stream native tool_call chunk: {emit_err}")
                                                native_tool_call_chunk_emitted = True
                                            detected_tool_call_info = {
                                                "name": native_calls_info[0]["name"],
                                                "arguments": native_calls_info[0]["arguments"],
                                                "raw_tag": combined_raw_tags,
                                                "id": native_calls_info[0]["id"],
                                                "type": "native",
                                                "payload_raw": native_calls_info[0]["raw_payload"],
                                                "parse_error": native_calls_info[0].get("parse_error"),
                                                "trailing_text": "",
                                                "enabled": native_calls_info[0]["enabled"],
                                                "pre_text": current_turn_content_accumulated,
                                                "calls": native_calls_info
                                            }
                                            break

                                except json.JSONDecodeError as json_err: print(f"Warning: JSON decode error for OpenAI stream: {json_err} - Data: '{data_str}'")
                                except Exception as parse_err: stream_error = parse_err; break # from aiter_lines

                            # After OpenAI/OpenRouter/Local aiter_lines loop
                            if stream_error: pass # Handled below
                            elif backend_is_streaming_reasoning and not is_done_signal_from_llm : # Stream ended naturally (not [DONE]) but think tag open
                                yield f"data: {json.dumps({'type': 'chunk', 'data': think_close_tag})}\n\n"
                                full_response_content_for_frontend += think_close_tag
                                current_turn_content_accumulated += think_close_tag
                                backend_is_streaming_reasoning = False
                        
                        # Common error check after specific provider stream handling
                        if stream_error: raise stream_error

            except (httpx.RequestError, HTTPException, asyncio.CancelledError, Exception) as e:
                # This catches errors from client.stream setup, or propagated stream_error
                stream_error = e  # Ensure it's set for the finally block logic
                if backend_is_streaming_reasoning:  # Close think tag on any error during stream
                    try:
                        yield f"data: {json.dumps({'type': 'chunk', 'data': think_close_tag})}\n\n"
                    except Exception:
                        pass
                    current_turn_content_accumulated += think_close_tag  # Ensure saved part includes closing tag
                    backend_is_streaming_reasoning = False

                error_message_for_frontend = f"Streaming Error: {getattr(e, 'detail', str(e))}"
                if isinstance(e, asyncio.CancelledError):
                    error_message_for_frontend = "Generation stopped by user."
                # Avoid re-yielding error if it was an HTTPException from LLM already (it might be detailed)
                if not isinstance(e, (asyncio.CancelledError, HTTPException)):
                    try:
                        yield f"data: {json.dumps({'type': 'error', 'message': error_message_for_frontend})}\n\n"
                    except Exception:
                        pass
                elif isinstance(e, HTTPException) and response and response.status_code != 200:  # Yield explicit LLM API error if not already handled
                    try:
                        yield f"data: {json.dumps({'type': 'error', 'message': f'LLM API Error: {e.detail}'})}\n\n"
                    except Exception:
                        pass

                break  # Break outer while tool_call_count loop on any stream error

            # --- Process after stream (either completed or tool detected) ---
            if not detected_tool_call_info: # No tool call, this is the final segment from LLM for this turn
                if current_turn_content_accumulated:
                    # Save the entire accumulated content for this turn (segment)
                    message_id_final = create_message(
                        chat_id=chat_id, role=MessageRole.LLM,
                        content=current_turn_content_accumulated,
                        parent_message_id=last_saved_message_id,
                        model_name=model_name, commit=True
                    )
                    last_saved_message_id = message_id_final
                    print(f"Saved final LLM message segment: {message_id_final} (Length: {len(current_turn_content_accumulated)})")
                else:
                    print("[Gen Info] Final LLM segment empty after full processing, not saving.")
                generation_completed_normally = True
                break # Exit the outer generation (tool call) loop
            else: # Tool call(s) detected
                tool_calls_info = detected_tool_call_info.get("calls") if isinstance(detected_tool_call_info, dict) else None
                if not tool_calls_info:
                    tool_calls_info = [{
                        "name": detected_tool_call_info.get("name"),
                        "id": detected_tool_call_info.get("id"),
                        "arguments": detected_tool_call_info.get("arguments", {}),
                        "raw_payload": detected_tool_call_info.get("payload_raw"),
                        "raw_tag": detected_tool_call_info.get("raw_tag", ""),
                        "parse_error": detected_tool_call_info.get("parse_error"),
                        "enabled": detected_tool_call_info.get("enabled", True)
                    }]

                combined_raw_tags = "".join(call.get("raw_tag", "") for call in tool_calls_info if call)
                pre_text = detected_tool_call_info.get("pre_text", current_turn_content_accumulated)
                content_for_assistant_msg_with_call = (pre_text or "") + combined_raw_tags

                db_tool_calls_data = []
                for call in tool_calls_info:
                    call_args = call.get("arguments") or {}
                    if not isinstance(call_args, dict):
                        call_args = {"value": call_args}
                    try:
                        arguments_json_str = json.dumps(call_args)
                    except TypeError:
                        arguments_json_str = json.dumps({})
                    db_tool_calls_data.append({
                        "id": call.get("id") or f"tool_{uuid.uuid4().hex[:8]}",
                        "type": "function",
                        "function": {
                            "name": call.get("name"),
                            "arguments": arguments_json_str
                        }
                    })

                message_id_A = create_message(
                    chat_id=chat_id, role=MessageRole.LLM, content=content_for_assistant_msg_with_call,
                    parent_message_id=last_saved_message_id, model_name=model_name,
                    tool_calls=db_tool_calls_data, commit=True
                )
                last_saved_message_id = message_id_A
                print(f"Saved Assistant Message (Tool Call Detected): {message_id_A}")

                assistant_msg_for_history = {
                    "role": "assistant",
                    "message": pre_text if pre_text else "",
                    "tool_calls": db_tool_calls_data
                }
                current_llm_history.append(assistant_msg_for_history)

                for idx_call, call in enumerate(tool_calls_info):
                    tool_name = call.get("name")
                    tool_args = call.get("arguments") or {}
                    tool_call_id = db_tool_calls_data[idx_call]["id"]
                    tool_enabled = call.get("enabled", False)

                    yield f"data: {json.dumps({'type': 'tool_start', 'name': tool_name, 'args': tool_args})}\n\n"

                    tool_result_content_str = None
                    tool_error_str = None
                    tool_function = active_tool_registry.get(tool_name) if tool_enabled else None
                    if not tool_function:
                        tool_error_str = f"Tool '{tool_name}' is not enabled or not available."
                    else:
                        try:
                            if asyncio.iscoroutinefunction(tool_function):
                                result = await tool_function(**tool_args)
                            else:
                                result = await asyncio.to_thread(tool_function, **tool_args)
                            tool_result_content_str = str(result)
                        except Exception as e_tool:
                            tool_error_str = f"Error executing tool '{tool_name}': {e_tool}"
                            traceback.print_exc()
                    if tool_error_str:
                        print(f"[Gen Tool] {tool_error_str}")

                    # Full result for database and frontend (includes base64 images)
                    result_for_storage = tool_result_content_str if not tool_error_str else tool_error_str
                    
                    # For LLM context, replace base64 image data with [image] placeholder
                    # to avoid sending huge base64 strings to the model
                    result_for_llm = result_for_storage
                    if result_for_llm:
                        import re
                        result_for_llm = re.sub(
                            r'\[IMAGE:base64:[A-Za-z0-9+/=]+\]',
                            '[image]',
                            result_for_llm
                        )

                    message_id_B = create_message(
                        chat_id=chat_id, role=MessageRole.TOOL, content=result_for_storage,
                        parent_message_id=message_id_A, model_name=None,
                        tool_call_id=tool_call_id, commit=True
                    )
                    last_saved_message_id = message_id_B
                    print(f"Saved Tool Result Message: {message_id_B}")

                    tool_msg_for_history = {"role": "tool", "message": result_for_llm, "tool_call_id": tool_call_id}
                    current_llm_history.append(tool_msg_for_history)

                    escaped_result_text = html.escape(result_for_storage or "")
                    status_attr = ' status="error"' if tool_error_str else ''
                    result_tag_for_frontend = f'<tool_result name="{tool_name}"{status_attr}>{escaped_result_text}</tool_result>'
                    yield f"data: {json.dumps({'type': 'chunk', 'data': result_tag_for_frontend})}\n\n"
                    yield f"data: {json.dumps({'type': 'tool_end', 'name': tool_name, 'result': tool_result_content_str, 'error': tool_error_str})}\n\n"

                tool_call_count += len(tool_calls_info)
                current_turn_content_accumulated = ""
                detected_tool_call_info = None
                continue  # Continue outer while loop for next LLM call
        # --- End of Outer Generation (tool call) Loop ---

    except (HTTPException, ValueError, asyncio.CancelledError) as e_outer:
        stream_error = e_outer
        err_msg_outer = f"Error: {getattr(e_outer, 'detail', str(e_outer))}"
        if isinstance(e_outer, asyncio.CancelledError): err_msg_outer = "Generation stopped by user."
        print(f"[Gen Handled Error Outer] Chat {chat_id}: {err_msg_outer}")
        # Avoid re-yielding general errors if specific LLM HTTP error already yielded
        if not isinstance(e_outer, (asyncio.CancelledError, HTTPException, httpx.RequestError)):
             try: yield f"data: {json.dumps({'type': 'error', 'message': err_msg_outer})}\n\n"
             except Exception: pass
    except Exception as e_unhandled:
        stream_error = e_unhandled
        print(f"[Gen Unhandled Error Outer] Chat {chat_id}: {e_unhandled}\n{traceback.format_exc()}")
        try: yield f"data: {json.dumps({'type': 'error', 'message': 'Internal Server Error: Please check backend logs.'})}\n\n"
        except Exception: pass
    finally:
        print(f"[Gen Finally] Chat {chat_id}. Abort: {abort_event.is_set()}, StreamError: {type(stream_error).__name__ if stream_error else 'None'}, Completed Loop: {generation_completed_normally}")

        if backend_is_streaming_reasoning: # Final safety net for streamed CoT tags
            try:
                yield f"data: {json.dumps({'type': 'chunk', 'data': think_close_tag})}\n\n"
            except Exception:
                pass
            if not stream_error or isinstance(stream_error, asyncio.CancelledError): # Only add to save if not a hard error mid-think
                current_turn_content_accumulated += think_close_tag

        if isinstance(stream_error, asyncio.CancelledError) and current_turn_content_accumulated:
            print(f"[Gen Finally - Abort Save] Saving partial: {len(current_turn_content_accumulated)} chars.")
            try:
                aborted_message_id = create_message(
                    chat_id=chat_id, role=MessageRole.LLM,
                    content=current_turn_content_accumulated, # This is content from the segment being aborted
                    parent_message_id=last_saved_message_id, model_name=model_name, commit=True
                )
                print(f"[Gen Finally - Abort Save] Saved partial message ID: {aborted_message_id}")
            except Exception as save_err: print(f"[Gen Finally - Abort Save Error] Failed to save partial: {save_err}")

        if conn_check:
            try: conn_check.close()
            except Exception: pass

        if chat_id in ACTIVE_GENERATIONS: del ACTIVE_GENERATIONS[chat_id]
        print(f"[Gen Finish] Stream processing ended for chat {chat_id}.")

        if generation_completed_normally and not stream_error and not abort_event.is_set():
            try: yield f"data: {json.dumps({'type': 'done'})}\n\n"
            except Exception: pass
        else:
            print("[Gen Finish] Skipping 'done' event due to error, abort, or incomplete tool loop.")

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


# --- NEW: Helper to get model config (enhanced with embedded character fallback) ---
def get_model_config(model_name: str) -> Optional[Dict[str, Any]]:
    """Resolve model configuration.

    Resolution order:
      1. In-memory legacy model_configs (model_config.yaml)
      2. Characters table embedded model_name fields
      3. Characters table preferred_model fallback
    Returns synthesized config dict when using embedded data.
    """
    if not model_name:
        return None
    target_name_lower = model_name.lower()
    # 1. Legacy config list
    for config in model_configs.get('models', []):
        name = config.get('name')
        if name and name.lower() == target_name_lower:
            return config

    # 2 & 3. Search characters for embedded definitions
    try:
        conn = get_db_connection(); cursor = conn.cursor()
        # Direct model_name match
        cursor.execute("""
            SELECT model_name, model_provider, model_identifier, model_supports_images
            FROM characters
            WHERE lower(model_name) = lower(?) AND model_name IS NOT NULL AND model_name != ''
            LIMIT 1
        """, (model_name,))
        row = cursor.fetchone()
        if not row:
            # Preferred model fallback
            cursor.execute("""
                SELECT preferred_model as model_name, model_provider, model_identifier, model_supports_images
                FROM characters
                WHERE lower(preferred_model) = lower(?) AND preferred_model IS NOT NULL AND preferred_model != ''
                LIMIT 1
            """, (model_name,))
            row = cursor.fetchone()
        conn.close()
        if row:
            synthesized = {
                'name': model_name,
                'provider': row['model_provider'] or 'openrouter',
                'model_identifier': row['model_identifier'] or model_name,
                'supports_images': bool(row['model_supports_images'])
            }
            print(f"[ModelConfig] Synthesized from character embedding for '{model_name}' (provider={synthesized['provider']}).")
            return synthesized
    except Exception as e:
        try: conn.close()
        except: pass
        print(f"[ModelConfig] Embedded model lookup failed for '{model_name}': {e}")
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

    # If character_id provided, prefer embedded model fields
    embedded_model_override = None
    char_row: Optional[Dict[str, Any]] = None
    if request.character_id:
        try:
            conn_char = get_db_connection(); cur_char = conn_char.cursor()
            cur_char.execute("SELECT model_name, model_provider, model_identifier, model_supports_images, preferred_model FROM characters WHERE character_id = ?", (request.character_id,))
            fetched_char_row = cur_char.fetchone(); conn_char.close()
            if fetched_char_row:
                char_row = dict(fetched_char_row)
                if char_row.get('model_name'):
                    embedded_model_override = char_row['model_name']
                elif char_row.get('preferred_model'):
                    embedded_model_override = char_row['preferred_model']
        except Exception as e:
            print(f"[Gen] Embedded model lookup failed: {e}")

    if embedded_model_override:
        request.model_name = embedded_model_override

    # Resolve runtime local model name if requested
    resolved_model_name = request.model_name
    if request.resolve_local_runtime_model:
        try:
            provider_val = None
            model_config_for_resolution = get_model_config(request.model_name)
            if model_config_for_resolution:
                provider_val = model_config_for_resolution.get('provider')
            elif char_row and char_row.get('model_provider'):
                provider_val = char_row.get('model_provider')
            if provider_val and provider_val.lower() == 'local':
                import requests
                resp = requests.get(f"{api_keys_config.get('local_base_url', 'http://127.0.0.1:8080')}/v1/models", timeout=2)
                if resp.ok:
                    data = resp.json()
                    runtime_name = None
                    if isinstance(data, dict):
                        if 'models' in data and isinstance(data['models'], list) and data['models']:
                            first = data['models'][0]; runtime_name = first.get('name') or first.get('model')
                        elif 'data' in data and isinstance(data['data'], list) and data['data']:
                            first = data['data'][0]; runtime_name = first.get('id')
                    if runtime_name: resolved_model_name = runtime_name
        except Exception as e:
            print(f"[Gen] Runtime local model resolution failed: {e}")

    stream_generator = _perform_generation_stream(
        chat_id=chat_id,
        parent_message_id=request.parent_message_id,
        model_name=resolved_model_name,
        gen_args=filtered_gen_args,
        tools_enabled=request.tools_enabled, # <-- Pass the flag
        abort_event=abort_event,
        cot_start_tag=request.cot_start_tag,
        cot_end_tag=request.cot_end_tag,
        enabled_tool_names=request.enabled_tool_names
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

@app.post("/character", response_model=Dict[str, str])
async def create_character_v2(character: Character):
    """Create a new character with embedded model fields (legacy preferred_model kept for compat)."""
    character_id = str(uuid.uuid4())
    conn = get_db_connection(); cursor = conn.cursor()
    try:
        # Normalize casing for model_name if provided
        model_name_norm = character.model_name or character.preferred_model
        if model_name_norm:
            cursor.execute("SELECT model_name, provider, model_identifier, supports_images FROM models WHERE lower(model_name) = lower(?)", (model_name_norm,))
            found = cursor.fetchone()
            if found and not character.model_provider:
                # Use DB values to enrich if provider unspecified
                character.model_name = found['model_name']
                character.model_provider = found['provider']
                character.model_identifier = found['model_identifier']
                if character.model_supports_images is None:
                    character.model_supports_images = bool(found['supports_images'])
        cursor.execute(
            """INSERT INTO characters (character_id, character_name, sysprompt, preferred_model, preferred_model_supports_images,
                model_name, model_provider, model_identifier, model_supports_images, cot_start_tag, cot_end_tag, settings)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                character_id,
                character.character_name,
                character.sysprompt,
                character.preferred_model or character.model_name,
                1 if (character.preferred_model_supports_images or character.model_supports_images) else 0,
                character.model_name,
                character.model_provider,
                character.model_identifier,
                1 if (character.model_supports_images) else 0 if character.model_supports_images is not None else None,
                character.cot_start_tag,
                character.cot_end_tag,
                json.dumps(character.settings or {})
            )
        )
        conn.commit()
    except sqlite3.IntegrityError as e:
        conn.rollback()
        if "UNIQUE constraint failed: characters.character_name" in str(e):
            raise HTTPException(status_code=409, detail=f"Character name '{character.character_name}' already exists.")
        raise HTTPException(status_code=400, detail=f"Failed to create character: {e}")
    finally:
        conn.close()
    return {"character_id": character_id}

@app.get("/characters")
async def list_characters_v2():
    """List all characters including embedded model data and CoT tags."""
    conn = get_db_connection(); cursor = conn.cursor()
    cursor.execute("""
        SELECT character_id, character_name, sysprompt,
               preferred_model, preferred_model_supports_images,
               model_name, model_provider, model_identifier, model_supports_images,
               cot_start_tag, cot_end_tag, settings
        FROM characters ORDER BY character_name
    """)
    characters = []
    for row in cursor.fetchall():
        settings_obj = json.loads(row["settings"]) if row["settings"] else {}
        characters.append({
            "character_id": row["character_id"],
            "character_name": row["character_name"],
            "sysprompt": row["sysprompt"],
            "preferred_model": row["preferred_model"],
            "preferred_model_supports_images": bool(row["preferred_model_supports_images"]),
            "model_name": row["model_name"],
            "model_provider": row["model_provider"],
            "model_identifier": row["model_identifier"],
            "model_supports_images": bool(row["model_supports_images"]) if row["model_supports_images"] is not None else None,
            "cot_start_tag": row["cot_start_tag"],
            "cot_end_tag": row["cot_end_tag"],
            "settings": settings_obj
        })
    conn.close(); return characters

@app.get("/character/{character_id}")
async def get_character_v2(character_id: str):
    """Retrieve a single character with embedded model data."""
    conn = get_db_connection(); cursor = conn.cursor()
    cursor.execute("""
        SELECT character_id, character_name, sysprompt,
               preferred_model, preferred_model_supports_images,
               model_name, model_provider, model_identifier, model_supports_images,
               cot_start_tag, cot_end_tag, settings
        FROM characters WHERE character_id = ?
    """, (character_id,))
    row = cursor.fetchone(); conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Character not found")
    return {
        "character_id": row["character_id"],
        "character_name": row["character_name"],
        "sysprompt": row["sysprompt"],
        "preferred_model": row["preferred_model"],
        "preferred_model_supports_images": bool(row["preferred_model_supports_images"]),
        "model_name": row["model_name"],
        "model_provider": row["model_provider"],
        "model_identifier": row["model_identifier"],
        "model_supports_images": bool(row["model_supports_images"]) if row["model_supports_images"] is not None else None,
        "cot_start_tag": row["cot_start_tag"],
        "cot_end_tag": row["cot_end_tag"],
        "settings": json.loads(row["settings"]) if row["settings"] else {}
    }

@app.put("/character/{character_id}")
async def update_character_v2(character_id: str, update: UpdateCharacterRequest):
    """Update a character. Fields not provided are left unchanged."""
    conn = get_db_connection(); cursor = conn.cursor()
    cursor.execute("SELECT character_id, character_name, sysprompt, preferred_model, preferred_model_supports_images, model_name, model_provider, model_identifier, model_supports_images, cot_start_tag, cot_end_tag, settings FROM characters WHERE character_id = ?", (character_id,))
    existing = cursor.fetchone()
    if not existing:
        conn.close(); raise HTTPException(status_code=404, detail="Character not found")

    # Build updated values
    new_name = update.character_name if update.character_name is not None else existing["character_name"]
    new_sysprompt = update.sysprompt if update.sysprompt is not None else existing["sysprompt"]
    new_pref_model = update.preferred_model if update.preferred_model is not None else existing["preferred_model"]
    new_pref_model_supports = existing["preferred_model_supports_images"] if update.preferred_model_supports_images is None else (1 if update.preferred_model_supports_images else 0)
    # Embedded model updates (fallback to preferred if provided only there)
    new_model_name = update.model_name if update.model_name is not None else existing['model_name'] or new_pref_model
    new_model_provider = update.model_provider if update.model_provider is not None else existing['model_provider']
    new_model_identifier = update.model_identifier if update.model_identifier is not None else existing['model_identifier']
    new_model_supports_images = existing['model_supports_images'] if update.model_supports_images is None else (1 if update.model_supports_images else 0)
    new_cot_start = update.cot_start_tag if update.cot_start_tag is not None else existing["cot_start_tag"]
    new_cot_end = update.cot_end_tag if update.cot_end_tag is not None else existing["cot_end_tag"]
    existing_settings = json.loads(existing["settings"]) if existing["settings"] else {}
    if update.settings is not None:
        # Replace entirely; or could merge if desired
        new_settings = update.settings
    else:
        new_settings = existing_settings
    try:
        cursor.execute(
            """UPDATE characters SET character_name = ?, sysprompt = ?, preferred_model = ?, preferred_model_supports_images = ?,
                       model_name = ?, model_provider = ?, model_identifier = ?, model_supports_images = ?,
                       cot_start_tag = ?, cot_end_tag = ?, settings = ? WHERE character_id = ?""",
            (new_name, new_sysprompt, new_pref_model, new_pref_model_supports,
             new_model_name, new_model_provider, new_model_identifier, new_model_supports_images,
             new_cot_start, new_cot_end, json.dumps(new_settings or {}), character_id)
        )
        conn.commit()
    except sqlite3.IntegrityError as e:
        conn.rollback()
        if "UNIQUE constraint failed: characters.character_name" in str(e):
            raise HTTPException(status_code=409, detail=f"Character name '{new_name}' already exists.")
        raise HTTPException(status_code=500, detail=f"Database error: {e}")
    finally:
        conn.close()
    return {"status": "ok"}

@app.delete("/character/{character_id}")
async def delete_character_v2(character_id: str):
    """Delete a character (v2)."""
    conn = get_db_connection(); cursor = conn.cursor()
    cursor.execute("SELECT character_id FROM characters WHERE character_id = ?", (character_id,))
    if not cursor.fetchone():
        conn.close(); raise HTTPException(status_code=404, detail="Character not found")
    try:
        cursor.execute("DELETE FROM characters WHERE character_id = ?", (character_id,))
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback(); raise HTTPException(status_code=500, detail=f"Database error: {e}")
    finally:
        conn.close()
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
async def get_tools_system_prompt(names: Optional[List[str]] = Query(default=None)):
    """ Returns the formatted system prompt describing available tools. """
    subset, _ = resolve_tools_subset(names)
    prompt = format_tools_for_prompt(subset)
    return {"prompt": prompt}


@app.get("/tools")
async def list_tools():
    """Returns metadata for all registered tools."""
    return {"tools": [tool.dict() for tool in TOOLS_AVAILABLE]}

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
        if asyncio.iscoroutinefunction(tool_function):
            result = await tool_function(**arguments)
        else:
            result = await asyncio.to_thread(tool_function, **arguments)
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
