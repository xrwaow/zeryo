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
import requests
from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import asyncio
from threading import Event, Thread
from queue import Queue, Empty

app = FastAPI(title="Chat API")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global cancellation event for active generation
cancel_event = None

# Load API keys and model configurations
def load_config(file_path):
    if os.path.exists(file_path):
        with open(file_path, 'r') as f:
            return yaml.safe_load(f)
    return {}

api_keys = load_config('api_keys.yaml')
model_configs = load_config('model_config.yaml')

# Database setup
DB_PATH = "chat_db_branching.sqlite" # Use a new DB file for the branching schema

def get_db_connection():
    conn = sqlite3.connect(DB_PATH, timeout=10) # Increase timeout
    conn.row_factory = sqlite3.Row
    # Enable Write-Ahead Logging for better concurrency
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA busy_timeout = 5000;") # Wait 5s if locked
    except Exception as e:
        print(f"Warning: Could not set WAL mode or busy_timeout: {e}")
    return conn

def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute('''
    CREATE TABLE IF NOT EXISTS chats (
        chat_id TEXT PRIMARY KEY,
        timestamp_created INTEGER,
        timestamp_updated INTEGER,
        character_id TEXT,
        FOREIGN KEY (character_id) REFERENCES characters (character_id) ON DELETE SET NULL
    )
    ''') # Added ON DELETE SET NULL

    cursor.execute('''
    CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        chat_id TEXT,
        role TEXT,
        message TEXT,
        model_name TEXT,
        timestamp INTEGER,
        parent_message_id TEXT,
        active_child_index INTEGER DEFAULT 0, -- Index of the active child message (for branching)
        FOREIGN KEY (chat_id) REFERENCES chats (chat_id) ON DELETE CASCADE, -- Delete messages if chat deleted
        FOREIGN KEY (parent_message_id) REFERENCES messages (message_id) ON DELETE CASCADE -- Cascade delete children if parent deleted
    )
    ''') # Added ON DELETE CASCADE

    cursor.execute('''
    CREATE TABLE IF NOT EXISTS attachments (
        attachment_id TEXT PRIMARY KEY,
        message_id TEXT,
        type TEXT,
        content TEXT,
        FOREIGN KEY (message_id) REFERENCES messages (message_id) ON DELETE CASCADE -- Delete attachments if message deleted
    )
    ''') # Added ON DELETE CASCADE

    cursor.execute('''
    CREATE TABLE IF NOT EXISTS characters (
        character_id TEXT PRIMARY KEY,
        character_name TEXT UNIQUE, -- Ensure names are unique? Or allow duplicates? Let's add UNIQUE for now.
        sysprompt TEXT,
        settings TEXT -- Keep settings if needed for character-specific gen args
    )
    ''')

    # Add indexes for performance
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages (chat_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_messages_parent_id ON messages (parent_message_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments (message_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chats_timestamp_updated ON chats (timestamp_updated DESC)")


    conn.commit()
    conn.close()

init_db()

# Pydantic models for request/response validation
class MessageRole(str, Enum):
    USER = "user"
    LLM = "llm"
    SYSTEM = "system"

class AttachmentType(str, Enum):
    IMAGE = "image"
    FILE = "file"

class Attachment(BaseModel):
    type: AttachmentType
    content: str # Base64 for image, raw text for file
    name: Optional[str] = None # Added name field

class Message(BaseModel):
    role: MessageRole
    message: str
    message_id: Optional[str] = None
    model_name: Optional[str] = None
    attachments: List[Attachment] = []
    timestamp: Optional[int] = None
    parent_message_id: Optional[str] = None
    active_child_index: Optional[int] = 0 # Add to model

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
    message: str
    attachments: List[Attachment] = []
    character_id: Optional[str] = None # Allow setting character on creation

class GenerateRequest(BaseModel):
    model_name: str
    provider: Optional[str] = None
    # attachments: List[Attachment] = [] # Removed, attachments come from context now
    streaming: Optional[bool] = False
    new_branch: Optional[bool] = False # Flag for regeneration branching
    gen_args: Optional[Dict[str, Any]] = {}

class RawGenerateRequest(BaseModel):
    text: str
    model: str
    provider: Optional[str] = None
    streaming: Optional[bool] = False
    gen_args: Optional[Dict[str, Any]] = {}

class SetActiveCharacterRequest(BaseModel):
    character_id: Optional[str] = None

class Character(BaseModel):
    character_name: str
    sysprompt: str
    settings: Optional[Dict[str, Any]] = {}

class UpdateCharacterRequest(Character):
    pass # Inherits fields from Character

class SetActiveBranchRequest(BaseModel):
    child_index: int

# Helper functions
def create_message(chat_id, role, content, attachments=None, parent_message_id=None, model_name=None):
    if attachments is None:
        attachments = []

    message_id = str(uuid.uuid4())
    timestamp = int(time.time() * 1000) # Use milliseconds for potentially better ordering

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        cursor.execute(
            "INSERT INTO messages (message_id, chat_id, role, message, model_name, timestamp, parent_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (message_id, chat_id, role, content, model_name, timestamp, parent_message_id)
        )

        for attachment in attachments:
            attachment_id = str(uuid.uuid4())
            # Ensure content is string for DB
            attachment_content = attachment.content if isinstance(attachment.content, str) else str(attachment.content)
            cursor.execute(
                "INSERT INTO attachments (attachment_id, message_id, type, content) VALUES (?, ?, ?, ?)",
                (attachment_id, message_id, attachment.type, attachment_content)
            )

        # Update chat's timestamp
        cursor.execute("UPDATE chats SET timestamp_updated = ? WHERE chat_id = ?", (timestamp, chat_id))

        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        print(f"Error creating message: {e}")
        raise # Re-raise the exception
    finally:
        conn.close()

    return message_id

def get_message(message_id):
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM messages WHERE message_id = ?", (message_id,))
    message_data = cursor.fetchone()

    if not message_data:
        conn.close()
        return None

    cursor.execute("SELECT type, content FROM attachments WHERE message_id = ?", (message_id,))
    attachments = [{"type": row["type"], "content": row["content"]} for row in cursor.fetchall()]

    # Fetch child message IDs for UI branching controls
    cursor.execute("SELECT message_id FROM messages WHERE parent_message_id = ? ORDER BY timestamp", (message_id,))
    child_message_ids = [row["message_id"] for row in cursor.fetchall()]


    message = {
        "message_id": message_data["message_id"],
        "role": message_data["role"],
        "message": message_data["message"],
        "model_name": message_data["model_name"],
        "timestamp": message_data["timestamp"],
        "parent_message_id": message_data["parent_message_id"],
        "active_child_index": message_data["active_child_index"],
        "attachments": attachments,
        "child_message_ids": child_message_ids # Add this for UI
    }

    conn.close()
    return message

def get_chat_messages(chat_id):
    conn = get_db_connection()
    cursor = conn.cursor()

    # Fetch all messages for the chat, ordered by timestamp
    cursor.execute("SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp", (chat_id,))
    messages_data = cursor.fetchall()

    messages = []
    for message_data in messages_data:
        # Fetch attachments for each message
        cursor.execute("SELECT type, content FROM attachments WHERE message_id = ?", (message_data["message_id"],))
        # Add name to attachment if it exists (useful for files)
        attachments = []
        for row in cursor.fetchall():
            attach_data = {"type": row["type"], "content": row["content"]}
            # Try to extract filename if it's a file attachment
            if attach_data["type"] == "file":
                # Heuristic based on how it's stored: "filename:\n```..."
                try:
                    first_line = attach_data["content"].split('\n', 1)[0]
                    if ':' in first_line:
                         attach_data["name"] = first_line[:first_line.rindex(':')].strip()
                except Exception:
                    pass # Ignore errors extracting name
            attachments.append(attach_data)


        # Fetch child message IDs for UI branching controls
        cursor.execute("SELECT message_id FROM messages WHERE parent_message_id = ? ORDER BY timestamp", (message_data["message_id"],))
        child_message_ids = [row["message_id"] for row in cursor.fetchall()]

        message = {
            "message_id": message_data["message_id"],
            "role": message_data["role"],
            "message": message_data["message"],
            "model_name": message_data["model_name"],
            "timestamp": message_data["timestamp"],
            "parent_message_id": message_data["parent_message_id"],
            "active_child_index": message_data["active_child_index"],
            "attachments": attachments, # Attachments now potentially have name
            "child_message_ids": child_message_ids # Add this for UI
        }
        messages.append(message)

    conn.close()
    return messages

def get_active_message_context(chat_id, until_message_id=None):
    """
    Constructs the list of messages representing the currently active branch
    up to a certain point (or the end if until_message_id is None).
    This is used for sending context to the LLM.
    Includes system prompt.
    """
    conn = get_db_connection()
    cursor = conn.cursor()

    # Fetch all messages first
    cursor.execute("SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp", (chat_id,))
    all_messages_data = cursor.fetchall()
    all_messages_dict = {msg["message_id"]: dict(msg) for msg in all_messages_data}

    # Fetch attachments and add them
    for msg_id, msg_data in all_messages_dict.items():
        cursor.execute("SELECT type, content FROM attachments WHERE message_id = ?", (msg_id,))
        msg_data["attachments"] = [{"type": row["type"], "content": row["content"]} for row in cursor.fetchall()]
        # Add name for file attachments
        for attach in msg_data["attachments"]:
            if attach["type"] == "file":
                 try:
                    first_line = attach["content"].split('\n', 1)[0]
                    if ':' in first_line:
                         attach["name"] = first_line[:first_line.rindex(':')].strip()
                 except Exception: pass
        # Fetch children for traversal logic
        cursor.execute("SELECT message_id FROM messages WHERE parent_message_id = ? ORDER BY timestamp", (msg_id,))
        msg_data["child_ids"] = [row["message_id"] for row in cursor.fetchall()]


    active_context = []
    current_message_id = None

    # Find the root messages (no parent)
    root_ids = [msg_id for msg_id, msg in all_messages_dict.items() if msg["parent_message_id"] is None]
    if not root_ids:
        conn.close()
        return [] # Should not happen in a valid chat

    # Assume single root for now, or take the earliest? Let's take the earliest.
    root_ids.sort(key=lambda mid: all_messages_dict[mid]['timestamp'])
    current_message_id = root_ids[0] if root_ids else None

    stop_next_iteration = False
    while current_message_id:
        message = all_messages_dict.get(current_message_id)
        if not message: break # Should not happen

        # Add current message to context
        active_context.append({
            "role": message["role"],
            "message": message["message"],
            "attachments": message["attachments"]
            # Don't need other fields for LLM context
        })

        # If this is the 'until' message, stop after adding it.
        if current_message_id == until_message_id:
            break

        # Check if the loop should stop *after* this iteration
        if stop_next_iteration:
            break

        # Find the next message in the active branch
        child_ids = message.get("child_ids", [])
        if not child_ids:
            break # End of branch

        active_index = message.get("active_child_index", 0)
        if active_index >= len(child_ids):
            active_index = 0 # Default to first if index is out of bounds

        next_message_id = child_ids[active_index]

        # If the *next* message is the 'until' message, stop after the current iteration
        if next_message_id == until_message_id:
             stop_next_iteration = True

        current_message_id = next_message_id


    # Add system prompt if character is set
    cursor.execute("SELECT c.sysprompt FROM characters c JOIN chats ch ON c.character_id = ch.character_id WHERE ch.chat_id = ?", (chat_id,))
    char_data = cursor.fetchone()
    if char_data and char_data["sysprompt"]:
         # Ensure system prompt isn't already the first message if roots were system messages (unlikely)
         if not active_context or active_context[0].get("role") != "system":
             active_context.insert(0, {"role": "system", "message": char_data["sysprompt"]})

    conn.close()
    # Filter out system message if it exists and is empty/None
    active_context = [msg for msg in active_context if not (msg["role"] == "system" and not msg.get("message"))]
    return active_context


# Generation Service
class GenerationService:
    def __init__(self, api_keys, model_configs):
        self.api_keys = api_keys
        self.model_configs = model_configs
        self.gen_args_keys = ["temperature", "min_p", "max_tokens", "top_p"] # Added top_p
        self.use_google = False # Simplify: Assume Google isn't configured unless explicitly checked
        if 'google' in self.api_keys and self.api_keys['google']:
            try:
                import google.generativeai as genai
                genai.configure(api_key=self.api_keys['google'])
                self.use_google = True
            except ImportError:
                print("WARN: Google API key found but 'google-generativeai' package not installed.")
            except Exception as e:
                print(f"WARN: Failed to configure Google AI: {e}")


    def _format_messages_for_provider(self, messages, provider):
         # Common formatting first
        base_formatted = []
        for msg in messages:
            role = "assistant" if msg["role"] == "llm" else msg["role"] # OpenRouter/Local standard
            if provider == "google":
                role = "model" if msg["role"] == "llm" else msg["role"] # Google standard

            content_parts = []
            # Add text part first if message exists
            if msg.get("message"):
                 if provider == "google":
                     content_parts.append(msg["message"])
                 else:
                     content_parts.append({"type": "text", "text": msg["message"]})

            # Add attachments
            for attachment in msg.get("attachments", []):
                if attachment["type"] == "image":
                    if provider == "google":
                         # Google expects parts format
                        content_parts.append({"inline_data": {"mime_type": "image/jpeg", "data": attachment['content']}})
                    else:
                         # OpenRouter/Local expect image_url format within content list
                        content_parts.append({
                            "type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{attachment['content']}"}
                        })
                elif attachment["type"] == "file":
                     # Extract raw content for embedding
                     raw_file_content = attachment['content']
                     try:
                         # Remove header like "filename.txt:\n```ext\n" and trailing "\n```"
                         lines = attachment['content'].split('\n')
                         if len(lines) > 2 and lines[0].endswith(':') and lines[1].startswith('```'):
                             raw_file_content = '\n'.join(lines[2:-1])
                     except Exception: pass # Keep original content if parsing fails

                     file_text = f"\n--- Attached File: {attachment.get('name', 'file.txt')} ---\n{raw_file_content}\n--- End File ---"
                     if provider == "google":
                         content_parts.append(file_text)
                     else:
                        # Find existing text part or add a new one
                        text_part = next((part for part in content_parts if part["type"] == "text"), None)
                        if text_part:
                             text_part["text"] += file_text
                        else:
                             content_parts.append({"type": "text", "text": file_text})

            # Construct the final message object based on provider format
            if provider == "google":
                # Skip messages with no parts (e.g., user message with only image?)
                if content_parts:
                    base_formatted.append({"role": role, "parts": content_parts})
            else:
                 # Skip messages with no content (e.g., empty user message?)
                 # Exception: Allow empty user message if it has attachments
                 if content_parts or (role == 'user' and msg.get("attachments")):
                    # If only attachments and no text, add a placeholder text for non-google models
                    if provider != 'google' and not any(p.get("type") == "text" for p in content_parts):
                        content_parts.insert(0, {"type": "text", "text": "[Image Attachment]"}) # Placeholder text
                    base_formatted.append({"role": role, "content": content_parts})


        # Ensure alternating user/assistant roles if required by provider (basic check)
        valid_sequence = []
        last_role = None
        for msg in base_formatted:
            current_role = msg['role']
            # Allow system message first
            if not valid_sequence and current_role == 'system':
                valid_sequence.append(msg)
                last_role = current_role
                continue
            # Skip consecutive messages of the same role (except system followed by user)
            if current_role == last_role and current_role != 'system':
                 print(f"WARN: Skipping consecutive message with role {current_role}")
                 continue
             # Ensure user follows system or assistant/model
            if last_role in ['system', 'assistant', 'model'] and current_role != 'user':
                 print(f"WARN: Expected 'user' role after '{last_role}', got '{current_role}'. Skipping.")
                 continue
             # Ensure assistant/model follows user
            if last_role == 'user' and current_role not in ['assistant', 'model']:
                 print(f"WARN: Expected 'assistant' or 'model' role after 'user', got '{current_role}'. Skipping.")
                 continue

            valid_sequence.append(msg)
            last_role = current_role

        # Google specific: Ensure last message is 'user' role if needed by API?
        # Let's assume the API handles this or the sequence check is sufficient.

        return valid_sequence # Use the potentially filtered sequence

    async def _execute_request(self, url, headers, payload, stream):
        global cancel_event
        cancel_event = Event()
        chunk_queue = Queue()
        request_exception = None
        thread_started = Event()
        response = None # Define response outside try

        def make_request():
            nonlocal request_exception, response # Allow modification
            try:
                with requests.Session() as session:
                    response = session.post(url, headers=headers, json=payload, stream=True, timeout=300) # 5 min timeout
                    thread_started.set() # Signal that the request has been sent

                    if response.status_code != 200:
                         error_detail = response.text # Read error even if streaming
                         response.close() # Ensure connection is closed
                         request_exception = HTTPException(status_code=response.status_code, detail=f"API Error ({response.status_code}): {error_detail[:500]}") # Limit error length
                         chunk_queue.put("[DONE]") # Signal end even on error
                         return

                    try:
                        for line in response.iter_lines():
                            if cancel_event.is_set():
                                print("Cancellation requested, stopping stream read.")
                                break
                            if line:
                                decoded_line = line.decode("utf-8", errors='ignore').strip()
                                if decoded_line: # Don't send empty lines
                                    chunk_queue.put(decoded_line)
                        chunk_queue.put("[DONE]")  # Signal completion (or cancellation)
                    except requests.exceptions.RequestException as e: # Catch potential errors during iter_lines
                         print(f"WARN: RequestException during streaming: {e}")
                         request_exception = HTTPException(status_code=503, detail=f"Streaming error: {e}")
                         chunk_queue.put("[DONE]")
                    except Exception as e:
                         print(f"ERROR: Unhandled exception during stream reading: {e}")
                         request_exception = HTTPException(status_code=500, detail=f"Internal streaming error: {e}")
                         chunk_queue.put("[DONE]")
                    # Removed finally block closing response here, moved outside try/except requests

            except requests.exceptions.RequestException as e:
                 thread_started.set() # Set even if connection fails
                 print(f"ERROR: API request failed: {e}")
                 request_exception = HTTPException(status_code=503, detail=f"API connection error: {e}")
                 chunk_queue.put("[DONE]") # Signal end on connection error
            except Exception as e:
                 thread_started.set() # Set on any initial error
                 print(f"ERROR: Unexpected error in request thread: {e}")
                 request_exception = HTTPException(status_code=500, detail=f"Unexpected error: {e}")
                 chunk_queue.put("[DONE]")
            finally:
                 # Ensure the response is closed if it exists and is not already closed
                 # Check if 'response' exists and has a 'closed' attribute
                 if response is not None and hasattr(response, 'closed') and not response.closed:
                     try:
                         response.close()
                         print("Stream response closed.")
                     except Exception as close_err:
                          print(f"WARN: Error closing response stream: {close_err}")
                 elif response is not None and not hasattr(response, 'closed'):
                      # Handle cases where response object might not have 'closed' (less likely with requests)
                      print("WARN: Response object does not have 'closed' attribute, cannot explicitly close.")


        stream_thread = Thread(target=make_request)
        stream_thread.start()

        # Wait briefly for the thread to start and potentially hit an immediate error
        thread_started.wait(timeout=10) # Wait up to 10s for request initiation

        async def stream_generator():
            while True:
                if request_exception:
                    print(f"Propagating request exception: {request_exception.detail}")
                    # Format error as SSE
                    yield f"data: {json.dumps({'error': request_exception.detail})}\n\n"
                    yield f"data: [DONE]\n\n" # Ensure DONE is sent even after error
                    break
                try:
                    # Use timeout with get to prevent blocking indefinitely if thread dies unexpectedly
                    chunk = chunk_queue.get(timeout=0.1)
                    if chunk == "[DONE]":
                        # Check if cancellation happened before yielding DONE
                        if cancel_event.is_set():
                             yield f"data: {json.dumps({'status': 'cancelled'})}\n\n"
                        yield "data: [DONE]\n\n"
                        break
                    else:
                        yield f"{chunk}\n\n" # Pass raw line, might be SSE already
                except Empty: # Queue is empty, check thread status
                     if not stream_thread.is_alive() and chunk_queue.empty():
                         print("WARN: Stream thread finished, queue empty, but [DONE] not received. Assuming completion or error.")
                         # If an exception happened, it should have been caught already.
                         # If no exception, assume normal finish but DONE was missed?
                         if cancel_event.is_set():
                              yield f"data: {json.dumps({'status': 'cancelled'})}\n\n"
                         yield "data: [DONE]\n\n"
                         break
                     # If thread is alive, just wait briefly for more data
                     await asyncio.sleep(0.02)
                except Exception as gen_err:
                     print(f"ERROR in stream_generator loop: {gen_err}")
                     yield f"data: {json.dumps({'error': f'Generator error: {gen_err}'})}\n\n"
                     yield f"data: [DONE]\n\n"
                     break


            # Wait for the thread to actually finish after loop exits
            stream_thread.join(timeout=5)
            if stream_thread.is_alive():
                 print("WARN: Streaming thread did not exit cleanly after generator finished.")


        if stream:
            return stream_generator(), True
        else:
            # Consume the generator to get the full response (non-streaming)
            full_response_lines = []
            final_status = 'completed'
            async for chunk in stream_generator():
                 if chunk.strip() == "data: [DONE]":
                     break
                 if chunk.startswith("data: "): # Handle SSE format even in non-streaming case
                      data = chunk[6:].strip()
                      try:
                          json_data = json.loads(data)
                          if 'error' in json_data:
                               # If error occurs, store it and stop accumulating?
                               print(f"Error received during non-stream accumulation: {json_data['error']}")
                               # Should we raise the exception here?
                               # For now, let's just store the error detail and break maybe?
                               # Or rely on request_exception which should also be set.
                               final_status = 'error' # Mark as error
                               # Let's continue accumulating for now, might get more info
                               # continue
                          if json_data.get('status') == 'cancelled':
                               final_status = 'cancelled'
                               print("Cancellation detected during non-stream accumulation.")
                               # break # Stop accumulating on cancel

                          # OpenRouter/Local format
                          content = json_data.get("choices", [{}])[0].get("delta", {}).get("content")
                          if content is None:
                              # Maybe it's a direct content chunk (Google or non-standard)
                               content = json_data.get("text") or json_data.get("content")
                          if content:
                               full_response_lines.append(content)
                      except json.JSONDecodeError:
                           if data:
                                print(f"WARN: Received non-JSON data chunk: {data}")
                                full_response_lines.append(data)
                 elif chunk.strip():
                     print(f"WARN: Received non-SSE line: {chunk.strip()}")
                     full_response_lines.append(chunk.strip())


            if request_exception:
                 # If an error occurred during accumulation, raise it
                 raise request_exception

            final_text = "".join(full_response_lines)
            # Return status along with text for non-streaming too
            return final_text, False, final_status

    # ... (generate_with_openrouter, generate_with_google, generate_with_local remain largely the same, calling _execute_request) ...
    async def generate_with_openrouter(self, messages, model_name, gen_args, stream):
        if 'openrouter' not in self.api_keys or not self.api_keys['openrouter']:
            raise HTTPException(status_code=400, detail="OpenRouter API key not configured")

        formatted_messages = self._format_messages_for_provider(messages, "openrouter")
        if not formatted_messages:
             raise HTTPException(status_code=400, detail="No valid messages to send after formatting.")

        payload = {
            "model": model_name,
            "messages": formatted_messages,
            "stream": True, # Always request stream from backend for unified handling
             **{k: v for k, v in gen_args.items() if k in self.gen_args_keys and v is not None} # Filter None values
        }

        headers = {
            "Authorization": f"Bearer {self.api_keys['openrouter']}",
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:8000", # Referer might be required
            "X-Title": "ZeryoChat" # Title might be required
        }

        return await self._execute_request("https://openrouter.ai/api/v1/chat/completions", headers, payload, stream)


    async def generate_with_google(self, messages, model_name, gen_args, stream):
         if not self.use_google:
             raise HTTPException(status_code=400, detail="Google AI not configured or package not installed")
         import google.generativeai as genai # Import here to ensure it's checked

         formatted_messages = self._format_messages_for_provider(messages, "google")
         if not formatted_messages:
             raise HTTPException(status_code=400, detail="No valid messages to send after formatting for Google.")

         # Google uses GenerationConfig
         generation_config_dict = {k: v for k, v in gen_args.items() if k in self.gen_args_keys and v is not None}
         # Map API arg names to Google names if needed (e.g., max_tokens -> max_output_tokens)
         if 'max_tokens' in generation_config_dict:
              generation_config_dict['max_output_tokens'] = generation_config_dict.pop('max_tokens')
         # Add other mappings if necessary (e.g., min_p is not directly supported, maybe map to top_p/top_k?)
         if 'temperature' in generation_config_dict and generation_config_dict['temperature'] is None:
             del generation_config_dict['temperature'] # Google doesn't like null temp

         generation_config = genai.types.GenerationConfig(**generation_config_dict) if generation_config_dict else None

         try:
             genai_model = genai.GenerativeModel(model_name)
             # Use generate_content_async for non-blocking calls
             response = await genai_model.generate_content_async(
                 formatted_messages,
                 generation_config=generation_config,
                 stream=stream
             )

             if stream:
                 async def google_stream_generator():
                     response_iterator = None # Define before try
                     try:
                         response_iterator = await response.__aiter__() # Get async iterator
                         while True:
                            # Check for cancellation before awaiting next chunk
                             global cancel_event
                             if cancel_event and cancel_event.is_set():
                                  print("Cancellation detected, stopping Google stream iterator.")
                                  break
                             try:
                                 # Await the next chunk from the iterator
                                 chunk = await response_iterator.__anext__()
                                 if hasattr(chunk, 'text'):
                                      yield f"data: {json.dumps({'content': chunk.text})}\n\n"
                                 elif hasattr(chunk, 'parts'):
                                      text_parts = [part.text for part in chunk.parts if hasattr(part, 'text')]
                                      if text_parts:
                                           yield f"data: {json.dumps({'content': ''.join(text_parts)})}\n\n"
                             except StopAsyncIteration:
                                 # Stream finished normally
                                 break
                             except Exception as chunk_err:
                                 print(f"ERROR reading Google stream chunk: {chunk_err}")
                                 yield f"data: {json.dumps({'error': f'Google chunk error: {str(chunk_err)}'})}\n\n"
                                 break # Stop on chunk error

                         # After loop finishes (normally or cancelled)
                         if cancel_event and cancel_event.is_set():
                              yield f"data: {json.dumps({'status': 'cancelled'})}\n\n"
                         yield "data: [DONE]\n\n"

                     except Exception as e:
                          print(f"ERROR: Google streaming setup/iteration error: {e}")
                          yield f"data: {json.dumps({'error': f'Google stream error: {str(e)}'})}\n\n"
                          yield "data: [DONE]\n\n" # Ensure DONE is sent after error
                     finally:
                          # Clean up Google stream resources if possible? Usually handled by context manager or iteration end.
                          # No explicit close needed for async iterator typically.
                          pass

                 return google_stream_generator(), True
             else:
                 # Handle potential blocked responses for non-streaming
                 try:
                      # Accessing response.text forces resolution
                      final_text = response.text
                      return final_text, False, 'completed'
                 except Exception as e:
                      # Check if it's a BlockedPromptException or similar
                      block_reason = "Unknown (access error)"
                      if hasattr(response, 'prompt_feedback') and hasattr(response.prompt_feedback, 'block_reason'):
                           block_reason = response.prompt_feedback.block_reason
                      elif "block" in str(e).lower(): # General check in error message
                           block_reason = f"Blocked response ({e})"

                      error_detail = f"Google response blocked or failed: {block_reason}"
                      print(f"WARN: {error_detail}")
                      # Raise HTTPException for blocked/failed non-streaming responses
                      raise HTTPException(status_code=400, detail=error_detail)

         except Exception as e:
             # Catch potential API errors (invalid key, quota, etc.) during setup
             print(f"ERROR: Google API call setup failed: {e}")
             raise HTTPException(status_code=500, detail=f"Google AI generation error: {str(e)}")


    async def generate_with_local(self, messages, model_name, gen_args, stream):
        if 'local_base_url' not in self.api_keys or not self.api_keys['local_base_url']:
            raise HTTPException(status_code=400, detail="Local API base URL not configured")
        local_base_url = self.api_keys['local_base_url']

        formatted_messages = self._format_messages_for_provider(messages, "local")
        if not formatted_messages:
             raise HTTPException(status_code=400, detail="No valid messages to send after formatting.")

        payload = {
            "model": model_name, # Use the provided model name
            "messages": formatted_messages,
            "stream": True, # Always request stream
             **{k: v for k, v in gen_args.items() if k in self.gen_args_keys and v is not None}
        }
        # Add options dict for Ollama compatibility if needed
        # if 'options' in payload: # Or check provider hint?
        #     payload['options'] = {k: v for k, v in gen_args.items() if k in self.gen_args_keys and v is not None}

        # Local APIs might not require auth headers
        headers = {"Content-Type": "application/json"}
        api_key = self.api_keys.get('local_api_key')
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"


        # Determine the correct endpoint (check common ones)
        # Try OpenAI compatible endpoint first
        endpoint = f"{local_base_url.strip('/')}/v1/chat/completions"
        # Add more potential endpoints if needed (e.g., /api/generate for Ollama)

        return await self._execute_request(endpoint, headers, payload, stream)

    async def generate(self, messages, model_name, provider=None, gen_args=None, stream=False):
        if gen_args is None:
            gen_args = {}

        # Determine provider from model config or default to openrouter
        selected_provider = provider
        if not selected_provider:
             model_config = next((m for m in self.model_configs.get('models', []) if m.get('name') == model_name), None) # Changed key to 'name'
             selected_provider = model_config.get('provider', 'openrouter') if model_config else 'openrouter'

        print(f"Generating with model '{model_name}' via provider '{selected_provider}' (stream={stream})")
        # print(f"Context messages: {json.dumps(messages, indent=2)}") # DEBUG
        print(f"Gen args: {gen_args}")

        if selected_provider.lower() == "openrouter":
            return await self.generate_with_openrouter(messages, model_name, gen_args, stream)
        elif selected_provider.lower() == "google":
            return await self.generate_with_google(messages, model_name, gen_args, stream)
        elif selected_provider.lower() == "local":
            # For local, find the *actual* model identifier if 'model_name' is just a display name
            model_config = next((m for m in self.model_configs.get('models', []) if m.get('name') == model_name), None)
            local_model_id = model_config.get('model_identifier', model_name) if model_config else model_name # Use 'model_identifier' if present
            return await self.generate_with_local(messages, local_model_id, gen_args, stream)
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported provider: {selected_provider}")

# Initialize generation service
generation_service = GenerationService(api_keys, model_configs)

# --- API Endpoints ---

@app.get("/health")
async def health_check():
    providers = []
    if 'openrouter' in api_keys and api_keys['openrouter']: providers.append("openrouter")
    if generation_service.use_google: providers.append("google")
    if 'local_base_url' in api_keys and api_keys['local_base_url']: providers.append("local")
    return {"status": "ok", "version": "1.1.1-branching", "providers": providers}

@app.get("/models")
async def get_available_models():
    available_models = []
    for model_config in model_configs.get('models', []):
        model_name = model_config.get('name') # Use 'name' as the primary ID/display name key
        if not model_name: continue # Skip if no name defined

        provider = model_config.get('provider', 'openrouter')
        supports_images = model_config.get('supports_images', False) # Default to False
        # Use name directly as display name, or allow override? Let's use name for now.
        # Clean up potential path separators for display
        display_name = model_name.split('/')[-1].replace('-', ' ').replace('_', ' ').title()

        # Add provider prefix for clarity if multiple providers have same model base name?
        # display_name = f"[{provider.upper()}] {display_name}" # Optional prefix

        available_models.append({
            "name": model_name, # This is the ID used in API calls
            "displayName": display_name,
            "supportsImages": supports_images,
            "provider": provider
        })
    return available_models

# ... (Character endpoints remain the same) ...
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
        # Provide more specific error if it's a UNIQUE constraint violation
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
        # Character FK in chats is ON DELETE SET NULL, so no need to update chats manually
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
    chat_id = str(uuid.uuid4())
    timestamp = int(time.time() * 1000)
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        # Validate character_id if provided
        if request.character_id:
             cursor.execute("SELECT character_id FROM characters WHERE character_id = ?", (request.character_id,))
             if not cursor.fetchone():
                  raise HTTPException(status_code=404, detail="Character not found")

        cursor.execute("INSERT INTO chats (chat_id, timestamp_created, timestamp_updated, character_id) VALUES (?, ?, ?, ?)",
                       (chat_id, timestamp, timestamp, request.character_id))
        conn.commit()
        conn.close() # Close connection before calling create_message

        # Add the initial user message if present
        if request.message or request.attachments:
             create_message(chat_id, "user", request.message or " ", request.attachments) # Use space if message empty but attachments exist
    except sqlite3.Error as e:
        # Ensure connection is closed on error too
        if 'conn' in locals() and conn: conn.close()
        raise HTTPException(status_code=500, detail=f"Database error: {e}")

    return {"chat_id": chat_id}

# ... (get_chats, get_chat, delete_chat, set_active_character remain largely the same) ...
@app.get("/chat/get_chats", response_model=List[ChatListItem])
async def get_chats(offset: int = 0, limit: int = 50):
    conn = get_db_connection()
    cursor = conn.cursor()

    # Get chat IDs ordered by update time
    cursor.execute("SELECT chat_id, timestamp_updated FROM chats ORDER BY timestamp_updated DESC LIMIT ? OFFSET ?", (limit, offset))
    chat_infos = cursor.fetchall()

    chat_list = []
    for row in chat_infos:
        chat_id = row["chat_id"]
        # Fetch the *last user message* in the primary branch for preview
        # This is complex with branching. Let's just fetch the *very last user message* by timestamp for simplicity.
        cursor.execute("""
            SELECT message FROM messages
            WHERE chat_id = ? AND role = 'user'
            ORDER BY timestamp DESC
            LIMIT 1
        """, (chat_id,))
        last_user_msg = cursor.fetchone()
        preview_text = "Empty Chat"
        if last_user_msg and last_user_msg["message"] and last_user_msg["message"].strip() != "":
             preview_text = last_user_msg["message"][:50].strip() + ("..." if len(last_user_msg["message"]) > 50 else "")
        elif last_user_msg: # Message exists but might be empty (e.g., only attachment)
             cursor.execute("SELECT COUNT(*) as count FROM attachments WHERE message_id = ?", (last_user_msg['message_id'],))
             attach_count = cursor.fetchone()['count']
             if attach_count > 0:
                  preview_text = "[Attachment Message]"
             else: # No text and no attachments
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
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM chats WHERE chat_id = ?", (chat_id,))
    chat_data = cursor.fetchone()
    if not chat_data:
        conn.close()
        raise HTTPException(status_code=404, detail="Chat not found")
    conn.close() # Close before getting messages

    messages = get_chat_messages(chat_id) # Gets *all* messages

    # System prompt is now handled dynamically by get_active_message_context
    # and the frontend displays it via displayActiveSystemPrompt.
    # We don't need to inject it into the main messages list sent to frontend.

    chat = Chat(
        chat_id=chat_data["chat_id"],
        timestamp_created=chat_data["timestamp_created"],
        timestamp_updated=chat_data["timestamp_updated"],
        character_id=chat_data["character_id"],
        messages=messages # Send only non-system messages
    )
    return chat

@app.delete("/chat/{chat_id}")
async def delete_chat(chat_id: str):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT chat_id FROM chats WHERE chat_id = ?", (chat_id,))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Chat not found")

    try:
        # ON DELETE CASCADE handles deleting messages and attachments now
        cursor.execute("DELETE FROM chats WHERE chat_id = ?", (chat_id,))
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {e}")
    finally:
        conn.close()
    return {"status": "ok"}

@app.post("/chat/{chat_id}/set_active_character")
async def set_active_character(chat_id: str, request: SetActiveCharacterRequest):
    character_id = request.character_id
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT chat_id FROM chats WHERE chat_id = ?", (chat_id,))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Chat not found")

    if character_id:
        cursor.execute("SELECT character_id FROM characters WHERE character_id = ?", (character_id,))
        if not cursor.fetchone():
            conn.close()
            raise HTTPException(status_code=404, detail="Character not found")

    try:
        cursor.execute("UPDATE chats SET character_id = ? WHERE chat_id = ?", (character_id, chat_id))
        # Update chat timestamp to reflect change? Optional.
        # timestamp = int(time.time() * 1000)
        # cursor.execute("UPDATE chats SET timestamp_updated = ? WHERE chat_id = ?", (timestamp, chat_id))
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {e}")
    finally:
        conn.close()
    return {"status": "ok"}


