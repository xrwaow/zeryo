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
from pydantic import BaseModel, Field

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
    # --- Schema definitions (unchanged from your provided version) ---
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
        role TEXT,
        message TEXT,
        model_name TEXT, -- Store the model used for the response
        timestamp INTEGER,
        parent_message_id TEXT,
        active_child_index INTEGER DEFAULT 0,
        FOREIGN KEY (chat_id) REFERENCES chats (chat_id) ON DELETE CASCADE,
        FOREIGN KEY (parent_message_id) REFERENCES messages (message_id) ON DELETE CASCADE
    )
    ''')
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS attachments (
        attachment_id TEXT PRIMARY KEY,
        message_id TEXT,
        type TEXT, -- 'image', 'file'
        content TEXT, -- Base64 for image, formatted text for file
        name TEXT,    -- Added name field
        FOREIGN KEY (message_id) REFERENCES messages (message_id) ON DELETE CASCADE
    )
    ''') # Added name field and CASCADE delete
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS characters (
        character_id TEXT PRIMARY KEY,
        character_name TEXT UNIQUE,
        sysprompt TEXT,
        settings TEXT -- JSON string for future use
    )
    ''')
    # --- Indexes (unchanged) ---
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages (chat_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_messages_parent_id ON messages (parent_message_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments (message_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chats_timestamp_updated ON chats (timestamp_updated DESC)")
    conn.commit()
    conn.close()

init_db()

# Pydantic models (Adjusted slightly)
class MessageRole(str, Enum):
    USER = "user"
    LLM = "llm" # Use 'llm' consistently internally
    SYSTEM = "system"

class AttachmentType(str, Enum):
    IMAGE = "image"
    FILE = "file"

class Attachment(BaseModel):
    type: AttachmentType
    content: str # Base64 for image, formatted text for file
    name: Optional[str] = None

class Message(BaseModel):
    role: MessageRole
    message: str
    # message_id is assigned by backend or comes from request path
    model_name: Optional[str] = None # Model used for LLM response
    attachments: List[Attachment] = []
    # timestamp is assigned by backend
    # parent_message_id is assigned by backend or comes from request path
    # active_child_index comes from request or defaults

# Model for adding a new message
class AddMessageRequest(Message):
    parent_message_id: Optional[str] = None # Explicitly provide parent when adding

# Model for editing a message
class EditMessageRequest(BaseModel):
    message: str
    # Role cannot be edited
    model_name: Optional[str] = None # Model name might change if edited content comes from diff model? Unlikely?
    attachments: List[Attachment] = [] # Allow editing attachments

class Chat(BaseModel):
    chat_id: str
    messages: List[Dict[str, Any]] # Send all messages, frontend handles active path display
    timestamp_created: int
    timestamp_updated: int
    character_id: Optional[str] = None

class ChatListItem(BaseModel):
    chat_id: str
    preview: str
    timestamp_updated: int

class NewChatRequest(BaseModel):
    # Initial message details are now handled by a subsequent add_message call from frontend
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

# Database Helper Functions (Modified create_message)

def create_message(chat_id, role, content, attachments=None, parent_message_id=None, model_name=None):
    if attachments is None: attachments = []
    message_id = str(uuid.uuid4())
    timestamp = int(time.time() * 1000)
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "INSERT INTO messages (message_id, chat_id, role, message, model_name, timestamp, parent_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (message_id, chat_id, role, content, model_name, timestamp, parent_message_id)
        )
        for attachment in attachments:
            attachment_id = str(uuid.uuid4())
            # Ensure content is string for DB and name exists
            attach_content_str = attachment.content if isinstance(attachment.content, str) else str(attachment.content)
            attach_name = attachment.name
            cursor.execute(
                "INSERT INTO attachments (attachment_id, message_id, type, content, name) VALUES (?, ?, ?, ?, ?)",
                (attachment_id, message_id, attachment.type, attach_content_str, attach_name)
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

    # Fetch attachments including name
    cursor.execute("SELECT type, content, name FROM attachments WHERE message_id = ?", (message_id,))
    attachments = [{"type": row["type"], "content": row["content"], "name": row["name"]} for row in cursor.fetchall()]

    cursor.execute("SELECT message_id FROM messages WHERE parent_message_id = ? ORDER BY timestamp", (message_id,))
    child_message_ids = [row["message_id"] for row in cursor.fetchall()]

    message = dict(message_data) # Convert Row to dict
    message["attachments"] = attachments
    message["child_message_ids"] = child_message_ids
    # Convert role enum if needed (already string in DB)

    conn.close()
    return message

def get_chat_messages(chat_id):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp", (chat_id,))
    messages_data = cursor.fetchall()
    messages = []
    for message_data in messages_data:
        msg_id = message_data["message_id"]
        cursor.execute("SELECT type, content, name FROM attachments WHERE message_id = ?", (msg_id,))
        attachments = [{"type": row["type"], "content": row["content"], "name": row["name"]} for row in cursor.fetchall()]

        cursor.execute("SELECT message_id FROM messages WHERE parent_message_id = ? ORDER BY timestamp", (msg_id,))
        child_message_ids = [row["message_id"] for row in cursor.fetchall()]

        message = dict(message_data)
        message["attachments"] = attachments
        message["child_message_ids"] = child_message_ids
        messages.append(message)
    conn.close()
    return messages

# --- API Endpoints ---

@app.get("/health")
async def health_check():
    # No provider status needed now
    return {"status": "ok", "version": "1.2.0-data-api"}

@app.get("/config")
async def get_config():
    """Provides necessary configuration for the frontend, including API keys."""
    # Load the base config structure
    config_data = {
        "openrouter_base_url": api_keys_config.get("openrouter_base_url", "https://openrouter.ai/api/v1"),
        "local_base_url": api_keys_config.get("local_base_url", "http://127.0.0.1:8080"),
        # Add placeholders for keys that should be present in the response
        "openrouter": None,
        "google": None,
        "local_api_key": " ", # Assuming you might have a local key like this in the yaml
    }

    # Explicitly pull the sensitive keys from the loaded config
    # Ensure keys exist in api_keys_config before adding them
    if 'openrouter' in api_keys_config:
        config_data['openrouter'] = api_keys_config['openrouter']
    if 'google' in api_keys_config:
        config_data['google'] = api_keys_config['google']
    # Add other potential keys from your yaml here
    if 'local_api_key' in api_keys_config:
         config_data['local_api_key'] = api_keys_config['local_api_key']
    # Add any other keys from api_keys.yaml that the frontend needs

    print("Sending config to frontend:", {k: (v[:2] + '...' if isinstance(v, str) and k != 'local_base_url' and v else v) for k, v in config_data.items()}) # Log safely

    return config_data

@app.get("/models")
async def get_available_models():
    # This endpoint remains the same, reading from model_config.yaml
    available_models = []
    for model_config in model_configs.get('models', []):
        model_name = model_config.get('name')
        if not model_name: continue
        provider = model_config.get('provider', 'openrouter')
        supports_images = model_config.get('supports_images', False)
        display_name = model_name.split('/')[-1].replace('-', ' ').replace('_', ' ').title()

        # Add model identifier if needed for local provider differentiation
        model_identifier = model_config.get('model_identifier', model_name)

        available_models.append({
            "name": model_name, # Display name / conceptual ID
            "model_identifier": model_identifier, # Actual ID for API call
            "displayName": display_name,
            "supportsImages": supports_images,
            "provider": provider
        })
    return available_models

# --- Character Endpoints (Unchanged) ---
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
        if "UNIQUE constraint failed: characters.character_name" in str(e):
            raise HTTPException(status_code=409, detail=f"Character name '{character.character_name}' already exists.")
        raise HTTPException(status_code=400, detail=f"Failed to create character: {e}")
    finally:
        conn.close()
    return {"character_id": character_id}

@app.get("/chat/list_characters")
async def list_characters():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT character_id, character_name, sysprompt, settings FROM characters ORDER BY character_name")
    characters = [
        {
            "character_id": row["character_id"],
            "character_name": row["character_name"],
            "sysprompt": row["sysprompt"],
            "settings": json.loads(row["settings"]) if row["settings"] else {}
        } for row in cursor.fetchall()
    ]
    conn.close()
    return characters

@app.get("/chat/get_character/{character_id}")
async def get_character(character_id: str):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT character_id, character_name, sysprompt, settings FROM characters WHERE character_id = ?", (character_id,))
    char_data = cursor.fetchone()
    conn.close()
    if not char_data:
        raise HTTPException(status_code=404, detail="Character not found")
    return {
        "character_id": char_data["character_id"],
        "character_name": char_data["character_name"],
        "sysprompt": char_data["sysprompt"],
        "settings": json.loads(char_data["settings"]) if char_data["settings"] else {}
    }

@app.put("/chat/update_character/{character_id}")
async def update_character(character_id: str, character: UpdateCharacterRequest):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT character_id FROM characters WHERE character_id = ?", (character_id,))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Character not found")

    try:
        cursor.execute("UPDATE characters SET character_name = ?, sysprompt = ?, settings = ? WHERE character_id = ?",
                       (character.character_name, character.sysprompt, json.dumps(character.settings or {}), character_id))
        conn.commit()
    except sqlite3.IntegrityError as e:
        conn.rollback()
        if "UNIQUE constraint failed: characters.character_name" in str(e):
            raise HTTPException(status_code=409, detail=f"Character name '{character.character_name}' already exists.")
        raise HTTPException(status_code=500, detail=f"Database error: {e}")
    except sqlite3.Error as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {e}")
    finally:
        conn.close()
    return {"status": "ok"}

@app.delete("/chat/delete_character/{character_id}")
async def delete_character(character_id: str):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT character_id FROM characters WHERE character_id = ?", (character_id,))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Character not found")

    try:
        cursor.execute("DELETE FROM characters WHERE character_id = ?", (character_id,))
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {e}")
    finally:
        conn.close()
    return {"status": "ok"}

# --- Chat Endpoints ---

@app.post("/chat/new_chat", response_model=Dict[str, str])
async def new_chat(request: NewChatRequest):
    """Creates a new empty chat entry."""
    chat_id = str(uuid.uuid4())
    timestamp = int(time.time() * 1000)
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        if request.character_id:
             cursor.execute("SELECT character_id FROM characters WHERE character_id = ?", (request.character_id,))
             if not cursor.fetchone():
                  raise HTTPException(status_code=404, detail="Character not found")

        cursor.execute("INSERT INTO chats (chat_id, timestamp_created, timestamp_updated, character_id) VALUES (?, ?, ?, ?)",
                       (chat_id, timestamp, timestamp, request.character_id))
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=f"Database error creating chat: {e}")
    finally:
        conn.close()
    # Frontend will add the first message via /add_message
    return {"chat_id": chat_id}

# get_chats remains the same logic for fetching previews
@app.get("/chat/get_chats", response_model=List[ChatListItem])
async def get_chats(offset: int = 0, limit: int = 50):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT chat_id, timestamp_updated FROM chats ORDER BY timestamp_updated DESC LIMIT ? OFFSET ?", (limit, offset))
    chat_infos = cursor.fetchall()
    chat_list = []
    for row in chat_infos:
        chat_id = row["chat_id"]
        # Fetch last user message for preview (simplified logic - check performance)
        cursor.execute("""
            SELECT message_id, message FROM messages
            WHERE chat_id = ? AND role = 'user'
            ORDER BY timestamp DESC
            LIMIT 1
        """, (chat_id,))
        last_user_msg_data = cursor.fetchone()
        preview_text = "Empty Chat"
        if last_user_msg_data:
            last_user_msg = last_user_msg_data["message"]
            last_user_msg_id = last_user_msg_data["message_id"]
            if last_user_msg and last_user_msg.strip() != "":
                 preview_text = last_user_msg[:50].strip() + ("..." if len(last_user_msg) > 50 else "")
            else: # User message might be empty but have attachments
                cursor.execute("SELECT COUNT(*) as count FROM attachments WHERE message_id = ?", (last_user_msg_id,))
                attach_count = cursor.fetchone()['count']
                if attach_count > 0:
                    preview_text = "[Attachment Message]"
                else:
                    preview_text = "..." # Or some other placeholder
        chat_list.append(ChatListItem(
            chat_id=chat_id,
            preview=preview_text,
            timestamp_updated=row["timestamp_updated"]
        ))
    conn.close()
    return chat_list

@app.get("/chat/{chat_id}", response_model=Chat)
async def get_chat(chat_id: str):
    """Fetches the chat metadata and ALL messages for the given chat ID."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM chats WHERE chat_id = ?", (chat_id,))
    chat_data = cursor.fetchone()
    if not chat_data:
        conn.close()
        raise HTTPException(status_code=404, detail="Chat not found")
    conn.close() # Close before getting messages

    messages = get_chat_messages(chat_id) # Gets *all* messages including structure

    # Get system prompt separately if character is set
    system_prompt = None
    if chat_data["character_id"]:
        conn_char = get_db_connection()
        cursor_char = conn_char.cursor()
        cursor_char.execute("SELECT sysprompt FROM characters WHERE character_id = ?", (chat_data["character_id"],))
        char_row = cursor_char.fetchone()
        if char_row:
            system_prompt = char_row["sysprompt"]
        conn_char.close()

    chat = Chat(
        chat_id=chat_data["chat_id"],
        timestamp_created=chat_data["timestamp_created"],
        timestamp_updated=chat_data["timestamp_updated"],
        character_id=chat_data["character_id"],
        messages=messages # Send all messages
        # system_prompt=system_prompt # Optionally send prompt separately
    )
    return chat

# delete_chat remains the same
@app.delete("/chat/{chat_id}")
async def delete_chat(chat_id: str):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT chat_id FROM chats WHERE chat_id = ?", (chat_id,))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Chat not found")
    try:
        cursor.execute("DELETE FROM chats WHERE chat_id = ?", (chat_id,)) # CASCADE handles messages/attachments
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {e}")
    finally:
        conn.close()
    return {"status": "ok"}

# set_active_character remains the same
@app.post("/chat/{chat_id}/set_active_character")
async def set_active_character(chat_id: str, request: SetActiveCharacterRequest):
    character_id = request.character_id
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT chat_id FROM chats WHERE chat_id = ?", (chat_id,))
    if not cursor.fetchone():
        conn.close(); raise HTTPException(status_code=404, detail="Chat not found")
    if character_id:
        cursor.execute("SELECT character_id FROM characters WHERE character_id = ?", (character_id,))
        if not cursor.fetchone():
            conn.close(); raise HTTPException(status_code=404, detail="Character not found")
    try:
        cursor.execute("UPDATE chats SET character_id = ? WHERE chat_id = ?", (character_id, chat_id))
        timestamp = int(time.time() * 1000) # Update timestamp on change
        cursor.execute("UPDATE chats SET timestamp_updated = ? WHERE chat_id = ?", (timestamp, chat_id))
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback(); raise HTTPException(status_code=500, detail=f"Database error: {e}")
    finally: conn.close()
    return {"status": "ok"}


# --- Message Endpoints ---

@app.post("/chat/{chat_id}/add_message", response_model=Dict[str, str])
async def add_message(chat_id: str, request: AddMessageRequest):
    """Adds a single message (user or assistant) to the chat."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT chat_id FROM chats WHERE chat_id = ?", (chat_id,))
    if not cursor.fetchone():
        conn.close(); raise HTTPException(status_code=404, detail="Chat not found")

    # Validate parent message exists if provided
    if request.parent_message_id:
        cursor.execute("SELECT message_id FROM messages WHERE message_id = ? AND chat_id = ?", (request.parent_message_id, chat_id))
        if not cursor.fetchone():
             conn.close(); raise HTTPException(status_code=404, detail="Parent message not found")
    conn.close() # Close check connection

    try:
        message_id = create_message(
            chat_id,
            request.role,
            request.message,
            request.attachments,
            request.parent_message_id, # Link to provided parent
            request.model_name # Store model if LLM response
        )
        # If adding a new LLM message creates a branch, update parent's active index
        if request.role == MessageRole.LLM and request.parent_message_id:
            conn_update = get_db_connection()
            cursor_update = conn_update.cursor()
            try:
                cursor_update.execute("SELECT message_id FROM messages WHERE parent_message_id = ? ORDER BY timestamp", (request.parent_message_id,))
                children_ids = [row['message_id'] for row in cursor_update.fetchall()]
                if len(children_ids) > 1: # If this new message created a branch
                    new_idx = children_ids.index(message_id) if message_id in children_ids else len(children_ids) - 1
                    cursor_update.execute("UPDATE messages SET active_child_index = ? WHERE message_id = ?", (new_idx, request.parent_message_id))
                    conn_update.commit()
                    print(f"Updated parent {request.parent_message_id} active index to {new_idx} for new branch {message_id}")
            except Exception as update_err:
                conn_update.rollback()
                print(f"Warning: Failed to update parent active index: {update_err}")
            finally:
                conn_update.close()

    except Exception as e:
        # create_message now raises HTTPException
        raise e

    return {"message_id": message_id}

# delete_message remains the same (CASCADE handles children/attachments)
@app.post("/chat/{chat_id}/delete_message/{message_id}")
async def delete_message(chat_id: str, message_id: str):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT message_id FROM messages WHERE message_id = ? AND chat_id = ?", (message_id, chat_id))
    if not cursor.fetchone():
        conn.close(); raise HTTPException(status_code=404, detail="Message not found")
    try:
        cursor.execute("DELETE FROM messages WHERE message_id = ?", (message_id,))
        timestamp = int(time.time() * 1000)
        cursor.execute("UPDATE chats SET timestamp_updated = ? WHERE chat_id = ?", (timestamp, chat_id))
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback(); raise HTTPException(status_code=500, detail=f"Database error: {e}")
    finally: conn.close()
    return {"status": "ok"}

@app.post("/chat/{chat_id}/edit_message/{message_id}")
async def edit_message(chat_id: str, message_id: str, request: EditMessageRequest):
    """Edits the content and attachments of an existing message."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT role FROM messages WHERE message_id = ? AND chat_id = ?", (message_id, chat_id))
    original_msg_data = cursor.fetchone()
    if not original_msg_data:
        conn.close(); raise HTTPException(status_code=404, detail="Message not found")

    try:
        timestamp = int(time.time() * 1000)
        cursor.execute("UPDATE messages SET message = ?, model_name = ?, timestamp = ? WHERE message_id = ?",
                       (request.message, request.model_name, timestamp, message_id))

        # Update attachments (delete old, insert new)
        cursor.execute("DELETE FROM attachments WHERE message_id = ?", (message_id,))
        for attachment in request.attachments:
            attachment_id = str(uuid.uuid4())
            attach_content_str = attachment.content if isinstance(attachment.content, str) else str(attachment.content)
            attach_name = attachment.name
            cursor.execute("INSERT INTO attachments (attachment_id, message_id, type, content, name) VALUES (?, ?, ?, ?, ?)",
                           (attachment_id, message_id, attachment.type, attach_content_str, attach_name))

        cursor.execute("UPDATE chats SET timestamp_updated = ? WHERE chat_id = ?", (timestamp, chat_id))
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback(); raise HTTPException(status_code=500, detail=f"Database error: {e}")
    finally: conn.close()
    return {"status": "ok"}

# set_active_branch remains the same
@app.post("/chat/{chat_id}/set_active_branch/{parent_message_id}")
async def set_active_branch(chat_id: str, parent_message_id: str, request: SetActiveBranchRequest):
    new_index = request.child_index
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT message_id FROM messages WHERE message_id = ? AND chat_id = ?", (parent_message_id, chat_id))
    if not cursor.fetchone():
        conn.close(); raise HTTPException(status_code=404, detail="Parent message not found")
    cursor.execute("SELECT COUNT(*) as count FROM messages WHERE parent_message_id = ?", (parent_message_id,))
    count = cursor.fetchone()["count"]
    if not (0 <= new_index < count):
        conn.close(); raise HTTPException(status_code=400, detail=f"Invalid child index {new_index} for {count} children.")
    try:
        cursor.execute("UPDATE messages SET active_child_index = ? WHERE message_id = ?", (new_index, parent_message_id))
        timestamp = int(time.time() * 1000)
        cursor.execute("UPDATE chats SET timestamp_updated = ? WHERE chat_id = ?", (timestamp, chat_id))
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback(); raise HTTPException(status_code=500, detail=f"Database error: {e}")
    finally: conn.close()
    return {"status": "ok"}

if __name__ == "__main__":
    import uvicorn
    print("Starting Zeryo Chat Data API...")
    print(f"Using Database: {DB_PATH}")
    init_db()
    print("Model Configs Loaded:", len(model_configs.get('models', [])))
    # Don't print API keys
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)