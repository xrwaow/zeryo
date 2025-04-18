# api.py
import base64
import json
import os
import time
import uuid
from enum import Enum
from typing import List, Dict, Any, Optional, Union
import yaml
import sqlite3
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError

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
        tool_call_id TEXT, -- Optional: Store if this is a tool result message
        tool_calls TEXT, -- Optional: Store LLM's requested tool calls (JSON) if using native features later
        -- *** FIXED: Moved FOREIGN KEY constraints after all column definitions ***
        FOREIGN KEY (chat_id) REFERENCES chats (chat_id) ON DELETE CASCADE,
        FOREIGN KEY (parent_message_id) REFERENCES messages (message_id) ON DELETE CASCADE
    )
    ''')
    # Add columns if they don't exist (simple migration)
    try: cursor.execute("ALTER TABLE messages ADD COLUMN tool_call_id TEXT")
    except sqlite3.OperationalError: pass # Ignore if column already exists
    try: cursor.execute("ALTER TABLE messages ADD COLUMN tool_calls TEXT")
    except sqlite3.OperationalError: pass # Ignore if column already exists

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

def create_message(
    chat_id: str,
    role: MessageRole,
    content: str,
    attachments: Optional[List[Attachment]] = None,
    parent_message_id: Optional[str] = None,
    model_name: Optional[str] = None,
    tool_call_id: Optional[str] = None,
    tool_calls: Optional[Any] = None
):
    if attachments is None: attachments = []
    message_id = str(uuid.uuid4())
    timestamp = int(time.time() * 1000)
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
            attach_content_str = attachment.content if isinstance(attachment.content, str) else str(attachment.content)
            attach_name = attachment.name
            cursor.execute(
                "INSERT INTO attachments (attachment_id, message_id, type, content, name) VALUES (?, ?, ?, ?, ?)",
                (attachment_id, message_id, attachment.type.value, attach_content_str, attach_name)
            )
        cursor.execute("UPDATE chats SET timestamp_updated = ? WHERE chat_id = ?", (timestamp, chat_id))
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        print(f"Error creating message: {e}")
        raise HTTPException(status_code=500, detail=f"Database error creating message: {e}")
    finally:
        conn.close()
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
    try:
        message_id = create_message(
            chat_id=chat_id, role=request.role, content=request.message, attachments=request.attachments,
            parent_message_id=request.parent_message_id, model_name=request.model_name,
            tool_call_id=request.tool_call_id, tool_calls=request.tool_calls
        )
        if request.role == MessageRole.LLM and request.parent_message_id:
            conn_update = get_db_connection(); cursor_update = conn_update.cursor()
            try:
                cursor_update.execute("SELECT message_id FROM messages WHERE parent_message_id = ? ORDER BY timestamp", (request.parent_message_id,))
                children_ids = [row['message_id'] for row in cursor_update.fetchall()]
                if len(children_ids) > 1:
                    new_idx = children_ids.index(message_id) if message_id in children_ids else len(children_ids) - 1
                    cursor_update.execute("UPDATE messages SET active_child_index = ? WHERE message_id = ?", (new_idx, request.parent_message_id))
                    conn_update.commit()
            except Exception as update_err: conn_update.rollback(); print(f"Warning: Failed to update parent active index: {update_err}")
            finally: conn_update.close()
    except Exception as e: raise e
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