# --- Message Endpoints ---

@app.post("/chat/{chat_id}/add_message", response_model=Dict[str, str])
async def add_message(chat_id: str, message: Message):
    # First check if chat exists
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT chat_id FROM chats WHERE chat_id = ?", (chat_id,))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Chat not found")
    conn.close() # Close check connection

    # Get all messages to determine parent
    all_messages = get_chat_messages(chat_id) # Fetch all messages with structure
    parent_message_id = None
    if all_messages:
        # Rebuild active path to find the true last message
        message_map = {m['message_id']: m for m in all_messages}
        roots = [m for m in all_messages if not m['parent_message_id']]
        if roots:
            roots.sort(key=lambda m: m['timestamp'])
            current_node_id = roots[0]['message_id']
            last_valid_id = None
            while current_node_id:
                last_valid_id = current_node_id
                node = message_map.get(current_node_id)
                if not node: break
                children = [m for m in all_messages if m['parent_message_id'] == current_node_id]
                if not children: break
                children.sort(key=lambda m: m['timestamp'])
                active_idx = node.get('active_child_index', 0)
                if active_idx >= len(children): active_idx = 0
                current_node_id = children[active_idx]['message_id']
            parent_message_id = last_valid_id

    # Create the new message
    try:
        message_id = create_message(
            chat_id,
            message.role,
            message.message,
            message.attachments,
            parent_message_id, # Link to last active message
            message.model_name
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to add message: {e}")

    return {"message_id": message_id}


@app.post("/chat/{chat_id}/delete_message/{message_id}")
async def delete_message(chat_id: str, message_id: str):
    # ON DELETE CASCADE in schema handles descendants and attachments
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT message_id FROM messages WHERE message_id = ? AND chat_id = ?", (message_id, chat_id))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Message not found")

    try:
        cursor.execute("DELETE FROM messages WHERE message_id = ?", (message_id,))
        conn.commit()

        # Update chat timestamp
        timestamp = int(time.time() * 1000)
        cursor.execute("UPDATE chats SET timestamp_updated = ? WHERE chat_id = ?", (timestamp, chat_id))
        conn.commit()

    except sqlite3.Error as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {e}")
    finally:
        conn.close()
    return {"status": "ok"}


# ... (edit_message, set_active_branch remain largely the same) ...
@app.post("/chat/{chat_id}/edit_message/{message_id}")
async def edit_message(chat_id: str, message_id: str, message: Message):
    # Editing only changes the content of a specific message node.
    # It does not affect branching structure.
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT role FROM messages WHERE message_id = ? AND chat_id = ?", (message_id, chat_id))
    original_msg_data = cursor.fetchone()
    if not original_msg_data:
        conn.close()
        raise HTTPException(status_code=404, detail="Message not found")

    # Prevent changing role on edit? Let's enforce keeping original role.
    if message.role != original_msg_data['role']:
        conn.close()
        raise HTTPException(status_code=400, detail="Cannot change message role during edit.")

    try:
        timestamp = int(time.time() * 1000)
        cursor.execute("UPDATE messages SET message = ?, model_name = ?, timestamp = ? WHERE message_id = ?",
                       (message.message, message.model_name, timestamp, message_id))

        # Update attachments (delete old, insert new)
        cursor.execute("DELETE FROM attachments WHERE message_id = ?", (message_id,))
        for attachment in message.attachments:
            attachment_id = str(uuid.uuid4())
            attachment_content = attachment.content if isinstance(attachment.content, str) else str(attachment.content)
            cursor.execute("INSERT INTO attachments (attachment_id, message_id, type, content) VALUES (?, ?, ?, ?)",
                           (attachment_id, message_id, attachment.type, attachment_content))

        # Update chat timestamp
        cursor.execute("UPDATE chats SET timestamp_updated = ? WHERE chat_id = ?", (timestamp, chat_id))
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {e}")
    finally:
        conn.close()
    return {"status": "ok"}


@app.post("/chat/{chat_id}/set_active_branch/{parent_message_id}")
async def set_active_branch(chat_id: str, parent_message_id: str, request: SetActiveBranchRequest):
    new_index = request.child_index
    conn = get_db_connection()
    cursor = conn.cursor()

    # Validate parent message exists
    cursor.execute("SELECT message_id FROM messages WHERE message_id = ? AND chat_id = ?", (parent_message_id, chat_id))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Parent message not found")

    # Validate index is within bounds
    cursor.execute("SELECT COUNT(*) as count FROM messages WHERE parent_message_id = ?", (parent_message_id,))
    count = cursor.fetchone()["count"]
    if not (0 <= new_index < count):
        conn.close()
        raise HTTPException(status_code=400, detail=f"Invalid child index {new_index} for {count} children.")

    try:
        cursor.execute("UPDATE messages SET active_child_index = ? WHERE message_id = ?", (new_index, parent_message_id))
        # Update chat timestamp to reflect change
        timestamp = int(time.time() * 1000)
        cursor.execute("UPDATE chats SET timestamp_updated = ? WHERE chat_id = ?", (timestamp, chat_id))
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {e}")
    finally:
        conn.close()
    return {"status": "ok"}

# --- Generation Endpoints ---

async def handle_generation(
        chat_id: str,
        request: GenerateRequest,
        context_messages: List[Dict],
        background_tasks: BackgroundTasks,
        existing_message_id: Optional[str] = None, # ID of message being regenerated/continued
        operation: str = "generate" # 'generate', 'regenerate', 'continue'
    ):
    """Handles generation, regeneration, and continuation logic."""
    global cancel_event # Allow modification
    cancel_event = None # Reset cancellation flag for new generation

    is_continuation = operation == "continue"
    is_regeneration = operation == "regenerate"
    original_content_for_continue = ""

    if is_continuation:
        # Fetch original content for appending
        temp_conn = get_db_connection()
        temp_cursor = temp_conn.cursor()
        temp_cursor.execute("SELECT message FROM messages WHERE message_id = ?", (existing_message_id,))
        msg_data = temp_cursor.fetchone()
        temp_conn.close()
        if msg_data:
            original_content_for_continue = msg_data["message"]
        else:
            raise HTTPException(status_code=404, detail="Message to continue not found during generation handling")

    # --- Call Generation Service ---
    generation_result = await generation_service.generate(
        context_messages, request.model_name, request.provider, request.gen_args, request.streaming
    )

    if request.streaming:
        response_generator, _ = generation_result # Unpack generator
        accumulated_text = [] # Use list to accumulate chunks

        async def stream_generator_with_sse():
            nonlocal accumulated_text
            final_message_id = None
            was_cancelled = False
            try:
                async for chunk in response_generator:
                    # Stop processing if cancellation was requested externally
                    if cancel_event and cancel_event.is_set():
                        print("SSE generator detected cancellation.")
                        was_cancelled = True
                        yield f"data: {json.dumps({'status': 'cancelled'})}\n\n"
                        break # Stop sending chunks

                    if chunk.strip().lower() == "data: [done]":
                         # Stream finished normally, break to process final message
                         break

                    elif chunk.strip(): # Process actual content chunks
                        try:
                             # Handle potential raw text or SSE formatted chunks
                             data_to_parse = chunk
                             if chunk.startswith("data: "):
                                 data_to_parse = chunk[6:].strip()

                             if not data_to_parse: continue # Skip empty data lines

                             json_data = json.loads(data_to_parse)
                             content = None
                             if 'error' in json_data:
                                 print(f"ERROR from stream: {json_data['error']}")
                                 yield f"data: {json.dumps({'error': json_data['error']})}\n\n"
                                 continue # Skip adding error to accumulated text

                             # Check for explicit cancellation message from backend generator
                             if json_data.get('status') == 'cancelled':
                                  was_cancelled = True
                                  print("Backend generator signalled cancellation.")
                                  yield f"data: {json.dumps({'status': 'cancelled'})}\n\n"
                                  break

                             # Try OpenRouter/Local format
                             content = json_data.get("choices", [{}])[0].get("delta", {}).get("content")
                             if content is None:
                                  # Try Google format or direct content
                                 content = json_data.get("text") or json_data.get("content")

                             if content: # Append and yield if content exists
                                 accumulated_text.append(content)
                                 # Yield *only* the new content for UI update
                                 yield f"data: {json.dumps({'content': content})}\n\n"

                        except json.JSONDecodeError:
                             print(f"WARN: Received non-JSON stream line: {chunk}")
                        except Exception as parse_err:
                            print(f"ERROR parsing stream chunk: {chunk}, Error: {parse_err}")
                            yield f"data: {json.dumps({'error': f'Error processing stream data: {parse_err}'})}\n\n"

                # --- After loop (finished or cancelled) ---
                final_text = "".join(accumulated_text).strip()

                if not final_text and not was_cancelled:
                    print("WARN: Stream ended with no content and was not cancelled.")
                    # Yield completion but don't save empty message?
                    yield "data: [DONE]\n\n"
                    return # Exit generator

                if is_continuation:
                    final_text = original_content_for_continue + final_text # Append

                # --- Database saving logic (even for cancellation) ---
                conn_save = get_db_connection()
                cursor_save = conn_save.cursor()
                timestamp = int(time.time() * 1000)
                saved_message_id = None
                try:
                     if is_regeneration and request.new_branch:
                         # Find parent of the message being branched FROM
                         cursor_save.execute("SELECT parent_message_id FROM messages WHERE message_id = ?", (existing_message_id,))
                         parent_row = cursor_save.fetchone()
                         parent_id_for_branch = parent_row['parent_message_id'] if parent_row else None
                         if not parent_id_for_branch: raise ValueError("Cannot branch from message with no parent.")

                         saved_message_id = str(uuid.uuid4())
                         cursor_save.execute(
                             "INSERT INTO messages (message_id, chat_id, role, message, model_name, timestamp, parent_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
                             (saved_message_id, chat_id, "llm", final_text, request.model_name, timestamp, parent_id_for_branch)
                         )
                         # Update parent's active index
                         cursor_save.execute("SELECT message_id FROM messages WHERE parent_message_id = ? ORDER BY timestamp", (parent_id_for_branch,))
                         children_ids = [row['message_id'] for row in cursor_save.fetchall()]
                         new_idx = children_ids.index(saved_message_id) if saved_message_id in children_ids else len(children_ids) - 1
                         cursor_save.execute("UPDATE messages SET active_child_index = ? WHERE message_id = ?", (new_idx, parent_id_for_branch))

                     elif is_regeneration or is_continuation: # Replace existing message (or update continued one)
                         saved_message_id = existing_message_id
                         cursor_save.execute("UPDATE messages SET message = ?, model_name = ?, timestamp = ? WHERE message_id = ?",
                                            (final_text, request.model_name, timestamp, saved_message_id))
                     else: # Generate new message
                         # Find parent (last message in active context *before* this new one)
                         last_context_msg = context_messages[-1] if context_messages else None
                         parent_id = None
                         if last_context_msg:
                              # Find ID of the last message in context (need to query DB?)
                              # Simplified: Assume last context message ID is discoverable via its content/role? Risky.
                              # Robust: Re-query active path up to the point *before* generation started.
                              active_context_ids = []
                              all_msgs_before = get_chat_messages(chat_id) # Get state *before* this generation
                              # Filter out the placeholder if it exists locally? No, rely on DB state.
                              msg_map = {m['message_id']: m for m in all_msgs_before}
                              roots = [m for m in all_msgs_before if not m['parent_message_id']]
                              if roots:
                                   roots.sort(key=lambda m: m['timestamp'])
                                   curr_id = roots[0]['message_id']
                                   last_id = None
                                   while curr_id:
                                        last_id = curr_id
                                        node = msg_map.get(curr_id)
                                        if not node: break
                                        children = [m for m in all_msgs_before if m['parent_message_id'] == curr_id]
                                        if not children: break
                                        children.sort(key=lambda m: m['timestamp'])
                                        idx = node.get('active_child_index', 0)
                                        if idx >= len(children): idx = 0
                                        curr_id = children[idx]['message_id']
                                   parent_id = last_id

                         saved_message_id = str(uuid.uuid4())
                         cursor_save.execute(
                             "INSERT INTO messages (message_id, chat_id, role, message, model_name, timestamp, parent_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
                             (saved_message_id, chat_id, "llm", final_text, request.model_name, timestamp, parent_id)
                         )

                     # Update chat timestamp
                     cursor_save.execute("UPDATE chats SET timestamp_updated = ? WHERE chat_id = ?", (timestamp, chat_id))
                     conn_save.commit()
                     final_message_id = saved_message_id # Store the ID for final signal
                     print(f"Saved message {final_message_id} (Cancelled: {was_cancelled})")
                     # Yield confirmation even if cancelled, indicating partial save
                     yield f"data: {json.dumps({'message_id': final_message_id, 'complete': True, 'cancelled': was_cancelled})}\n\n"

                except Exception as db_err:
                     conn_save.rollback()
                     print(f"ERROR: Database save failed after stream: {db_err}")
                     yield f"data: {json.dumps({'error': f'Failed to save message: {db_err}', 'complete': True})}\n\n"
                finally:
                     conn_save.close()

                yield "data: [DONE]\n\n" # Final DONE signal

            except Exception as e:
                 # Handle errors during the async iteration itself
                 print(f"ERROR: Exception during stream processing: {e}")
                 yield f"data: {json.dumps({'error': str(e)})}\n\n"
                 yield "data: [DONE]\n\n" # Ensure DONE is sent after error

        return StreamingResponse(stream_generator_with_sse(), media_type="text/event-stream")
    else: # Non-streaming case
        response_text, _, status = generation_result # Unpack text and status
        response_text = response_text.strip()

        # Handle cancellation or error in non-streaming case
        if status == 'cancelled':
            print("WARN: Non-streaming generation cancelled partway through.")
            # Use partially accumulated text
        elif status == 'error':
            print("ERROR: Non-streaming generation failed.")
            # Decide how to handle - raise exception or return error message?
            # Let's use the partially accumulated text if available, otherwise raise.
            if not response_text:
                 raise HTTPException(status_code=500, detail="Generation failed (non-streaming)")

        if not response_text:
             print("WARN: Non-streaming generation returned empty.")
             return {"message": "", "role": "llm", "model_name": request.model_name, "attachments": [], "message_id": None }

        if is_continuation:
             response_text = original_content_for_continue + response_text # Append

        # --- Database saving logic (non-streaming) ---
        conn = get_db_connection()
        cursor = conn.cursor()
        saved_message_id = None
        timestamp = int(time.time() * 1000)
        try:
            if is_regeneration and request.new_branch:
                cursor.execute("SELECT parent_message_id FROM messages WHERE message_id = ?", (existing_message_id,))
                parent_row = cursor.fetchone(); parent_id_for_branch = parent_row['parent_message_id'] if parent_row else None
                if not parent_id_for_branch: raise ValueError("Cannot branch from message with no parent.")
                saved_message_id = str(uuid.uuid4())
                cursor.execute("INSERT INTO messages (message_id, chat_id, role, message, model_name, timestamp, parent_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)", (saved_message_id, chat_id, "llm", response_text, request.model_name, timestamp, parent_id_for_branch))
                cursor.execute("SELECT message_id FROM messages WHERE parent_message_id = ? ORDER BY timestamp", (parent_id_for_branch,))
                children_ids = [row['message_id'] for row in cursor.fetchall()]
                new_idx = children_ids.index(saved_message_id) if saved_message_id in children_ids else len(children_ids) - 1
                cursor.execute("UPDATE messages SET active_child_index = ? WHERE message_id = ?", (new_idx, parent_id_for_branch))
            elif is_regeneration or is_continuation: # Replace/Update
                saved_message_id = existing_message_id
                cursor.execute("UPDATE messages SET message = ?, model_name = ?, timestamp = ? WHERE message_id = ?", (response_text, request.model_name, timestamp, saved_message_id))
            else: # Generate new
                 # Find parent ID (logic copied from streaming section - could be helper function)
                 all_msgs_before = get_chat_messages(chat_id); parent_id = None
                 msg_map = {m['message_id']: m for m in all_msgs_before}; roots = [m for m in all_msgs_before if not m['parent_message_id']]
                 if roots: roots.sort(key=lambda m: m['timestamp']); curr_id = roots[0]['message_id']; last_id = None
                 while curr_id: last_id = curr_id; node = msg_map.get(curr_id);
                 if not node: raise Exception; children = [m for m in all_msgs_before if m['parent_message_id'] == curr_id];
                 if not children: raise Exception; children.sort(key=lambda m: m['timestamp']); idx = node.get('active_child_index', 0);
                 if idx >= len(children): idx = 0; curr_id = children[idx]['message_id']
                 parent_id = last_id
                 # --- End Find Parent ---
                 saved_message_id = str(uuid.uuid4())
                 cursor.execute("INSERT INTO messages (message_id, chat_id, role, message, model_name, timestamp, parent_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)", (saved_message_id, chat_id, "llm", response_text, request.model_name, timestamp, parent_id))

            cursor.execute("UPDATE chats SET timestamp_updated = ? WHERE chat_id = ?", (timestamp, chat_id))
            conn.commit()
        except Exception as e:
            conn.rollback()
            print(f"ERROR: Database save failed after non-streaming generation: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to save message: {e}")
        finally:
            conn.close()

        # Return the fully saved/updated message object
        return get_message(saved_message_id)


@app.post("/chat/{chat_id}/generate/")
async def generate_in_chat(chat_id: str, request: GenerateRequest, background_tasks: BackgroundTasks):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT chat_id FROM chats WHERE chat_id = ?", (chat_id,))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Chat not found")
    conn.close() # Close connection before potentially long generation

    context_messages = get_active_message_context(chat_id)
    if not context_messages:
         # Allow generation if only a system prompt exists
         conn_check = get_db_connection()
         cursor_check = conn_check.cursor()
         cursor_check.execute("SELECT c.sysprompt FROM characters c JOIN chats ch ON c.character_id = ch.character_id WHERE ch.chat_id = ?", (chat_id,))
         char_data = cursor_check.fetchone()
         conn_check.close()
         if char_data and char_data["sysprompt"]:
              context_messages = [{"role": "system", "message": char_data["sysprompt"]}]
         else: # Truly empty chat
              raise HTTPException(status_code=400, detail="Cannot generate in an empty chat without an initial user message.")

    # Cannot generate if the last non-system message is already 'llm'/'assistant'
    last_non_system = next((msg for msg in reversed(context_messages) if msg['role'] != 'system'), None)
    if last_non_system and last_non_system['role'] != 'user':
         raise HTTPException(status_code=400, detail="Last message in active context is not 'user'. Cannot generate.")

    print(f"Context for NEW generation in chat {chat_id}: {len(context_messages)} messages") # DEBUG
    return await handle_generation(chat_id, request, context_messages, background_tasks, operation="generate")


@app.post("/chat/{chat_id}/regenerate/{message_id}")
async def regenerate_message_endpoint(chat_id: str, message_id: str, request: GenerateRequest, background_tasks: BackgroundTasks):
    # Rename API function to avoid conflict with internal helper name
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT role, parent_message_id FROM messages WHERE message_id = ? AND chat_id = ?", (message_id, chat_id))
    message_data = cursor.fetchone()
    conn.close() # Close before context fetch

    if not message_data:
        raise HTTPException(status_code=404, detail="Message to regenerate not found")
    if message_data["role"] not in ("llm", "assistant"):
        raise HTTPException(status_code=400, detail="Can only regenerate assistant (llm) messages.")

    parent_message_id = message_data["parent_message_id"]
    if not parent_message_id:
         raise HTTPException(status_code=400, detail="Cannot regenerate message with no parent.")

    # Get context *up to the parent* of the message being regenerated
    context_messages = get_active_message_context(chat_id, until_message_id=parent_message_id)
    # Add the parent message itself back to the context (since until_message_id excludes it)
    parent_message_obj = get_message(parent_message_id) # Fetch full parent data
    if parent_message_obj:
         context_messages.append({
             "role": parent_message_obj['role'],
             "message": parent_message_obj['message'],
             "attachments": parent_message_obj['attachments']
         })
    else:
         # This case should ideally not happen if parent_message_id was valid
         raise HTTPException(status_code=404, detail="Parent message for regeneration context not found.")

    print(f"Context for REGENERATION of {message_id} (new_branch={request.new_branch}): {len(context_messages)} messages") # DEBUG
    return await handle_generation(
        chat_id, request, context_messages, background_tasks,
        existing_message_id=message_id, operation="regenerate"
    )


@app.post("/chat/{chat_id}/continue/{message_id}")
async def continue_message_endpoint(chat_id: str, message_id: str, request: GenerateRequest, background_tasks: BackgroundTasks):
     # "Continue" is essentially regenerating the *same* message but appending the output.
     # This implies `new_branch` should be false. We force it here.
     request.new_branch = False

     conn = get_db_connection()
     cursor = conn.cursor()
     cursor.execute("SELECT role, message, parent_message_id, model_name FROM messages WHERE message_id = ? AND chat_id = ?", (message_id, chat_id))
     message_data = cursor.fetchone()
     conn.close() # Close before context fetch

     if not message_data:
          raise HTTPException(status_code=404, detail="Message to continue not found")
     if message_data["role"] not in ("llm", "assistant"):
          raise HTTPException(status_code=400, detail="Can only continue assistant (llm) messages.")

     original_message_content = message_data["message"]
     parent_message_id = message_data["parent_message_id"]
     original_model = message_data["model_name"] # Use original model if not specified in request

     if not parent_message_id:
          raise HTTPException(status_code=400, detail="Cannot continue message with no parent.")

     # Get context up to the parent, then add the parent.
     context_messages = get_active_message_context(chat_id, until_message_id=parent_message_id)
     parent_message_obj = get_message(parent_message_id)
     if parent_message_obj:
         context_messages.append({
             "role": parent_message_obj['role'],
             "message": parent_message_obj['message'],
             "attachments": parent_message_obj['attachments']
         })
     else:
         raise HTTPException(status_code=404, detail="Parent message for continuation context not found.")

     # IMPORTANT: Add the original message content being continued to the context
     context_messages.append({
          "role": "assistant", # Role should be assistant/llm
          "message": original_message_content,
          "attachments": [] # Attachments are usually on user message
     })

     # Use original model if not overridden in request
     request.model_name = request.model_name or original_model
     if not request.model_name:
          raise HTTPException(status_code=400, detail="Model name required for continuation.")


     print(f"Context for CONTINUE of {message_id}: {len(context_messages)} messages") # DEBUG
     return await handle_generation(
        chat_id, request, context_messages, background_tasks,
        existing_message_id=message_id, operation="continue"
     )


@app.post("/stop")
async def stop_streaming_endpoint(): # Renamed endpoint function
    global cancel_event
    print("INFO: Received /stop request.")
    if cancel_event is not None and not cancel_event.is_set():
        cancel_event.set()
        print("INFO: Cancellation event set.")
        # Give the streaming thread a moment to react
        await asyncio.sleep(0.1)
        return {"status": "streaming stop requested"}
    elif cancel_event and cancel_event.is_set():
        print("INFO: Cancellation event was already set.")
        return {"status": "streaming already stopping"}
    else:
        print("INFO: No active stream or cancel event found.")
        return {"status": "no active stream to stop"}


# ... (Standalone generate endpoint remains the same) ...
@app.post("/generate")
async def generate_raw(request: RawGenerateRequest):
    messages = [{"role": "user", "message": request.text, "attachments": []}]
    # Add system prompt if a default character/prompt is configured? (Out of scope for now)

    # Need to determine model and provider correctly
    model_config = next((m for m in model_configs.get('models', []) if m.get('name') == request.model), None)
    provider = request.provider or (model_config.get('provider', 'openrouter') if model_config else 'openrouter')
    model_identifier = request.model
    if provider == 'local' and model_config:
         model_identifier = model_config.get('model_identifier', request.model) # Use specific ID for local if available

    generation_result = await generation_service.generate(messages, model_identifier, provider, request.gen_args, request.streaming)

    if request.streaming:
         response_gen, _ = generation_result
         # Need to adapt the SSE handling here too if raw text is expected
         async def raw_stream_wrapper():
              async for chunk in response_gen:
                  if chunk.strip().lower() == "data: [done]":
                       break
                  elif chunk.startswith("data: "):
                       data = chunk[6:].strip()
                       try:
                            json_data = json.loads(data)
                            content = None
                            if 'error' in json_data: yield f"ERROR: {json_data['error']}\n"
                            content = json_data.get("choices", [{}])[0].get("delta", {}).get("content")
                            if content is None: content = json_data.get("text") or json_data.get("content")
                            if content: yield content
                       except: yield data # Yield raw if not JSON
                  else: yield chunk # Pass through non-SSE lines?
         return StreamingResponse(raw_stream_wrapper(), media_type="text/plain") # Changed media type
    else:
         response_text, _, status = generation_result
         if status != 'completed':
              # Handle error/cancellation for non-streaming raw request
              return {"text": f"Generation {status}: {response_text}"}
         return {"text": response_text}


if __name__ == "__main__":
    import uvicorn
    print("Starting Zeryo Chat API...")
    print(f"Using Database: {DB_PATH}")
    # Ensure DB is initialized on startup
    init_db()
    print("API Keys Loaded:", list(api_keys.keys()))
    print("Model Configs Loaded:", len(model_configs.get('models', [])))
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True) # Enable reload for development