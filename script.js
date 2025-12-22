// API Configuration (Backend Data API)
const API_BASE = 'http://localhost:8000';

// Global Config (Fetched from backend)
let PROVIDER_CONFIG = {
    openrouter_base_url: "https://openrouter.ai/api/v1",
    local_base_url: "http://127.0.0.1:8080",
    // Keys are ONLY stored in state.apiKeys, populated by fetchProviderConfig
};
let TOOLS_SYSTEM_PROMPT = ""; // Fetched from backend if needed

// DOM Elements
const chatContainer = document.getElementById('chat-container');
const messagesWrapper = document.getElementById('messages-wrapper');
const welcomeContainer = document.getElementById('welcome-container');
const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
// (modelSelect removed)
const imageButton = document.getElementById('image-button');
const fileButton = document.getElementById('file-button');
const stopButton = document.getElementById('stop-button');
const characterSelectButton = document.getElementById('character-select-button');
const inputContainer = document.querySelector('.input-container');
const characterDropdown = document.getElementById('character-dropdown');
const characterDropdownClose = document.getElementById('character-dropdown-close');
const characterDropdownList = document.getElementById('character-dropdown-list');
const clearChatBtn = document.getElementById('delete-chat-btn');
const newChatBtn = document.getElementById('new-chat-btn');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebar = document.getElementById('sidebar');
const imagePreviewContainer = document.getElementById('image-preview-container');
const chatHistoryContainer = document.querySelector('.chat-history');
const toggleToolsBtn = document.getElementById('toggle-tools-btn');
const toggleAutoscrollBtn = document.getElementById('toggle-autoscroll-btn');

const settingsBtn = document.getElementById('settings-btn');
const mainSettingsPopup = document.getElementById('main-settings-popup');
const closeSettingsPopupBtn = document.getElementById('close-settings-popup-btn');
// New centered modal (expected id)
const settingsModal = document.getElementById('settings-modal');
const settingsModalClose = document.getElementById('settings-modal-close');

// Settings modal dynamic elements NOTE:
// The HTML uses:
//  - Tab buttons: .settings-tab-btn  with data-tab="<name>"
//  - Panels: .settings-tab-panel with data-panel="<name>"
//  - Main checkboxes: #main-toggle-tools, #main-toggle-autoscroll, #main-toggle-codeblocks
// We'll resolve/query these lazily each time the modal opens to avoid stale NodeLists.
function querySettingsModalElements() {
    if (!settingsModal) return {};
    return {
        tabButtons: Array.from(settingsModal.querySelectorAll('.settings-tab-btn')), // buttons
        tabPanels: Array.from(settingsModal.querySelectorAll('.settings-tab-panel')), // panels
        cbTools: document.getElementById('main-toggle-tools'),
        cbAutoscroll: document.getElementById('main-toggle-autoscroll'),
        cbCodeblocks: document.getElementById('main-toggle-codeblocks'),
        toolsPromptPreview: document.getElementById('tools-prompt-preview'),
        toolsListContainer: document.getElementById('tools-checkbox-list')
    };
}

// --- Characters Tab Implementation ---
async function fetchCharacters(force = false) {
    if (!force && state.charactersCache.length) return state.charactersCache;
    try {
        const resp = await fetch(`${API_BASE}/characters`);
        if (!resp.ok) throw new Error(await resp.text());
        const chars = await resp.json();
        state.charactersCache = Array.isArray(chars) ? chars : [];
        return state.charactersCache;
    } catch (e) {
        console.error('Fetch characters failed:', e);
        return [];
    }
}

function setupCharactersTab() {
    const listEl = document.getElementById('characters-list');
    const createBtn = document.getElementById('characters-create-btn');
    const refreshBtn = document.getElementById('characters-refresh-btn');
    if (!listEl || !createBtn || !refreshBtn) {
        console.warn('Characters tab elements not found');
        return;
    }
    createBtn.addEventListener('click', () => openCharacterEditor());
    refreshBtn.addEventListener('click', () => refreshCharactersUI());
    refreshCharactersUI();
}

function refreshCharactersUI(preserveScroll = true) {
    const listEl = document.getElementById('characters-list');
    if (!listEl) return;
    const prevScroll = listEl.scrollTop;
    listEl.classList.remove('empty-state');
    listEl.textContent = 'Loading...';
    fetchCharacters(true).then(chars => {
        const resolvedChars = Array.isArray(chars) ? chars : [];
        state.charactersCache = resolvedChars;
        synchronizeActiveCharacterState({ updateUI: false });

        if (!resolvedChars.length) {
            listEl.classList.add('empty-state');
            listEl.textContent = 'No characters yet.';
            updateActiveCharacterUI();
            return;
        }
        listEl.innerHTML = '';
        resolvedChars.forEach(char => {
            const row = document.createElement('div');
            row.className = 'character-row';
            row.dataset.characterId = char.character_id;
            const active = (state.currentCharacterId === char.character_id);
            row.innerHTML = `
                <div class="character-main">
                    <div class="character-name ${active ? 'active' : ''}">${escapeHtml(char.character_name)}</div>
                    <div class="character-model" title="Preferred Model">${escapeHtml(char.preferred_model || '—')}</div>
                    <div class="character-cot" title="CoT Tags">${char.cot_start_tag || ''}${char.cot_end_tag ? '…' : ''}</div>
                </div>
                <div class="character-actions">
                    <button class="character-activate-btn" title="Activate">${active ? '<i class="bi bi-check2-circle"></i>' : '<i class="bi bi-play-circle"></i>'}</button>
                    <button class="character-edit-btn" title="Edit"><i class="bi bi-pencil"></i></button>
                    <button class="character-delete-btn" title="Delete"><i class="bi bi-trash"></i></button>
                </div>`;
            row.querySelector('.character-activate-btn').addEventListener('click', () => activateCharacter(char.character_id));
            row.querySelector('.character-edit-btn').addEventListener('click', () => openCharacterEditor(char));
            row.querySelector('.character-delete-btn').addEventListener('click', () => deleteCharacter(char.character_id));
            listEl.appendChild(row);
        });
        if (preserveScroll) listEl.scrollTop = prevScroll;
        updateActiveCharacterUI();
    });
}

async function activateCharacter(characterId) {
    if (!state.currentChatId) {
        state.currentCharacterId = characterId;
        const cachedChar = state.charactersCache.find(c => c.character_id === characterId);
        if (cachedChar) {
            state.lastActivatedCharacterPreferredModel = cachedChar.model_name || cachedChar.preferred_model || null;
            state.activeSystemPrompt = cachedChar.sysprompt || null;
        }
        setPersistedCharacterId(characterId);
        updateActiveCharacterUI();
        return;
    }

    try {
        const resp = await fetch(`${API_BASE}/c/${state.currentChatId}/set_active_character`, {
            method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({character_id: characterId})
        });
        if (!resp.ok) throw new Error(await resp.text());
        state.currentCharacterId = characterId;
        const cachedChar2 = state.charactersCache.find(c => c.character_id === characterId);
        if (cachedChar2) {
            state.lastActivatedCharacterPreferredModel = cachedChar2.model_name || cachedChar2.preferred_model || null;
            state.activeSystemPrompt = cachedChar2.sysprompt || null;
        }
        setPersistedCharacterId(characterId);
        updateActiveCharacterUI();
        refreshCharactersUI(false);
        updateEffectiveSystemPrompt();
    } catch (e) {
        console.error('Activate character failed:', e);
        addSystemMessage('Failed to activate character: '+ e.message, 'error');
    }
}

function hideCharacterDropdown() {
    if (!characterDropdown) return;
    characterDropdown.style.display = 'none';
}

function showCharacterDropdown() {
    if (!characterDropdown) return;
    
    const container = document.querySelector('.input-container');
    if (!container) return;
    
    const rect = container.getBoundingClientRect();
    const gap = 10;
    
    // Show dropdown and position it
    characterDropdown.style.display = 'flex';
    characterDropdown.style.position = 'fixed';
    characterDropdown.style.left = `${rect.left}px`;
    
    // Position above input container
    const dropdownHeight = characterDropdown.offsetHeight || 300;
    const top = Math.max(10, rect.top - gap - dropdownHeight);
    
    characterDropdown.style.top = `${top}px`;
    characterDropdown.style.bottom = 'auto';
}

// Populate the character dropdown in input area
async function populateCharacterDropdown() {
    if (!characterDropdownList) return;

    characterDropdownList.innerHTML = '<div class="character-dropdown-loading">Loading characters…</div>';
    await fetchCharacters(false);
    const chars = Array.isArray(state.charactersCache) ? state.charactersCache : [];

    characterDropdownList.innerHTML = '';

    chars.forEach(char => {
        const item = document.createElement('div');
        item.className = 'character-dropdown-item';
        if (state.currentCharacterId === char.character_id) {
            item.classList.add('active');
        }

        item.innerHTML = `
            <div class="character-dropdown-item-main">
                <div class="character-dropdown-item-name">${escapeHtml(char.character_name)}</div>
                <div class="character-dropdown-item-model">${escapeHtml(char.preferred_model || 'No model set')}</div>
            </div>
            ${state.currentCharacterId === char.character_id ? '<i class="bi bi-check-circle-fill character-dropdown-item-icon"></i>' : ''}
        `;

        item.addEventListener('click', () => {
            activateCharacter(char.character_id);
            hideCharacterDropdown();
        });

        characterDropdownList.appendChild(item);
    });

    if (!chars.length) {
        const emptyNotice = document.createElement('div');
        emptyNotice.className = 'character-dropdown-empty';
        emptyNotice.textContent = 'No characters available. Create one in Settings.';
        characterDropdownList.appendChild(emptyNotice);
    }

    const createItem = document.createElement('div');
    createItem.className = 'character-dropdown-item character-dropdown-action';
    createItem.innerHTML = `
        <div class="character-dropdown-item-main">
            <div class="character-dropdown-item-name"><i class="bi bi-plus-circle"></i> Create Character</div>
            <div class="character-dropdown-item-model">Open character editor</div>
        </div>
    `;
    createItem.addEventListener('click', () => {
        hideCharacterDropdown();
        openCharacterEditor();
    });
    characterDropdownList.appendChild(createItem);

    requestAnimationFrame(showCharacterDropdown);
}

function openCharacterEditor(existing=null) {
    const overlay = document.createElement('div'); overlay.className='attachment-popup-overlay';
    overlay.addEventListener('click', e=>{ if (e.target===overlay) overlay.remove(); });
    
    const container = document.createElement('div'); container.className='attachment-popup-container character-editor';
    
    // Header with title and close button (matches center-modal-dialog pattern)
    const header = document.createElement('div'); header.className='character-editor-header';
    const title = document.createElement('h3'); title.textContent = existing ? 'Edit Character' : 'Add Character';
    const closeBtn = document.createElement('button'); closeBtn.className='popup-close-btn'; closeBtn.innerHTML='<i class="bi bi-x"></i>';
    closeBtn.addEventListener('click', ()=>overlay.remove());
    header.appendChild(title);
    header.appendChild(closeBtn);
    
    // Scrollable body
    const body = document.createElement('div'); body.className='character-editor-body';
    
    // Form groups
    const createFormGroup = (labelText, input) => {
        const group = document.createElement('div'); group.className='form-group';
        const label = document.createElement('label'); label.textContent = labelText;
        group.appendChild(label);
        group.appendChild(input);
        return group;
    };
    
    const nameInput = document.createElement('input'); nameInput.type='text'; nameInput.placeholder='Enter character name'; nameInput.value=existing?.character_name||''; if (existing) nameInput.disabled = true;
    const promptArea = document.createElement('textarea'); promptArea.placeholder='Enter the system prompt for this character...'; promptArea.value=existing?.sysprompt||'';
    
    // Model fields
    const modelNameInput = document.createElement('input'); modelNameInput.type='text'; modelNameInput.placeholder='e.g., claude-3-opus'; modelNameInput.value = existing?.model_name || existing?.preferred_model || '';
    const modelProviderSelect = document.createElement('select');
    ['openrouter', 'google', 'local'].forEach(provider => {
        const opt = document.createElement('option');
        opt.value = provider;
        opt.textContent = provider.charAt(0).toUpperCase() + provider.slice(1);
        if ((existing?.model_provider || 'openrouter') === provider) opt.selected = true;
        modelProviderSelect.appendChild(opt);
    });
    const modelIdentifierInput = document.createElement('input'); modelIdentifierInput.type='text'; modelIdentifierInput.placeholder='e.g., anthropic/claude-3-opus'; modelIdentifierInput.value = existing?.model_identifier || '';
    
    // Checkbox for image support
    const supportsImagesLabel = document.createElement('label'); supportsImagesLabel.className='checkbox-inline';
    const supportsImagesCheckbox = document.createElement('input'); supportsImagesCheckbox.type='checkbox'; supportsImagesCheckbox.checked = existing?.model_supports_images || existing?.preferred_model_supports_images || false;
    supportsImagesLabel.appendChild(supportsImagesCheckbox);
    supportsImagesLabel.appendChild(document.createTextNode(' Supports Images'));
    
    // CoT tags in a row
    const cotStart = document.createElement('input'); cotStart.type='text'; cotStart.placeholder='<think>'; cotStart.value = existing?.cot_start_tag || '';
    const cotEnd = document.createElement('input'); cotEnd.type='text'; cotEnd.placeholder='</think>'; cotEnd.value = existing?.cot_end_tag || '';
    const cotRow = document.createElement('div'); cotRow.className='form-row';
    cotRow.appendChild(createFormGroup('CoT Start Tag', cotStart));
    cotRow.appendChild(createFormGroup('CoT End Tag', cotEnd));
    
    // Assemble body
    body.appendChild(createFormGroup('Character Name', nameInput));
    body.appendChild(createFormGroup('System Prompt', promptArea));
    body.appendChild(createFormGroup('Model Name', modelNameInput));
    body.appendChild(createFormGroup('Provider', modelProviderSelect));
    body.appendChild(createFormGroup('Model Identifier (API)', modelIdentifierInput));
    body.appendChild(supportsImagesLabel);
    body.appendChild(cotRow);
    
    // Actions footer
    const actions = document.createElement('div'); actions.className='form-actions';
    const cancelBtn = document.createElement('button'); cancelBtn.className='btn-secondary'; cancelBtn.textContent='Cancel'; cancelBtn.addEventListener('click', ()=>overlay.remove());
    const saveBtn = document.createElement('button'); saveBtn.className='btn-primary'; saveBtn.textContent='Save';
    saveBtn.addEventListener('click', async () => {
        // For CoT tags: use trimmed value (can be empty string to clear)
        const cotStartValue = cotStart.value.trim();
        const cotEndValue = cotEnd.value.trim();
        const body = {
            character_name: nameInput.value.trim(),
            sysprompt: promptArea.value,
            preferred_model: modelNameInput.value.trim() || null,
            preferred_model_supports_images: supportsImagesCheckbox.checked,
            model_name: modelNameInput.value.trim() || null,
            model_provider: modelProviderSelect.value || null,
            model_identifier: modelIdentifierInput.value.trim() || null,
            model_supports_images: supportsImagesCheckbox.checked,
            cot_start_tag: cotStartValue !== '' ? cotStartValue : null,
            cot_end_tag: cotEndValue !== '' ? cotEndValue : null,
            settings: {}
        };
        try {
            let resp;
            if (existing) {
                resp = await fetch(`${API_BASE}/character/${existing.character_id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
                if (!resp.ok) throw new Error(await resp.text());
                const idx = state.charactersCache.findIndex(c => c.character_id === existing.character_id);
                if (idx !== -1) {
                    state.charactersCache[idx] = {
                        ...state.charactersCache[idx],
                        character_name: body.character_name,
                        sysprompt: body.sysprompt,
                        preferred_model: body.preferred_model,
                        preferred_model_supports_images: body.preferred_model_supports_images,
                        model_name: body.model_name,
                        model_provider: body.model_provider,
                        model_identifier: body.model_identifier,
                        model_supports_images: body.model_supports_images,
                        cot_start_tag: body.cot_start_tag,
                        cot_end_tag: body.cot_end_tag,
                        settings: body.settings
                    };
                }
                if (state.currentCharacterId === existing.character_id) {
                    state.lastActivatedCharacterPreferredModel = body.model_name || body.preferred_model || null;
                    state.activeSystemPrompt = body.sysprompt || null;
                    // Update persisted CoT tags to ensure they're picked up immediately
                    setPersistedCotTags({
                        start: body.cot_start_tag || null,
                        end: body.cot_end_tag || null
                    });
                    updateEffectiveSystemPrompt();
                    updateAttachmentButtonsForModel();
                }
                refreshCharactersUI(false);
                overlay.remove();
            } else {
                resp = await fetch(`${API_BASE}/character`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
                if (!resp.ok) throw new Error(await resp.text());
                const data = await resp.json();
                const newId = data.character_id;
                const newChar = {
                    character_id: newId,
                    character_name: body.character_name,
                    sysprompt: body.sysprompt,
                    preferred_model: body.preferred_model,
                    preferred_model_supports_images: body.preferred_model_supports_images,
                    model_name: body.model_name,
                    model_provider: body.model_provider,
                    model_identifier: body.model_identifier,
                    model_supports_images: body.model_supports_images,
                    cot_start_tag: body.cot_start_tag,
                    cot_end_tag: body.cot_end_tag,
                    settings: body.settings
                };
                state.charactersCache.push(newChar);
                refreshCharactersUI(false);
                overlay.remove();
                await activateCharacter(newId);
                state.lastActivatedCharacterPreferredModel = newChar.model_name || newChar.preferred_model || null;
                state.activeSystemPrompt = newChar.sysprompt || null;
                updateEffectiveSystemPrompt();
            }
        } catch(e) {
            console.error('Save character failed', e);
            alert('Character save failed: '+ e.message);
        }
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    
    // Assemble container
    container.appendChild(header);
    container.appendChild(body);
    container.appendChild(actions);
    overlay.appendChild(container);
    document.body.appendChild(overlay);
}

async function deleteCharacter(characterId) {
    if (!confirm('Delete character?')) return;
    try {
        const resp = await fetch(`${API_BASE}/character/${characterId}`, { method:'DELETE' });
        if (!resp.ok) throw new Error(await resp.text());
        if (state.currentCharacterId === characterId) {
            state.currentCharacterId = null;
            updateActiveCharacterUI();
            updateEffectiveSystemPrompt();
            setPersistedCharacterId(null);
        }
        state.charactersCache = []; // Force refetch
        refreshCharactersUI(false);
    } catch (e) {
        console.error('Delete character failed:', e);
        addSystemMessage('Failed to delete character: '+ e.message, 'error');
    }
}


// openModelEditor & deleteModel removed (deprecated)

// State Management
const state = {
    currentChatId: null,
    chats: [], // List of {chat_id, preview, timestamp_updated}
    messages: [], // All messages for the current chat { message_id, ..., children_ids: [] }
    charactersCache: [],
    currentImages: [], // { base64, dataUrl, type, name }
    currentTextFiles: [],
    streamController: null,
    currentAssistantMessageDiv: null,
    currentCharacterId: null,
    streamingThinkTimer: { intervalId: null, startTime: null },

    activeSystemPrompt: null, // Store the actual character prompt text
    effectiveSystemPrompt: null, // Character prompt + optional tools prompt
    activeBranchInfo: {}, // { parentMessageId: { activeIndex: number, totalBranches: number } } -> Derived from messages during render
    apiKeys: { // Store keys fetched from backend /config endpoint
        openrouter: null,
        google: null,
        local: null,
    },
    toolsEnabled: false, // Flag to control tool usage
    availableTools: [], // Catalog fetched from backend
    enabledToolNames: new Set(), // Subset selected in UI
    toolCallPending: false,
    toolContinuationContext: null,
    currentToolCallId: null, // Track the ID of the current tool call being processed
    abortingForToolCall: false,
    scrollDebounceTimer: null,
    codeBlocksDefaultCollapsed: false,
    autoscrollEnabled: false,
    lastActivatedCharacterPreferredModel: null,
    // Persistent collapse states keyed by message ID to survive re-renders
    userCollapseStates: new Map(), // Map<messageId, { code: Map, think: Map, tool: Map }>
};

let cachedPersistedCotTags = null;
let cachedPersistedCotTagsLoaded = false;

const LAST_CHARACTER_STORAGE_KEY = 'lastCharacterId';
let autoScrollFrameId = null;

function getPersistedCharacterId() {
    try {
        const value = localStorage.getItem(LAST_CHARACTER_STORAGE_KEY);
        return value || null;
    } catch (error) {
        console.warn('Failed to read persisted character id from storage:', error);
        return null;
    }
}

function setPersistedCharacterId(characterId) {
    try {
        if (characterId) {
            localStorage.setItem(LAST_CHARACTER_STORAGE_KEY, characterId);
        } else {
            localStorage.removeItem(LAST_CHARACTER_STORAGE_KEY);
        }
    } catch (error) {
        console.warn('Failed to persist character id:', error);
    }
}

function synchronizeActiveCharacterState({ updateUI = true } = {}) {
    const cache = Array.isArray(state.charactersCache) ? state.charactersCache : [];
    const storedId = getPersistedCharacterId();
    let effectiveId = state.currentCharacterId || storedId || null;
    let activeChar = null;

    if (effectiveId) {
        activeChar = cache.find(c => c.character_id === effectiveId) || null;
    }

    if (!activeChar && storedId && storedId !== effectiveId) {
        activeChar = cache.find(c => c.character_id === storedId) || null;
        if (activeChar) {
            effectiveId = storedId;
        }
    }

    if (!activeChar && effectiveId) {
        if (storedId === effectiveId) {
            setPersistedCharacterId(null);
        }
        state.currentCharacterId = null;
        state.lastActivatedCharacterPreferredModel = null;
        state.activeSystemPrompt = null;
    } else if (activeChar) {
        state.currentCharacterId = activeChar.character_id;
        state.lastActivatedCharacterPreferredModel = activeChar.model_name || activeChar.preferred_model || null;
        state.activeSystemPrompt = activeChar.sysprompt || null;
        setPersistedCharacterId(activeChar.character_id);
    } else {
        state.currentCharacterId = null;
        state.lastActivatedCharacterPreferredModel = null;
        state.activeSystemPrompt = null;
    }

    if (updateUI) updateActiveCharacterUI();
    return activeChar;
}

// --- Helper: Escape HTML for safe insertion into attribute/text contexts ---
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// URL routing helpers for /chat/UUID pattern (page URLs use /chat/, API uses /c/)
function getChatIdFromUrl() {
    const path = window.location.pathname;
    const match = path.match(/^\/chat\/([a-f0-9-]+)$/i);
    return match ? match[1] : null;
}

function updateUrlForChat(chatId) {
    if (chatId) {
        const newUrl = `/chat/${chatId}`;
        if (window.location.pathname !== newUrl) {
            window.history.pushState({ chatId }, '', newUrl);
        }
    } else {
        if (window.location.pathname !== '/') {
            window.history.pushState({}, '', '/');
        }
    }
}

// Handle browser back/forward navigation
window.addEventListener('popstate', async (event) => {
    const chatId = getChatIdFromUrl();
    if (chatId && chatId !== state.currentChatId) {
        await loadChat(chatId);
    } else if (!chatId && state.currentChatId) {
        startNewChat();
    }
});

// Display system prompt + character name (fallback if dedicated UI element not present)
function displayActiveSystemPrompt(characterName, effectivePrompt) {
    const el = document.getElementById('active-system-prompt');
    if (!el) return; // Optional UI region
    if (!effectivePrompt) {
        el.innerHTML = '<em>No active system prompt</em>';
        return;
    }
    const safeName = characterName ? `<strong>${escapeHtml(characterName)}</strong>` : '<strong>Default</strong>';
    el.innerHTML = `${safeName}: <pre class="sys-prompt">${escapeHtml(effectivePrompt)}</pre>`;
}

// Update character-related UI indicators (active highlight & attachment gating)
function updateActiveCharacterUI() {
    // Highlight active character row if list rendered
    const listEl = document.getElementById('characters-list');
    if (listEl) {
        listEl.querySelectorAll('.character-row').forEach(row => {
            const id = row.dataset.characterId;
            const nameDiv = row.querySelector('.character-name');
            if (nameDiv) nameDiv.classList.toggle('active', id === state.currentCharacterId);
            const activateBtn = row.querySelector('.character-activate-btn');
            if (activateBtn) activateBtn.innerHTML = id === state.currentCharacterId ? '<i class="bi bi-check2-circle"></i>' : '<i class="bi bi-play-circle"></i>';
        });
    }
    
    // Update character select button appearance
    if (characterSelectButton) {
        const nameSpan = characterSelectButton.querySelector('.character-select-name');
        const activeChar = state.currentCharacterId ? state.charactersCache.find(c => c.character_id === state.currentCharacterId) : null;
        if (activeChar) {
            if (nameSpan) {
                nameSpan.textContent = activeChar.character_name;
            }
            characterSelectButton.title = `Active: ${activeChar.character_name}`;
        } else {
            if (nameSpan) {
                nameSpan.textContent = 'Character';
            }
            characterSelectButton.title = 'Select Character';
        }
    }

    // Refresh active system prompt text (fetch only if we lack character cache entry sysprompt) - we already keep sysprompt locally when listing
    if (state.currentCharacterId) {
        const char = state.charactersCache.find(c => c.character_id === state.currentCharacterId);
        state.activeSystemPrompt = char ? (char.sysprompt || null) : null;
    } else {
        state.activeSystemPrompt = null;
    }
    updateEffectiveSystemPrompt();

    // Update attachment buttons based on model image support
    updateAttachmentButtonsForModel();
}

// Default generation arguments
const defaultGenArgs = {
    temperature: null,
    min_p: null,
    max_tokens: null,
    top_p: null,
};

const THEMES_CONFIG = {
    white: {
        '--bg-primary': '#ffffff', '--bg-secondary': '#f7f7f7', '--bg-tertiary': '#f0f0f0',
        '--text-primary': '#101010', '--text-secondary': '#57606a', '--accent-color': '#101010',
        '--accent-hover': '#101010', '--accent-color-highlight': '#101010', '--error-color': '#d73a49', '--error-hover': '#b22222',
        '--message-user': '#f0f0f0', '--scrollbar-bg': '#f0f0f0',
        '--scrollbar-thumb': '#cccccc', '--border-color': '#d0d7de',
        '--tool-call-bg': 'rgba(0, 0, 0, 0.03)', '--tool-call-border': '#444',
        '--tool-result-bg': 'rgba(0, 0, 0, 0.02)', '--tool-result-border': '#aaa',
    },
    solarized: {
        '--bg-primary': '#fdf6e3', '--bg-secondary': '#eee8d5', '--bg-tertiary': '#e8e1cf',
        '--text-primary': '#657b83', '--text-secondary': '#839496', '--accent-color': '#2aa198',
        '--accent-hover': '#217d77', '--accent-color-highlight': 'rgba(42, 161, 152, 0.3)', '--error-color': '#dc322f', '--error-hover': '#b52a27',
        '--message-user': '#eee8d5', '--scrollbar-bg': '#eee8d5',
        '--scrollbar-thumb': '#93a1a1', '--border-color': '#d9cfb3',
        '--tool-call-bg': 'rgba(42, 161, 152, 0.08)', '--tool-call-border': '#2aa198',
        '--tool-result-bg': 'rgba(147, 161, 161, 0.08)', '--tool-result-border': '#93a1a1',
    },
    dark: {
        '--bg-primary': '#0d0d0d', '--bg-secondary': '#121212', '--bg-tertiary': '#1a1a1a',
        '--text-primary': '#e8e8e8', '--text-secondary': '#9a9a9a', '--accent-color': '#7c9dd9',
        '--accent-hover': '#a1b8e8', '--accent-color-highlight': 'rgba(124, 157, 217, 0.25)', '--error-color': '#e05555', '--error-hover': '#ff7070',
        '--message-user': '#181818', '--scrollbar-bg': '#1a1a1a',
        '--scrollbar-thumb': '#3a3a3a', '--border-color': '#2a2a2a',
        '--tool-call-bg': 'rgba(124, 157, 217, 0.08)', '--tool-call-border': '#7c9dd9',
        '--tool-result-bg': 'rgba(124, 157, 217, 0.05)', '--tool-result-border': '#5a7ab8',
    },
    claude_white: {
        '--bg-primary': '#ffffff',
        '--bg-secondary': '#FAF9F5',
        '--bg-tertiary': '#F5F4ED',
        '--text-primary': '#1f2328',
        '--text-secondary': '#57606a',
        '--accent-color': '#e97c5d',
        '--accent-hover': '#D97757',
        '--accent-color-highlight': '#1f2328',
        '--error-color': '#d73a49',
        '--error-hover': '#b22222',
        '--message-user': '#F5F4ED',
        '--scrollbar-bg': '#F5F4ED',
        '--scrollbar-thumb': '#cccccc',
        '--border-color': '#e0e0e0',
        '--tool-call-bg': 'rgba(233, 124, 93, 0.05)',
        '--tool-call-border': '#e97c5d',
        '--tool-result-bg': 'rgba(0, 0, 0, 0.02)',
        '--tool-result-border': '#aaa',
    },
    gpt_dark: {
        '--bg-primary': '#303030',
        '--bg-secondary': '#212121',
        '--bg-tertiary': '#171717',
        '--text-primary': '#e0e0e8',
        '--text-secondary': '#e0e0e8',
        '--accent-color': '#c0c0c8',
        '--accent-hover': '#e0e0e8',
        '--accent-color-highlight': '#e0e0e8',
        '--error-color': '#d73a49',
        '--error-hover': '#b22222',
        '--message-user': '#F5F4ED',
        '--scrollbar-bg': '#F5F4ED',
        '--scrollbar-thumb': '#cccccc',
        '--border-color': '#424242',
        '--tool-call-bg': 'rgba(233, 124, 93, 0.05)',
        '--tool-call-border': '#e97c5d',
        '--tool-result-bg': 'rgba(0, 0, 0, 0.02)',
        '--tool-result-border': '#aaa',
    },
    gruvbox_dark: {
        '--bg-primary': '#1d2021',
        '--bg-secondary': '#282828',
        '--bg-tertiary': '#3c3836',
        '--text-primary': '#ebdbb2',
        '--text-secondary': '#a89984',
        '--accent-color': '#ebdbb2',
        '--accent-hover': '#a89984',
        '--accent-color-highlight': 'rgba(235, 219, 178, 0.3)',
        '--error-color': '#fb4934',
        '--error-hover': '#cc241d',
        '--message-user': '#32302f',
        '--scrollbar-bg': '#32302f',
        '--scrollbar-thumb': '#504945',
        '--border-color': '#504945',
        '--tool-call-bg': 'rgba(250, 189, 47, 0.1)',
        '--tool-call-border': '#a89984',
        '--tool-result-bg': 'rgba(168, 153, 132, 0.08)',
        '--tool-result-border': '#a89984',
    },
    gruvbox_light: {
        '--bg-primary': '#fbf1c7',
        '--bg-secondary': '#f2e5bc',
        '--bg-tertiary': '#ebdbb2',
        '--text-primary': '#282828',
        '--text-secondary': '#504945',
        '--accent-color': '#b16286',
        '--accent-hover': '#8f3f71',
        '--accent-color-highlight': 'rgba(177, 98, 134, 0.25)',
        '--error-color': '#cc241d',
        '--error-hover': '#9d0006',
        '--message-user': '#ebdbb2',
        '--scrollbar-bg': '#ebdbb2',
        '--scrollbar-thumb': '#bdae93',
        '--border-color': '#d5c4a1',
        '--tool-call-bg': 'rgba(177, 98, 134, 0.1)',
        '--tool-call-border': '#b16286',
        '--tool-result-bg': 'rgba(80, 73, 69, 0.08)',
        '--tool-result-border': '#665c54',
    }
};

// Configure marked
marked.setOptions({
    breaks: true,
    gfm: true,
    headerIds: false,
    highlight: function(code, lang) {
        const language = hljs.getLanguage(lang) ? lang : 'plaintext';
        try {
            const codeString = String(code);
            return hljs.highlight(codeString, { language, ignoreIllegals: true }).value;
        } catch (error) {
            console.error("Highlighting error:", error);
            const codeString = String(code);
            return hljs.highlightAuto(codeString).value;
        }
    }
});

// Regex for detecting MCP-style tool call blocks
const TOOL_CALL_REGEX = /<tool_call\s+name="([\w.-]+)"(?:\s+id="([\w-]+)")?\s*>([\s\S]*?)<\/tool_call>/g;
// Regex for detecting tool result tags
const TOOL_RESULT_TAG_REGEX = /<tool_result\s+name="([\w.-]+)"(?:\s+status="([\w-]+)")?\s*>([\s\S]*?)<\/tool_result>/g;
// Combined Regex for parsing message content in buildContentHtml
const TOOL_TAG_REGEX = /(<tool_call\s+name="([\w.-]+)"(?:\s+id="([\w-]+)")?\s*>([\s\S]*?)<\/tool_call>)|(<tool_result\s+name="([\w.-]+)"(?:\s+status="([\w-]+)")?\s*>([\s\S]*?)<\/tool_result>)/g;

function isAssistantToolOnlyMessage(message) {
    if (!message) return false;

    const text = String(message.message || '').trim();
    const hasAttachments = Array.isArray(message.attachments) && message.attachments.length > 0;
    const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;

    if (hasAttachments || hasToolCalls) {
        return false;
    }

    if (!text) {
        return true;
    }

    const hasToolContent = /<tool_call\b|<tool_result\b/i.test(text);
    if (hasToolContent) {
        return false;
    }

    const stripped = stripCotBlocks(text).trim();
    return stripped.length === 0;
}


function parseToolCallPayload(payloadText) {
    const trimmed = (payloadText || '').trim();
    if (!trimmed) {
        return { arguments: {}, raw: '', payload: null, error: null, inferredId: null };
    }

    try {
        const parsed = JSON.parse(trimmed);
        let argsCandidate = parsed?.arguments;
        if (argsCandidate === undefined) {
            argsCandidate = parsed?.input !== undefined ? parsed.input : parsed;
        }
        const args = (argsCandidate && typeof argsCandidate === 'object' && !Array.isArray(argsCandidate)) ? argsCandidate : {};
        const inferredId = typeof parsed?.id === 'string' ? parsed.id : null;
        return { arguments: args, raw: trimmed, payload: parsed, error: null, inferredId };
    } catch (err) {
        console.warn('Failed to parse tool call payload as JSON:', err, payloadText);
        return { arguments: {}, raw: trimmed, payload: null, error: err instanceof Error ? err.message : String(err), inferredId: null };
    }
}

const __toolEntityDecoder = document.createElement('textarea');
function decodeHtmlEntities(text) {
    if (!text) return '';
    __toolEntityDecoder.innerHTML = text;
    return __toolEntityDecoder.value;
}

function getEnabledToolNamesArray() {
    return Array.from(state.enabledToolNames || []);
}

function persistEnabledToolNames() {
    try {
        localStorage.setItem('enabledToolNames', JSON.stringify(getEnabledToolNamesArray()));
    } catch (error) {
        console.warn('Failed to persist enabled tool names:', error);
    }
}

function reconcileEnabledToolSelection() {
    const availableNames = new Set((state.availableTools || []).map(tool => tool.name));
    const currentNames = Array.from(state.enabledToolNames || []);
    const filtered = currentNames.filter(name => availableNames.has(name));
    if (filtered.length === 0 && availableNames.size > 0) {
        state.enabledToolNames = new Set(Array.from(availableNames));
    } else {
        state.enabledToolNames = new Set(filtered);
    }
    persistEnabledToolNames();
}

function updateToolsPromptPreviewDisplay() {
    const previewEl = document.getElementById('tools-prompt-preview');
    if (previewEl) {
        previewEl.textContent = TOOLS_SYSTEM_PROMPT ? TOOLS_SYSTEM_PROMPT : 'No tools prompt loaded.';
    }
}

function updateToolsCheckboxDisableState() {
    document.querySelectorAll('#tools-checkbox-list input[type="checkbox"]').forEach(cb => {
        cb.disabled = !state.toolsEnabled;
    });
}

function renderToolsCheckboxList(container) {
    if (!container) return;

    container.innerHTML = '';
    if (!state.availableTools || state.availableTools.length === 0) {
        container.innerHTML = '<div class="tools-list-empty">No tools available.</div>';
        return;
    }

    const sortedTools = [...state.availableTools].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    sortedTools.forEach(tool => {
        const row = document.createElement('label');
        row.className = 'tool-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = tool.name;
        checkbox.checked = state.enabledToolNames.has(tool.name);
        checkbox.disabled = !state.toolsEnabled;
        checkbox.addEventListener('change', async () => {
            if (checkbox.checked) {
                state.enabledToolNames.add(tool.name);
            } else {
                state.enabledToolNames.delete(tool.name);
            }
            persistEnabledToolNames();
            try {
                await fetchToolsSystemPrompt(getEnabledToolNamesArray());
            } catch (err) {
                console.error('Failed to refresh tools prompt after toggle:', err);
                addSystemMessage('Failed to refresh tools prompt after toggling a tool.', 'warning');
            } finally {
                updateToolsPromptPreviewDisplay();
                updateEffectiveSystemPrompt();
            }
        });

        const infoWrapper = document.createElement('div');
        infoWrapper.className = 'tool-item-content';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'tool-item-name';
        nameSpan.textContent = tool.name;
        const descSpan = document.createElement('span');
        descSpan.className = 'tool-item-description';
        descSpan.textContent = tool.description || '';
        infoWrapper.appendChild(nameSpan);
        infoWrapper.appendChild(descSpan);

        row.appendChild(checkbox);
        row.appendChild(infoWrapper);
        container.appendChild(row);
    });
}

/**
 * Renders markdown text, handling think blocks, code blocks, and LaTeX.
 * This version uses a robust multi-pass strategy to correctly handle LaTeX
 * by isolating it before the markdown parser can interfere.
 *
 * @param {string} text The raw text segment to render (can include <think> block).
 * @param {boolean} [initialCollapsedState=true] Initial collapsed state for think blocks (if any).
 * @param {string|null} [temporaryId=null] Optional temporary ID for the think block wrapper (used during streaming).
 * @returns {string} The rendered HTML string.
 */
function renderMarkdown(text, initialCollapsedState = true, temporaryId = null) {
    let processedText = text || '';
    let html = '';
    const cotTagPairs = getCotTagPairs();
    let isThinkBlockSegment = startsWithCotBlock(processedText, cotTagPairs);

    // This local function performs the complete rendering pipeline.
    const renderCore = (markdownText) => {
        if (!markdownText) return '';

        const katexBlocks = [];
        const katexInlines = [];

        // Helper to check if a match position is escaped by preceding backslash
        const isEscaped = (source, startIndex) => {
            let slashCount = 0;
            for (let i = startIndex - 1; i >= 0 && source[i] === '\\'; i--) {
                slashCount++;
            }
            return (slashCount % 2) === 1;
        };

        // 1. ISOLATE AND PROTECT LATEX FIRST.
        // This is the crucial step. We remove LaTeX from the string before the
        // markdown parser can see and corrupt characters like '_' or '|'.
        
        // Handle \[...\] block LaTeX (must come before $$ to avoid conflicts)
        let textWithPlaceholders = markdownText.replace(/\\\[([\s\S]+?)\\\]/g, (match, latex, offset, source) => {
            if (isEscaped(source, offset)) return match;
            const placeholder = `@@LATEX_BLOCK_${katexBlocks.length}@@`;
            katexBlocks.push(latex.trim());
            return placeholder;
        });

        // Handle $$...$$ block LaTeX
        textWithPlaceholders = textWithPlaceholders.replace(/\$\$([\s\S]+?)\$\$/g, (match, latex) => {
            const placeholder = `@@LATEX_BLOCK_${katexBlocks.length}@@`;
            katexBlocks.push(latex.trim());
            return placeholder;
        });

        // Handle \(...\) inline LaTeX (must come before $ to avoid conflicts)
        textWithPlaceholders = textWithPlaceholders.replace(/\\\((.+?)\\\)/g, (match, latex, offset, source) => {
            if (isEscaped(source, offset)) return match;
            const placeholder = `@@LATEX_INLINE_${katexInlines.length}@@`;
            katexInlines.push(latex.trim());
            return placeholder;
        });

        // Handle $...$ inline LaTeX (single line, not empty)
        // Skip currency patterns like $50, $100, $10 000, etc.
        textWithPlaceholders = textWithPlaceholders.replace(/(?<!\$)\$([^$\n]+?)\$(?!\$)/g, (match, latex) => {
            // Skip if content looks like currency (starts with a number, optionally with spaces/commas)
            if (/^\s*[\d,.\s]+\s*$/.test(latex) || /^\s*\d/.test(latex)) {
                return match; // Keep as-is, not LaTeX
            }
            const placeholder = `@@LATEX_INLINE_${katexInlines.length}@@`;
            katexInlines.push(latex.trim());
            return placeholder;
        });

        // 2. PARSE THE SCRUBBED MARKDOWN.
        // The markdown parser now operates on text that contains no LaTeX source, only placeholders.
        let htmlString = marked.parse(textWithPlaceholders);

        // 3. RENDER KATEX by replacing the placeholders with KaTeX's HTML output.
        htmlString = htmlString.replace(/@@LATEX_BLOCK_(\d+)@@/g, (match, index) => {
            const latex = katexBlocks[parseInt(index, 10)];
            try {
                // Decode entities that might have been pasted in, just in case.
                const decodedLatex = latex.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
                return katex.renderToString(decodedLatex, { displayMode: true, throwOnError: false });
            } catch (e) {
                console.error('KaTeX block rendering error:', e, "Input:", latex);
                return `<span class="katex-error">[Block LaTeX Error]</span>`;
            }
        });

        htmlString = htmlString.replace(/@@LATEX_INLINE_(\d+)@@/g, (match, index) => {
            const latex = katexInlines[parseInt(index, 10)];
            try {
                const decodedLatex = latex.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
                return katex.renderToString(decodedLatex, { displayMode: false, throwOnError: false });
            } catch (e) {
                console.error('KaTeX inline rendering error:', e, "Input:", latex);
                return `<span class="katex-error">[Inline LaTeX Error]</span>`;
            }
        });

        // 4. ADD HEX COLOR PREVIEWS
        // Match hex color codes and add color preview squares
        htmlString = htmlString.replace(/(#(?:[0-9a-fA-F]{3}){1,2})\b/g, (match, color) => {
            // Validate hex color
            const isValidHex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color);
            if (!isValidHex) return match;
            return `<span class="hex-color-preview"><span class="hex-color-swatch" style="background-color:${color}"></span>${color}</span>`;
        });

        // 5. ENHANCE CODE BLOCKS as the final step.
        const tempContainer = document.createElement('div');
        tempContainer.innerHTML = htmlString;
        tempContainer.querySelectorAll('pre').forEach(enhanceCodeBlock);

        return tempContainer.innerHTML;
    };

    if (isThinkBlockSegment) {
        const { thinkContent, remainingText } = parseThinkContent(processedText, cotTagPairs);

        const thinkBlockWrapper = document.createElement('div');
        thinkBlockWrapper.className = `think-block ${initialCollapsedState ? 'collapsed' : ''}`;
        if (temporaryId) { thinkBlockWrapper.dataset.tempId = temporaryId; }

        const header = document.createElement('div');
        header.className = 'think-header';
        header.innerHTML = `
            <span class="think-header-title"><i class="bi bi-lightbulb"></i> Thought Process</span>
            <span class="think-timer"></span>
            <div class="think-header-actions">
                <button class="think-block-toggle" title="${initialCollapsedState ? 'Expand' : 'Collapse'} thought process">
                    <i class="bi bi-chevron-${initialCollapsedState ? 'down' : 'up'}"></i>
                </button>
            </div>`;
        thinkBlockWrapper.appendChild(header);

        const thinkContentDiv = document.createElement('div');
        thinkContentDiv.className = 'think-content';
        // Use the unified core renderer for the think block's content.
        thinkContentDiv.innerHTML = renderCore(thinkContent);
        thinkBlockWrapper.appendChild(thinkContentDiv);

        html += thinkBlockWrapper.outerHTML;
        processedText = remainingText; // Set the rest of the text to be processed.
    }

    if (processedText) {
        // Use the unified core renderer for the main/remaining content.
        const renderedMainContent = renderCore(processedText);
        
        if (isThinkBlockSegment && temporaryId) {
            html += `<div data-temp-id="streaming-remaining-content">${renderedMainContent}</div>`;
        } else {
            html += renderedMainContent;
        }
    }

    return html;
}

function handleCodeCopy(copyBtn) {
    const wrapper = copyBtn.closest('.code-block-wrapper');
    if (!wrapper) return;

    const codeText = wrapper.dataset.rawCode || '';
    if (!codeText) {
        console.warn("Could not find code text to copy.");
        return;
    }

    navigator.clipboard.writeText(codeText).then(() => {
        copyBtn.innerHTML = '<i class="bi bi-check-lg"></i>';
        copyBtn.disabled = true;
        setTimeout(() => {
            copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>';
            copyBtn.disabled = false;
        }, 500);
    }).catch(err => {
        console.error('Failed to copy code:', err);
        copyBtn.innerHTML = 'Error';
         setTimeout(() => {
             copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>';
         }, 500);
    });
}

function handleCodeCollapse(collapseBtn) {
    const wrapper = collapseBtn.closest('.code-block-wrapper');
    const preElement = wrapper?.querySelector('pre');
    const collapseInfoSpan = wrapper?.querySelector('.collapse-info');
    const icon = collapseBtn.querySelector('i');

    if (!wrapper || !preElement || !collapseInfoSpan || !icon) {
        console.warn("Could not find necessary elements for code collapse.");
        return;
    }

    wrapper.dataset.userToggled = 'true';
    const isCollapsed = wrapper.classList.toggle('collapsed');

    if (isCollapsed) {
        icon.className = 'bi bi-chevron-down';
        collapseBtn.title = 'Expand code';
        const codeText = wrapper.dataset.rawCode || '';
        const lines = codeText.split('\n').length;
        const lineCount = codeText.endsWith('\n') ? lines - 1 : lines;
        collapseInfoSpan.textContent = `${lineCount} lines hidden`;
        collapseInfoSpan.style.display = 'inline-block';
        preElement.style.display = 'none';
    } else {
        icon.className = 'bi bi-chevron-up';
        collapseBtn.title = 'Collapse code';
        collapseInfoSpan.style.display = 'none';
        preElement.style.display = '';
    }
    
    persistCollapseState(wrapper, 'code', isCollapsed);
}

function handleThinkBlockToggle(e) {
    const toggleBtn = e.target.closest('.think-block-toggle');
    if (toggleBtn) {
        const block = toggleBtn.closest('.think-block');
        if (block) {
            block.dataset.userToggled = 'true';
            const isCollapsed = block.classList.toggle('collapsed');
            const icon = toggleBtn.querySelector('i');
            if (isCollapsed) {
                icon.className = 'bi bi-chevron-down';
                toggleBtn.title = 'Expand thought process';
            } else {
                icon.className = 'bi bi-chevron-up';
                toggleBtn.title = 'Collapse thought process';
            }
            persistCollapseState(block, 'think', isCollapsed);
        }
    }
}

function updateEffectiveSystemPrompt() {
    let basePrompt = state.activeSystemPrompt || "";
    let toolsPrompt = "";
    if (state.toolsEnabled && TOOLS_SYSTEM_PROMPT) {
        toolsPrompt = `\n\n${TOOLS_SYSTEM_PROMPT}`;
    }
    state.effectiveSystemPrompt = (basePrompt + toolsPrompt).trim() || null;
    
    let characterNameToDisplay = null;

    const updateDisplay = (name) => {
         displayActiveSystemPrompt(name, state.effectiveSystemPrompt);
    };

    if (state.currentCharacterId) {
        // This fetch is for display purposes only, so we handle errors gracefully
        fetchCharacters()
            .then(characters => {
                const char = characters.find(c => c.character_id === state.currentCharacterId);
                characterNameToDisplay = char?.character_name || null;
                updateDisplay(characterNameToDisplay);
            })
            .catch(error => {
                console.error("Failed to fetch character name for display, proceeding without it.", error);
                updateDisplay(null); // Update display even if fetch fails
            });
    } else {
        updateDisplay(null);
    }
    // Throttle identical prompt logs to reduce console noise
    try {
        const newLogSnippet = state.effectiveSystemPrompt ? state.effectiveSystemPrompt.substring(0, 120) : "None";
        const now = Date.now();
        if (!state._lastPromptLog || state._lastPromptLog.snippet !== newLogSnippet || (now - state._lastPromptLog.time) > 4000) {
            console.log("Effective system prompt updated:", newLogSnippet + (state.effectiveSystemPrompt && state.effectiveSystemPrompt.length > 120 ? "..." : ""));
            state._lastPromptLog = { snippet: newLogSnippet, time: now };
        }
    } catch(e) { /* swallow logging throttle errors */ }
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

function updateScrollButtonVisibility() {
    const scrollButton = document.getElementById('scroll-to-bottom-btn');
    if (!chatContainer || !scrollButton) return;

    const isNearBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 30;
    scrollButton.style.display = isNearBottom ? 'none' : 'flex';
}

function setupScrollListener() {
    const scrollButton = document.getElementById('scroll-to-bottom-btn');
    if (!chatContainer || !scrollButton) {
        console.error("Chat container or scroll button not found for scroll listener setup.");
        return;
    }

    chatContainer.addEventListener('scroll', debounce(updateScrollButtonVisibility, 100));
    scrollButton.addEventListener('click', () => {
        chatContainer.scrollTo({
            top: chatContainer.scrollHeight,
            behavior: 'smooth'
        });
    });
    requestAnimationFrame(updateScrollButtonVisibility);
}

async function init() {
    // Hydrate stored tool selections before fetching metadata
    try {
        const storedEnabledTools = JSON.parse(localStorage.getItem('enabledToolNames') || '[]');
        if (Array.isArray(storedEnabledTools) && storedEnabledTools.length) {
            state.enabledToolNames = new Set(storedEnabledTools.filter(name => typeof name === 'string'));
        }
    } catch (error) {
        console.warn('Failed to parse stored enabled tool names:', error);
    }

    const persistedCharacterId = getPersistedCharacterId();
    if (persistedCharacterId) {
        state.currentCharacterId = persistedCharacterId;
    }

    await fetchProviderConfig();
    await initializeToolsCatalog();
    await loadGenArgs();
    await fetchChats(); // Fetches the list of available chats

    // Hydrate persisted preferences early
    state.toolsEnabled = localStorage.getItem('toolsEnabled') === 'true';
    state.autoscrollEnabled = localStorage.getItem('autoscrollEnabled') === 'true';
    const savedCollapsed = localStorage.getItem('codeBlocksDefaultCollapsed');
    if (savedCollapsed !== null) state.codeBlocksDefaultCollapsed = savedCollapsed === 'true';

    setupCharactersTab();
    setupEventListeners();
    setupScrollListener();
    setupAutoscrollToggle();
    adjustTextareaHeight();
    setupDropZone();
    setupThemeSwitch();
    setupGenerationSettings();
    setupToolToggle();
    setupCodeblockToggle();
    
    // Handle URL-based chat routing
    const chatIdFromUrl = getChatIdFromUrl();
    if (chatIdFromUrl) {
        await loadChat(chatIdFromUrl);
    } else {
        // Start a brand new chat if no chat ID in URL
        startNewChat();
    }
}

async function fetchProviderConfig() {
    try {
        const response = await fetch(`${API_BASE}/config`);
        if (!response.ok) throw new Error(`Failed to fetch config: ${response.statusText}`);
        const backendConfig = await response.json();

        PROVIDER_CONFIG.openrouter_base_url = backendConfig.openrouter_base_url || PROVIDER_CONFIG.openrouter_base_url;
        PROVIDER_CONFIG.local_base_url = backendConfig.local_base_url || PROVIDER_CONFIG.local_base_url;
        state.apiKeys.openrouter = backendConfig.openrouter || null;
        state.apiKeys.google = backendConfig.google || null;
        state.apiKeys.local = backendConfig.local_api_key || null;

    console.log("Fetched provider config.");

    } catch (error) {
        console.error('Error fetching provider config:', error);
        addSystemMessage("Failed to fetch API configuration from backend.", "error");
    }
}

async function fetchToolsSystemPrompt(enabledNames = null) {
    try {
        const params = new URLSearchParams();
        if (Array.isArray(enabledNames)) {
            const sanitizedNames = enabledNames.filter(name => typeof name === 'string' && name.trim());
            if (sanitizedNames.length) {
                sanitizedNames.forEach(name => params.append('names', name));
            } else {
                params.append('names', ''); // Explicitly request an empty tool subset
            }
        }
        const url = params.toString() ? `${API_BASE}/tools/system_prompt?${params.toString()}` : `${API_BASE}/tools/system_prompt`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch tools prompt: ${response.statusText}`);
        const data = await response.json();
        TOOLS_SYSTEM_PROMPT = data.prompt || "";
        console.log("Fetched tools system prompt.");
    } catch (error) {
        console.error('Error fetching tools system prompt:', error);
        TOOLS_SYSTEM_PROMPT = "";
        addSystemMessage("Failed to fetch tool descriptions from backend.", "warning");
    }
    updateToolsPromptPreviewDisplay();
    updateEffectiveSystemPrompt();
}

async function fetchToolsMetadata() {
    try {
        const response = await fetch(`${API_BASE}/tools`);
        if (!response.ok) throw new Error(`Failed to fetch tools metadata: ${response.statusText}`);
        const data = await response.json();
        const tools = Array.isArray(data.tools) ? data.tools : [];
    state.availableTools = tools;
    reconcileEnabledToolSelection();
    renderToolsCheckboxList(document.getElementById('tools-checkbox-list'));
    updateToolsCheckboxDisableState();
    } catch (error) {
        console.error('Error fetching tools metadata:', error);
    state.availableTools = [];
    addSystemMessage('Failed to load tools metadata from backend.', 'warning');
    renderToolsCheckboxList(document.getElementById('tools-checkbox-list'));
    updateToolsCheckboxDisableState();
    }
}

async function initializeToolsCatalog() {
    await fetchToolsMetadata();
    await fetchToolsSystemPrompt(getEnabledToolNamesArray());
}

async function loadGenArgs() {
    const savedGenArgs = localStorage.getItem('genArgs');
    if (savedGenArgs) {
        try { Object.assign(defaultGenArgs, JSON.parse(savedGenArgs)); }
        catch (e) { console.warn('Failed to parse saved genArgs:', e); }
    }
    defaultGenArgs.temperature = defaultGenArgs.temperature ?? null;
    defaultGenArgs.min_p = defaultGenArgs.min_p ?? null;
    defaultGenArgs.max_tokens = defaultGenArgs.max_tokens ?? null;
    defaultGenArgs.top_p = defaultGenArgs.top_p ?? null;
}

async function fetchChats() {
    try {
        const response = await fetch(`${API_BASE}/c/get_chats?limit=100`);
        if (!response.ok) throw new Error(`Failed to fetch chats: ${response.statusText}`);
        state.chats = await response.json();
    } catch (error) {
        console.error('Error fetching chats:', error);
        state.chats = [];
    }
    renderChatList();
}

function renderChatList() {
    const historyItems = chatHistoryContainer.querySelectorAll('.history-item');
    historyItems.forEach(item => item.remove());
    const historyTitle = chatHistoryContainer.querySelector('.history-title');

    if (state.chats.length === 0) {
        if (historyTitle) historyTitle.textContent = 'No Recent Conversations';
        const noChatsMsg = document.createElement('div');
        noChatsMsg.className = 'history-item dimmed';
        noChatsMsg.textContent = 'Start a new chat!';
        chatHistoryContainer.appendChild(noChatsMsg);
        return;
    }

    if (historyTitle) historyTitle.textContent = 'Recent Conversations';

    state.chats.forEach(chat => {
        const item = document.createElement('div');
        item.className = 'history-item';
        item.dataset.chatId = chat.chat_id;

        const icon = document.createElement('i');
        icon.className = 'bi bi-chat';
        const text = document.createElement('span');
        text.textContent = chat.preview || `Chat ${chat.chat_id.substring(0, 6)}`;

        item.appendChild(icon);
        item.appendChild(text);

        item.addEventListener('click', async () => {
            if (state.currentChatId !== chat.chat_id) {
                try {
                    await loadChat(chat.chat_id);
                    requestAnimationFrame(() => {
                        scrollToBottom('auto');
                    });
                } catch (error) {
                    console.error(`Error loading chat ${chat.chat_id} from sidebar click:`, error);
                    addSystemMessage(`Failed to load chat: ${error.message}`, "error");
                }
            }
       });

        if (chat.chat_id === state.currentChatId) {
             item.classList.add('active');
        }
        chatHistoryContainer.appendChild(item);
    });

    const isCollapsed = sidebar.classList.contains('sidebar-collapsed');
    chatHistoryContainer.querySelectorAll('.history-item span, .history-title').forEach(el => {
         el.style.display = isCollapsed ? 'none' : '';
    });
}

function highlightCurrentChatInSidebar() {
    const chatItems = chatHistoryContainer.querySelectorAll('.history-item');
    chatItems.forEach(item => {
        item.classList.toggle('active', item.dataset.chatId === state.currentChatId);
    });
}

async function loadChat(chatId) {
    if (!chatId) { console.warn("loadChat called with null chatId"); startNewChat(); return; }
    console.log(`Loading chat: ${chatId}`);
    state.toolCallPending = false;
    state.toolContinuationContext = null;
    updateCodeblockToggleButton();

    if (state.streamController && !state.streamController.signal.aborted) {
        console.log("Aborting active stream before loading new chat.");
        state.streamController.abort();
        cleanupAfterGeneration();
    }

    try {
        const response = await fetch(`${API_BASE}/c/${chatId}`);
        if (!response.ok) {
             if (response.status === 404) {
                 console.error(`Chat not found: ${chatId}. Removing from list.`);
                 state.chats = state.chats.filter(c => c.chat_id !== chatId);
                 renderChatList(); localStorage.removeItem('lastChatId');
                 if (state.chats.length > 0) await loadChat(state.chats[0].chat_id); else startNewChat();
             } else { throw new Error(`Failed to load chat ${chatId}: ${response.statusText}`); }
             return;
        }
        const chat = await response.json();

        state.currentChatId = chatId;
        state.messages = chat.messages || [];
        state.currentCharacterId = chat.character_id;
        state.activeSystemPrompt = null;
        
        // Update URL to reflect loaded chat
        updateUrlForChat(chatId);

    localStorage.setItem('lastChatId', chatId);
    if (state.currentCharacterId) {
        setPersistedCharacterId(state.currentCharacterId);
    } else {
        setPersistedCharacterId(null);
    }
    updateActiveCharacterUI();

        if (state.currentCharacterId) {
             try {
                  const charResponse = await fetch(`${API_BASE}/character/${state.currentCharacterId}`);
                  if (charResponse.ok) {
                       const activeChar = await charResponse.json();
                       state.activeSystemPrompt = activeChar?.sysprompt || null;
                  } else {
                        console.warn(`Failed to fetch character ${state.currentCharacterId} details. Character might be deleted.`);
                        state.currentCharacterId = null;
                        updateActiveCharacterUI();
                setPersistedCharacterId(null);
                  }
             } catch (charError) {
                console.error("Error fetching character details:", charError);
                state.currentCharacterId = null;
                updateActiveCharacterUI();
             }
        }
        updateEffectiveSystemPrompt();
        messagesWrapper.innerHTML = '';
        highlightCurrentChatInSidebar();

        const hasVisibleMessages = state.messages.some(m => m.role !== 'system');
        if (!hasVisibleMessages) {
             welcomeContainer.style.display = 'flex';
             document.body.classList.add('welcome-active');
             if (chatContainer) chatContainer.style.paddingBottom = '0px';
        } else {
             welcomeContainer.style.display = 'none';
             document.body.classList.remove('welcome-active');
             renderActiveMessages();
             adjustTextareaHeight();
             //requestAnimationFrame(() => {
             //   scrollToBottom('auto');
             //});
        }
    } catch (error) {
        console.error('Error loading chat:', error);
        messagesWrapper.innerHTML = `<div class="system-message error">Failed to load chat: ${error.message}</div>`;
        welcomeContainer.style.display = 'none';
        document.body.classList.remove('welcome-active');
        state.currentChatId = null;
    updateActiveCharacterUI();
        highlightCurrentChatInSidebar();
    } finally {
        requestAnimationFrame(updateScrollButtonVisibility);
    }
}

function renderActiveMessages() {
    messagesWrapper.innerHTML = '';
    state.activeBranchInfo = {};

    if (!state.messages || state.messages.length === 0) {
        console.log("No messages to render.");
        return;
    }

    const messageMap = new Map(state.messages.map(msg => [msg.message_id, { ...msg, children: [] }]));
    const rootMessages = [];
    state.messages.forEach(msg => {
        const msgNode = messageMap.get(msg.message_id);
        if (!msgNode) return;
        if (msg.parent_message_id && messageMap.has(msg.parent_message_id)) {
            const parentNode = messageMap.get(msg.parent_message_id);
            if (!parentNode.children) parentNode.children = [];
            parentNode.children.push(msgNode);
        } else if (!msg.parent_message_id && msg.role !== 'system') {
            rootMessages.push(msgNode);
        }
    });

    messageMap.forEach(node => {
        if (node.children && node.children.length > 0) {
            node.children.sort((a, b) => a.timestamp - b.timestamp);
            if (node.child_message_ids && node.child_message_ids.length > 1) {
                state.activeBranchInfo[node.message_id] = {
                    activeIndex: node.active_child_index ?? 0,
                    totalBranches: node.child_message_ids.length
                };
            }
        }
    });
    rootMessages.sort((a, b) => a.timestamp - b.timestamp);

    // This function recursively calls addMessage for the active branch
    function renderBranch(messageNode) {
        if (!messageNode || messageNode.role === 'system') return;
        
        // Directly add the message. No complex merging.
        addMessage(messageNode);
        
        const children = messageNode.children;
        if (children && children.length > 0) {
            const activeIndex = messageNode.active_child_index ?? 0;
            const safeActiveIndex = Math.min(Math.max(0, activeIndex), children.length - 1);
            const activeChildNode = children[safeActiveIndex];
            if (activeChildNode) {
                renderBranch(activeChildNode);
            } else {
                console.warn(`Could not find active child at index ${safeActiveIndex}.`);
            }
        }
    }

     // Render the tree starting from the roots
     rootMessages.forEach(rootNode => renderBranch(rootNode));

     consolidateAssistantMessageGroups();

     // Post-rendering tasks
     requestAnimationFrame(() => {
            messagesWrapper.querySelectorAll('.message-content pre code').forEach(block => {
                highlightRenderedCode(block.closest('pre'));
            });
     });

    messagesWrapper.querySelectorAll('.assistant-row .message').forEach(messageDiv => {
        messageDiv.style.minHeight = '';
    });

    const lastMessageRow = messagesWrapper.lastElementChild;
    if (lastMessageRow && lastMessageRow.classList.contains('assistant-row') && !lastMessageRow.classList.contains('placeholder')) {
        const lastAssistantMessageDiv = lastMessageRow.querySelector('.message');
        if (lastAssistantMessageDiv && !lastMessageRow.querySelector('.pulsing-cursor')) {
            lastAssistantMessageDiv.style.minHeight = 'calc(-384px + 100dvh)';
        }
    }
}

function consolidateAssistantMessageGroups() {
    if (!messagesWrapper) return;

    const rows = Array.from(messagesWrapper.querySelectorAll('.message-row'));
    const visited = new Set();

    rows.forEach(startRow => {
        const startId = startRow.dataset.messageId;
        if (!startId || visited.has(startId)) return;
        if (!startRow.classList.contains('assistant-row') || startRow.classList.contains('placeholder')) return;

        const groupRows = [];
        let currentRow = startRow;

        while (currentRow) {
            const currentId = currentRow.dataset.messageId;
            if (!currentId) break;
            if (groupRows.some(row => row.dataset.messageId === currentId)) break;

            groupRows.push(currentRow);
            visited.add(currentId);

            const nextRow = currentRow.nextElementSibling;
            if (!nextRow) break;

            const nextId = nextRow.dataset.messageId;
            if (nextId && visited.has(nextId)) break;

            const isAssistant = nextRow.classList.contains('assistant-row') && !nextRow.classList.contains('placeholder');
            const isTool = nextRow.classList.contains('tool-message');
            const isLinked = nextRow.dataset.parentId === currentId;

            if ((isAssistant || isTool) && isLinked) {
                currentRow = nextRow;
                continue;
            }

            break;
        }

        if (groupRows.length <= 1) {
            return;
        }

        const baseRow = [...groupRows].reverse().find(row => row.classList.contains('assistant-row') && !row.classList.contains('placeholder'));
        if (!baseRow) return;

        const baseContent = baseRow.querySelector('.message-content');
        if (!baseContent) return;

        const originalRaw = baseContent.dataset.raw || '';
        const baseParentId = groupRows[0].dataset.parentId || baseRow.dataset.parentId || '';

        const segmentElements = groupRows.map(row => {
            const segmentContent = row.querySelector('.message-content');
            if (!segmentContent) return null;

            const segmentWrapper = document.createElement('div');
            segmentWrapper.className = 'assistant-group-segment';
            segmentWrapper.dataset.segmentMessageId = row.dataset.messageId || '';
            const isToolSegment = row.classList.contains('tool-message');
            segmentWrapper.dataset.segmentRole = isToolSegment ? 'tool' : 'assistant';
            if (isToolSegment) {
                segmentWrapper.classList.add('assistant-group-segment--tool');
            } else {
                segmentWrapper.classList.add('assistant-group-segment--assistant');
            }

            while (segmentContent.firstChild) {
                segmentWrapper.appendChild(segmentContent.firstChild);
            }

            return segmentWrapper;
        }).filter(Boolean);

        if (!segmentElements.length) return;

        baseContent.innerHTML = '';
        segmentElements.forEach(fragment => baseContent.appendChild(fragment));
        baseContent.dataset.raw = originalRaw;

        baseRow.dataset.parentId = baseParentId;
        baseRow.dataset.groupMessageIds = groupRows.map(row => row.dataset.messageId || '').join(',');
        baseRow.classList.add('assistant-group-row');
        baseRow.classList.remove('has-tool-followup');

        groupRows.forEach(row => {
            if (row !== baseRow) {
                row.remove();
            }
        });
    });
}

function findRowForMessageId(messageId) {
    if (!messageId || !messagesWrapper) return null;
    const directRow = messagesWrapper.querySelector(`.message-row[data-message-id="${messageId}"]`);
    if (directRow) return directRow;

    const groupedRows = Array.from(messagesWrapper.querySelectorAll('.message-row[data-group-message-ids]'));
    return groupedRows.find(row => row.dataset.groupMessageIds?.split(',').map(id => id.trim()).includes(messageId)) || null;
}

function resolveMessageGroupInfo(targetMessageId) {
    const row = findRowForMessageId(targetMessageId);
    if (!row) {
        return {
            row: null,
            groupIds: [targetMessageId],
            primaryMessageId: targetMessageId,
            finalMessageId: targetMessageId
        };
    }

    const groupAttr = row.dataset.groupMessageIds;
    if (!groupAttr) {
        return {
            row,
            groupIds: [targetMessageId],
            primaryMessageId: targetMessageId,
            finalMessageId: targetMessageId
        };
    }

    const idList = groupAttr.split(',').map(id => id.trim()).filter(Boolean);
    const primaryMessageId = idList[0] || targetMessageId;
    const finalMessageId = idList[idList.length - 1] || targetMessageId;
    return {
        row,
        groupIds: idList,
        primaryMessageId,
        finalMessageId
    };
}

function findClosestMessageRow(messageId) {
    if (!messageId || !messagesWrapper) return null;
    const visited = new Set();
    let currentId = messageId;

    while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const candidateRow = findRowForMessageId(currentId);
        if (candidateRow) {
            return candidateRow;
        }
        const msg = state.messages.find(m => m.message_id === currentId);
        currentId = msg?.parent_message_id || null;
    }
    return null;
}

function setCodeBlockCollapsedState(wrapper, shouldBeCollapsed) {
    if (!wrapper) return;

    const preElement = wrapper.querySelector('pre');
    const collapseInfoSpan = wrapper.querySelector('.collapse-info');
    const collapseBtn = wrapper.querySelector('.collapse-btn');
    const icon = collapseBtn?.querySelector('i');

    if (!preElement || !collapseInfoSpan || !collapseBtn || !icon) {
        return;
    }

    const isCurrentlyCollapsed = wrapper.classList.contains('collapsed');

    if (shouldBeCollapsed && !isCurrentlyCollapsed) {
        wrapper.classList.add('collapsed');
        icon.className = 'bi bi-chevron-down';
        collapseBtn.title = 'Expand code';
        const codeText = wrapper.dataset.rawCode || '';
        const lines = codeText.split('\n').length;
        const lineCount = codeText.endsWith('\n') ? lines - 1 : lines;
        collapseInfoSpan.textContent = `${lineCount} lines hidden`;
        collapseInfoSpan.style.display = 'inline-block';
        preElement.style.display = 'none';
    } else if (!shouldBeCollapsed && isCurrentlyCollapsed) {
        wrapper.classList.remove('collapsed');
        icon.className = 'bi bi-chevron-up';
        collapseBtn.title = 'Collapse code';
        collapseInfoSpan.style.display = 'none';
        preElement.style.display = '';
    }
}

function updateCodeblockToggleButton() {
    const button = document.getElementById('toggle-codeblocks-btn');
    if (!button) return;
    const icon = button.querySelector('i');
    if (!icon) return;
    
    button.classList.toggle('active', state.codeBlocksDefaultCollapsed);

    if (state.codeBlocksDefaultCollapsed) {
        icon.className = 'bi bi-arrows-expand';
        button.title = 'Expand All Code Blocks (Default)';
    } else {
        icon.className = 'bi bi-arrows-collapse';
        button.title = 'Collapse All Code Blocks (Default)';
    }
}

function setupCodeblockToggle() {
    // Load persisted preference (if any) before wiring UI so initial renders respect it.
    const saved = localStorage.getItem('codeBlocksDefaultCollapsed');
    if (saved !== null) {
        state.codeBlocksDefaultCollapsed = saved === 'true';
    }

    const button = document.getElementById('toggle-codeblocks-btn');
    if (!button) {
        console.warn("Global code block toggle button not found; using stored default only.");
        return; // Nothing else to do – feature optional.
    }

    button.addEventListener('click', () => {
        state.codeBlocksDefaultCollapsed = !state.codeBlocksDefaultCollapsed;
        localStorage.setItem('codeBlocksDefaultCollapsed', state.codeBlocksDefaultCollapsed);
        console.log("Code block default collapsed state toggled to:", state.codeBlocksDefaultCollapsed);
        updateCodeblockToggleButton();
        const allCodeBlocks = messagesWrapper.querySelectorAll('.code-block-wrapper');
        console.log(`Applying new default state to ${allCodeBlocks.length} existing code blocks.`);
        allCodeBlocks.forEach(block => {
            setCodeBlockCollapsedState(block, state.codeBlocksDefaultCollapsed);
        });
    });
    updateCodeblockToggleButton();
}

function createCodeBlockWithContent(codeText, lang) {
    const isInitiallyCollapsed = state.codeBlocksDefaultCollapsed;

    const wrapper = document.createElement('div');
    wrapper.className = `code-block-wrapper ${isInitiallyCollapsed ? 'collapsed' : ''}`;
    wrapper.dataset.rawCode = codeText;

    const header = document.createElement('div');
    header.className = 'code-header';
    const filetypeSpan = document.createElement('span');
    filetypeSpan.className = 'code-header-filetype';
    filetypeSpan.textContent = lang || 'code';
    header.appendChild(filetypeSpan);
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'code-header-actions';
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'code-header-btn collapse-btn';
    collapseBtn.innerHTML = `<i class="bi bi-chevron-${isInitiallyCollapsed ? 'down' : 'up'}"></i>`;
    collapseBtn.title = isInitiallyCollapsed ? 'Expand code' : 'Collapse code';

    const collapseInfoSpan = document.createElement('span');
    collapseInfoSpan.className = 'collapse-info';
    if (isInitiallyCollapsed) {
        const lines = codeText.split('\n').length;
        const lineCount = codeText.endsWith('\n') ? lines - 1 : lines;
        collapseInfoSpan.textContent = `${lineCount} lines hidden`;
        collapseInfoSpan.style.display = 'inline-block';
    } else {
        collapseInfoSpan.style.display = 'none';
    }

    actionsDiv.appendChild(collapseInfoSpan);
    actionsDiv.appendChild(collapseBtn);
    const copyBtn = document.createElement('button');
    copyBtn.className = 'code-header-btn copy-btn';
    copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>';
    copyBtn.title = 'Copy code';
    actionsDiv.appendChild(copyBtn);
    header.appendChild(actionsDiv);

    const newPre = document.createElement('pre');
    newPre.style.display = isInitiallyCollapsed ? 'none' : '';
    const newCode = document.createElement('code');
    if (lang) {
        newCode.className = `language-${lang}`;
    }
    newCode.textContent = codeText;

    try {
        hljs.highlightElement(newCode);
    } catch (e) {
        console.error("Error highlighting code in createCodeBlockWithContent:", e);
    }

    newPre.appendChild(newCode);
    wrapper.appendChild(header);
    wrapper.appendChild(newPre);

    return wrapper;
}

function enhanceCodeBlock(preElement) {
    const codeElement = preElement.querySelector('code');
    if (!codeElement) return;

    const codeText = codeElement.textContent || '';
    const langClass = Array.from(codeElement.classList).find(cls => cls.startsWith('language-'));
    const lang = langClass ? langClass.substring(9) : '';

    const wrapper = createCodeBlockWithContent(codeText, lang);
    preElement.replaceWith(wrapper);
}

function buildContentHtml(targetContentDiv, messageText) {
    if (!targetContentDiv) return;

    const textToParse = messageText || '';
    const thinkBlockTempId = 'streaming-think-block';
    const remainingContentTempId = 'streaming-remaining-content';
    const cotTagPairs = getCotTagPairs();
    const startsWithCot = startsWithCotBlock(textToParse, cotTagPairs);

    // Save collapse states before rebuilding to preserve user interactions
    const savedStates = captureCollapseStates(targetContentDiv);
    
    targetContentDiv.innerHTML = '';

    if (startsWithCot) {
        const fullRenderedHtml = renderMarkdown(textToParse, true, thinkBlockTempId);
        targetContentDiv.innerHTML = fullRenderedHtml;
         const thinkBlock = targetContentDiv.querySelector('.think-block');
         if (thinkBlock && !thinkBlock.dataset.tempId) {
             thinkBlock.dataset.tempId = thinkBlockTempId;
         }
         const potentialRemainingDiv = thinkBlock?.nextElementSibling;
         const { remainingText } = parseThinkContent(textToParse, cotTagPairs);
         if (potentialRemainingDiv && potentialRemainingDiv.tagName === 'DIV' && !potentialRemainingDiv.dataset.tempId && remainingText) {
              potentialRemainingDiv.dataset.tempId = remainingContentTempId;
         }
    } else {
        let lastIndex = 0;
        const segments = [];
        TOOL_TAG_REGEX.lastIndex = 0;
        let match;

        while ((match = TOOL_TAG_REGEX.exec(textToParse)) !== null) {
            const textBefore = textToParse.substring(lastIndex, match.index);
            if (textBefore) {
                segments.push({ type: 'text', data: textBefore });
            }

            const toolCallTag = match[1];
            const toolResultTag = match[5];

            if (toolCallTag) {
                const toolName = match[2];
                const toolIdAttr = match[3] || null;
                const payloadRaw = match[4] || '';
                const payloadInfo = parseToolCallPayload(payloadRaw);
                const resolvedId = toolIdAttr || payloadInfo.inferredId || null;
                segments.push({
                    type: 'tool',
                    data: {
                        name: toolName,
                        id: resolvedId,
                        payloadInfo
                    }
                });
            } else if (toolResultTag) {
                const resultName = match[6] || null;
                const resultStatus = match[7] || null;
                const resultBodyRaw = match[8] || '';
                segments.push({
                    type: 'result',
                    data: {
                        name: resultName,
                        status: resultStatus,
                        body: decodeHtmlEntities(resultBodyRaw),
                        raw: resultBodyRaw
                    }
                });
            }
            lastIndex = TOOL_TAG_REGEX.lastIndex;
        }

        const remainingTextAfterTags = textToParse.substring(lastIndex);
        if (remainingTextAfterTags) {
            segments.push({ type: 'text', data: remainingTextAfterTags });
        }

        // Determine which tool calls have corresponding results
        const toolCallsWithResults = new Set();
        for (let i = 0; i < segments.length; i++) {
            if (segments[i].type === 'tool') {
                const toolName = segments[i].data?.name;
                // Check if there's a result for this tool call in subsequent segments
                for (let j = i + 1; j < segments.length; j++) {
                    if (segments[j].type === 'result' && segments[j].data?.name === toolName) {
                        toolCallsWithResults.add(i);
                        break;
                    }
                }
            }
        }

        segments.forEach((segment, idx) => {
            if (segment.type === 'text') {
                targetContentDiv.insertAdjacentHTML('beforeend', renderMarkdown(segment.data));
            } else if (segment.type === 'tool') {
                // Pass options to indicate if this tool was already executed
                const wasExecuted = toolCallsWithResults.has(idx);
                renderToolCallPlaceholder(targetContentDiv, segment.data, { executed: wasExecuted });
            } else if (segment.type === 'result') {
                renderToolResult(targetContentDiv, segment.data);
            }
        });
    }
    applyCodeBlockDefaults(targetContentDiv);
    applyCollapseStates(targetContentDiv, savedStates);
}

function applyCodeBlockDefaults(containerElement) {
    if (!containerElement) return;
    containerElement.querySelectorAll('.code-block-wrapper').forEach(block => {
        if (!block.dataset.userToggled) {
            setCodeBlockCollapsedState(block, state.codeBlocksDefaultCollapsed);
        }
    });
}

// Unified collapse state management - captures user-toggled states from DOM
function captureCollapseStates(containerElement) {
    if (!containerElement) return null;
    const states = { code: new Map(), think: new Map(), tool: new Map() };
    
    containerElement.querySelectorAll('.code-block-wrapper').forEach(block => {
        if (block.dataset.userToggled !== 'true') return;
        const key = (block.dataset.rawCode || '').substring(0, 100);
        states.code.set(key, block.classList.contains('collapsed'));
    });
    
    containerElement.querySelectorAll('.think-block').forEach(block => {
        if (block.dataset.userToggled !== 'true') return;
        states.think.set('think_0', block.classList.contains('collapsed'));
    });
    
    containerElement.querySelectorAll('.tool-call-block, .tool-result-block').forEach(block => {
        if (block.dataset.userToggled !== 'true') return;
        const key = `${block.dataset.toolName || ''}_${block.dataset.callId || ''}`;
        states.tool.set(key, block.classList.contains('collapsed'));
    });
    
    return (states.code.size || states.think.size || states.tool.size) ? states : null;
}

// Apply saved collapse states to container
function applyCollapseStates(containerElement, states) {
    if (!containerElement || !states) return;
    
    containerElement.querySelectorAll('.code-block-wrapper').forEach(block => {
        const key = (block.dataset.rawCode || '').substring(0, 100);
        if (states.code?.has(key)) {
            block.dataset.userToggled = 'true';
            setCodeBlockCollapsedState(block, states.code.get(key));
        }
    });
    
    containerElement.querySelectorAll('.think-block').forEach(block => {
        if (states.think?.has('think_0')) {
            block.dataset.userToggled = 'true';
            const collapsed = states.think.get('think_0');
            block.classList.toggle('collapsed', collapsed);
            const icon = block.querySelector('.think-block-toggle i');
            if (icon) icon.className = collapsed ? 'bi bi-chevron-down' : 'bi bi-chevron-up';
        }
    });
    
    containerElement.querySelectorAll('.tool-call-block, .tool-result-block').forEach(block => {
        const key = `${block.dataset.toolName || ''}_${block.dataset.callId || ''}`;
        if (states.tool?.has(key)) {
            block.dataset.userToggled = 'true';
            const collapsed = states.tool.get(key);
            block.classList.toggle('collapsed', collapsed);
            const icon = block.querySelector('.tool-collapse-btn i');
            if (icon) icon.className = collapsed ? 'bi bi-chevron-down' : 'bi bi-chevron-up';
        }
    });
}

// Persist a single element's collapse state to the message-level store
function persistCollapseState(element, type, isCollapsed) {
    const messageRow = element.closest('.message-row');
    const messageId = messageRow?.dataset.messageId;
    if (!messageId) return;
    
    if (!state.userCollapseStates.has(messageId)) {
        state.userCollapseStates.set(messageId, { code: new Map(), think: new Map(), tool: new Map() });
    }
    const msgState = state.userCollapseStates.get(messageId);
    
    if (type === 'code') {
        msgState.code.set((element.dataset.rawCode || '').substring(0, 100), isCollapsed);
    } else if (type === 'think') {
        msgState.think.set('think_0', isCollapsed);
    } else if (type === 'tool') {
        msgState.tool.set(`${element.dataset.toolName || ''}_${element.dataset.callId || ''}`, isCollapsed);
    }
}

// Apply persisted collapse states to a message row (after loadChat)
function applyPersistedCollapseStates(messageRow) {
    const messageId = messageRow?.dataset.messageId;
    if (!messageId || !state.userCollapseStates.has(messageId)) return;
    
    const contentDiv = messageRow.querySelector('.message-content');
    if (contentDiv) applyCollapseStates(contentDiv, state.userCollapseStates.get(messageId));
}

async function handleGenerateOrRegenerateFromUser(userMessageId) {
    const currentChatId = state.currentChatId;
    if (!currentChatId || document.getElementById('send-button').disabled) {
        addSystemMessage("Cannot generate while busy.", "warning");
        return;
    }

    const userMessage = state.messages.find(m => m.message_id === userMessageId);
    if (!userMessage || userMessage.role !== 'user') {
        addSystemMessage("Invalid target message for generation.", "error");
        return;
    }

    if (!state.charactersCache.length) {
        try { await fetchCharacters(true); } catch(e) { /* ignore */ }
    }
    const modelNameToUse = getActiveCharacterModel();
    if (!modelNameToUse) {
        // Attempt one lazy refresh in case characters cache populated after activation.
        try { await fetchCharacters(true); } catch(e) { /* ignore */ }
        const retryModel = getActiveCharacterModel();
        if (!retryModel) {
            addSystemMessage('Active character has no preferred model (yet). Edit the character to assign one.', 'error');
            return;
        }
    }

    const isLastMessage = findLastActiveMessageId(state.messages) === userMessageId;
    let assistantPlaceholderRow = null;

    console.log(`Action triggered for user message ${userMessageId}. Is last: ${isLastMessage}`);

    try {
        const userMessageRow = messagesWrapper.querySelector(`.message-row[data-message-id="${userMessageId}"]`);
        if (!userMessageRow) {
            throw new Error(`Could not find user message row ${userMessageId} in DOM.`);
        }

        if (!isLastMessage) {
            console.log(`Regenerating response for user message ${userMessageId}. Replacing existing branch.`);
            const childMessage = state.messages.find(m =>
                m.parent_message_id === userMessageId &&
                m.role === 'llm' &&
                userMessage.child_message_ids?.includes(m.message_id) &&
                (userMessage.active_child_index === undefined || userMessage.child_message_ids[userMessage.active_child_index ?? 0] === m.message_id)
            );

            if (childMessage) {
                const childMessageIdToDelete = childMessage.message_id;
                console.log(`Found child message ${childMessageIdToDelete} to delete.`);
                removeMessageAndDescendantsFromDOM(childMessageIdToDelete);
                const deleteSuccess = await deleteMessageFromBackend(currentChatId, childMessageIdToDelete);
                if (!deleteSuccess) {
                    throw new Error("Failed to delete existing message branch before regenerating.");
                }
            } else {
                console.warn(`Could not find the active assistant message following ${userMessageId} to replace. Proceeding to generate.`);
            }
        } else {
            console.log(`Generating new response for last user message ${userMessageId}.`);
        }

        assistantPlaceholderRow = createPlaceholderMessageRow(`temp_assistant_${Date.now()}`, userMessageId);
        userMessageRow.insertAdjacentElement('afterend', assistantPlaceholderRow);

        const assistantContentDiv = assistantPlaceholderRow.querySelector('.message-content');
        if (!assistantContentDiv) {
             assistantPlaceholderRow?.remove();
             throw new Error("Failed to create assistant response placeholder element.");
        }
        
        // The initial scroll to the placeholder will be handled by generateAssistantResponse.

        await generateAssistantResponse(
            userMessageId,
            assistantContentDiv,
            modelNameToUse,
            defaultGenArgs,
            state.toolsEnabled
        );
    } catch (error) {
        console.error(`Error during generate/regenerate from user message ${userMessageId}:`, error);
        addSystemMessage(`Generation failed: ${error.message}`, "error");
        assistantPlaceholderRow?.remove();
        try { await loadChat(currentChatId); } catch(e) {
            console.error("Failed to reload chat after generation error:", e);
        }
        cleanupAfterGeneration();
         requestAnimationFrame(updateScrollButtonVisibility);

        return;
    }

}

async function handleSaveAndSend(userMessageId, textareaElement) {
    const newText = textareaElement.value.trim();
    const originalMessage = state.messages.find(m => m.message_id === userMessageId);

    if (!originalMessage || originalMessage.role !== 'user') {
        console.error("handleSaveAndSend: Invalid original message or not a user message.");
        return;
    }

    const buttonContainer = textareaElement.closest('.edit-buttons');
    const buttons = buttonContainer?.querySelectorAll('button');
    buttons?.forEach(btn => btn.disabled = true);

    try {
        console.log(`Save & Send: Saving edit for user message ${userMessageId}`);
        const saveSuccess = await saveEdit(userMessageId, newText, 'user', false);

        if (saveSuccess) {
            console.log(`Save & Send: Edit saved successfully. Now triggering generation for ${userMessageId}.`);

            const messageRow = messagesWrapper.querySelector(`.message-row[data-message-id="${userMessageId}"]`);
            const contentDiv = messageRow?.querySelector('.message-content');
            const actionsDiv = messageRow?.querySelector('.message-actions');

            if (contentDiv) {
                contentDiv.classList.remove('editing');
                contentDiv.innerHTML = renderMarkdown(newText);
                contentDiv.dataset.raw = newText;
                 contentDiv.querySelectorAll('pre code').forEach(block => {
                     highlightRenderedCode(block.closest('pre'));
                 });
            }
             if (actionsDiv) actionsDiv.style.display = '';


            const msgIndex = state.messages.findIndex(m => m.message_id === userMessageId);
            if (msgIndex > -1) {
                 state.messages[msgIndex].message = newText;
            }
            await handleGenerateOrRegenerateFromUser(userMessageId);
        } else {
             buttons?.forEach(btn => btn.disabled = false);
             addSystemMessage("Failed to save changes before sending.", "error");
        }
    } catch (error) {
        console.error('Error during Save & Send:', error);
        addSystemMessage(`Error: ${error.message}`, "error");
        buttons?.forEach(btn => btn.disabled = false);
    }
}

function addMessage(message) {
    if (message.role === 'system') return null;

    const role = message.role === 'llm' ? 'assistant' : message.role;
    const messageRow = document.createElement('div');
    messageRow.className = `message-row ${role}-row ${role === 'tool' ? 'tool-message' : ''}`;
    messageRow.dataset.messageId = message.message_id;
    if (message.parent_message_id) {
        messageRow.dataset.parentId = message.parent_message_id;
    }

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.dataset.raw = message.message || '';

    let avatarActionsDiv = null;
    let actionsDiv = null;
    const suppressAssistantActions = role === 'assistant' && isAssistantToolOnlyMessage(message);
    const shouldCreateActions = role === 'user' || role === 'tool' || (role === 'assistant' && !suppressAssistantActions);

    if (shouldCreateActions) {
        avatarActionsDiv = document.createElement('div');
        avatarActionsDiv.className = 'message-avatar-actions';
        actionsDiv = document.createElement('div');
        actionsDiv.className = 'message-actions';
    }

    const branchInfo = state.activeBranchInfo[message.message_id];
    if (actionsDiv && branchInfo && branchInfo.totalBranches > 1) {
        const branchNav = document.createElement('div');
        branchNav.className = 'branch-nav';
        const prevBtn = document.createElement('button');
        prevBtn.innerHTML = '<i class="bi bi-chevron-left"></i>';
        prevBtn.disabled = branchInfo.activeIndex === 0;
        prevBtn.title = 'Previous response branch';
        prevBtn.onclick = () => setActiveBranch(message.message_id, branchInfo.activeIndex - 1);
        branchNav.appendChild(prevBtn);
        const branchStatus = document.createElement('span');
        branchStatus.textContent = `${branchInfo.activeIndex + 1}/${branchInfo.totalBranches}`;
        branchNav.appendChild(branchStatus);
        const nextBtn = document.createElement('button');
        nextBtn.innerHTML = '<i class="bi bi-chevron-right"></i>';
        nextBtn.disabled = branchInfo.activeIndex >= branchInfo.totalBranches - 1;
        nextBtn.title = 'Next response branch';
        nextBtn.onclick = () => setActiveBranch(message.message_id, branchInfo.activeIndex + 1);
        branchNav.appendChild(nextBtn);
        actionsDiv.appendChild(branchNav);
    }

    let orderedButtons = [];
    const copyBtn = document.createElement('button');
    copyBtn.className = 'message-action-btn';
    copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>';
    copyBtn.title = 'Copy message text';
    copyBtn.addEventListener('click', () => copyMessageContent(contentDiv, copyBtn));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'message-action-btn delete-btn';
    deleteBtn.innerHTML = '<i class="bi bi-trash"></i>';
    deleteBtn.title = 'Delete message (and descendants)';
    deleteBtn.addEventListener('click', () => deleteMessage(message.message_id));

    if (role === 'user') {
        const editBtn = document.createElement('button');
        editBtn.className = 'message-action-btn';
        editBtn.innerHTML = '<i class="bi bi-pencil"></i>';
        editBtn.title = 'Edit message';
        editBtn.addEventListener('click', () => startEditing(message.message_id));

        const isLastMessage = findLastActiveMessageId(state.messages) === message.message_id;
        const genRegenBtn = document.createElement('button');
        genRegenBtn.className = 'message-action-btn';
        genRegenBtn.onclick = () => handleGenerateOrRegenerateFromUser(message.message_id);
        if (isLastMessage) {
            genRegenBtn.innerHTML = '<i class="bi bi-play-circle"></i>';
            genRegenBtn.title = 'Generate response to this message';
        } else {
            genRegenBtn.innerHTML = '<i class="bi bi-arrow-repeat"></i>';
            genRegenBtn.title = 'Regenerate response (Replace existing)';
        }
        orderedButtons = [copyBtn, editBtn, genRegenBtn, deleteBtn];

    } else if (role === 'assistant' && actionsDiv) {
        const genInfoBtn = document.createElement('button');
        genInfoBtn.className = 'message-action-btn gen-info-btn';
        genInfoBtn.innerHTML = '<i class="bi bi-info-circle"></i>';
        const modelName = message.model_name || 'N/A';
        const formattedTimestamp = new Date(message.timestamp).toLocaleString();
        const infoTitle = `Model: ${modelName}\nGenerated: ${formattedTimestamp}`;
        genInfoBtn.title = infoTitle;

        const editBtn = document.createElement('button');
        editBtn.className = 'message-action-btn';
        editBtn.innerHTML = '<i class="bi bi-pencil"></i>';
        editBtn.title = 'Edit message';
        editBtn.addEventListener('click', () => startEditing(message.message_id));

        const regenerateBtn = document.createElement('button');
        regenerateBtn.className = 'message-action-btn';
        regenerateBtn.innerHTML = '<i class="bi bi-arrow-repeat"></i>';
        regenerateBtn.title = 'Regenerate this response (Replace)';
        regenerateBtn.addEventListener('click', () => regenerateMessage(message.message_id, false));

        const branchBtn = document.createElement('button');
        branchBtn.className = 'message-action-btn';
        branchBtn.innerHTML = '<i class="bi bi-diagram-3"></i>';
        branchBtn.title = 'Regenerate as new branch';
        branchBtn.addEventListener('click', () => regenerateMessage(message.message_id, true));

    orderedButtons = [genInfoBtn, copyBtn, editBtn, regenerateBtn, branchBtn, deleteBtn];

    } else if (role === 'tool') {
        // Tool messages can trigger regeneration of the parent LLM message
        const regenerateBtn = document.createElement('button');
        regenerateBtn.className = 'message-action-btn';
        regenerateBtn.innerHTML = '<i class="bi bi-arrow-repeat"></i>';
        regenerateBtn.title = 'Regenerate parent response (Replace)';
        regenerateBtn.addEventListener('click', () => regenerateMessage(message.message_id, false));

        const branchBtn = document.createElement('button');
        branchBtn.className = 'message-action-btn';
        branchBtn.innerHTML = '<i class="bi bi-diagram-3"></i>';
        branchBtn.title = 'Regenerate parent as new branch';
        branchBtn.addEventListener('click', () => regenerateMessage(message.message_id, true));

        orderedButtons = [copyBtn, regenerateBtn, branchBtn, deleteBtn];
    }

    if (actionsDiv) {
        orderedButtons.forEach(btn => actionsDiv.appendChild(btn));
    }

    // --- START OF FIX ---
    // Unified and simplified rendering logic for all message types.
    // renderMarkdown handles all necessary conversions, including code block enhancement.
    if (role === 'tool') {
        // Tool results are special and don't use markdown.
        renderToolResult(contentDiv, message.message || '[Empty Tool Result]');
    } else if (role === 'assistant') {
        buildContentHtml(contentDiv, message.message || '');
        finalizeStreamingCodeBlocks(contentDiv);
    } else {
        contentDiv.innerHTML = renderMarkdown(message.message || '');
    }
    // --- END OF FIX ---

    messageDiv.appendChild(contentDiv);

    if (role !== 'tool' && message.attachments && message.attachments.length > 0) {
        const attachmentsContainer = document.createElement('div');
        attachmentsContainer.className = 'attachments-container';
        message.attachments.forEach(attachment => {
             let rawContent = attachment.content;
             if (attachment.type === 'image') {
                 const imgWrapper = document.createElement('div');
                 imgWrapper.className = 'attachment-preview image-preview-wrapper';
                 imgWrapper.addEventListener('click', () => viewAttachmentPopup({...attachment, rawContent}));
                 const img = document.createElement('img');
                 img.src = `data:image/jpeg;base64,${String(attachment.content)}`;
                 img.alt = attachment.name || 'Attached image';
                 imgWrapper.appendChild(img);
                 attachmentsContainer.appendChild(imgWrapper);
             } else if (attachment.type === 'file') {
                 const fileWrapper = document.createElement('div');
                 fileWrapper.className = 'attachment-preview file-preview-wrapper';
                 const match = String(attachment.content).match(/^.*:\n```[^\n]*\n([\s\S]*)\n```$/);
                 if (match && match[1]) { rawContent = match[1]; }
                 fileWrapper.addEventListener('click', () => viewAttachmentPopup({...attachment, rawContent}));
                 const filename = attachment.name || 'Attached File';
                 fileWrapper.innerHTML = `<i class="bi bi-file-earmark-text"></i> <span>${filename}</span>`;
                 attachmentsContainer.appendChild(fileWrapper);
             }
        });
        contentDiv.appendChild(attachmentsContainer);
    }

    if (avatarActionsDiv && actionsDiv) {
        avatarActionsDiv.appendChild(actionsDiv);
        messageDiv.appendChild(avatarActionsDiv);
    }
    messageRow.appendChild(messageDiv);

    if (role === 'tool') {
        const previousRow = messagesWrapper.lastElementChild;
        if (previousRow && previousRow.classList.contains('assistant-row')) {
            previousRow.classList.add('has-tool-followup');
        }
    }

    messagesWrapper.appendChild(messageRow);
    
    // Apply any persisted user collapse states for this message
    applyPersistedCollapseStates(messageRow);
    
    return contentDiv;
}

async function setActiveBranch(parentMessageId, newIndex) {
     console.log(`Setting active branch for parent ${parentMessageId} to index ${newIndex}`);
     if (!state.currentChatId) return;

     try {
         const response = await fetch(`${API_BASE}/c/${state.currentChatId}/set_active_branch/${parentMessageId}`, {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ child_index: newIndex })
         });
         if (!response.ok) {
             const errorData = await response.json().catch(() => ({ detail: response.statusText }));
             throw new Error(`Failed to set active branch: ${errorData.detail || response.statusText}`);
         }
         await loadChat(state.currentChatId);
     } catch (error) {
         console.error('Error setting active branch:', error);
         addSystemMessage(`Failed to switch branch: ${error.message}`, "error");
     }
}

async function deleteMessage(messageId) {
    if (!state.currentChatId) return;

    let messageToDelete = state.messages.find(m => m.message_id === messageId);
    if (!messageToDelete) {
        console.warn(`Message ${messageId} not found in state for deletion.`);
        return;
    }
    
    // If deleting a tool message, walk up to find the parent LLM message and delete from there
    // This ensures the full tool call chain is deleted together
    if (messageToDelete.role === 'tool') {
        const parentLlmId = messageToDelete.parent_message_id;
        const parentLlm = parentLlmId ? state.messages.find(m => m.message_id === parentLlmId) : null;
        if (parentLlm && (parentLlm.role === 'llm' || parentLlm.role === 'assistant')) {
            console.log(`Tool message ${messageId} -> walking up to delete parent LLM message ${parentLlmId}`);
            messageToDelete = parentLlm;
            messageId = parentLlmId;
        }
    }
    
    console.log(`Deleting message ${messageId} and descendants.`);

    try {
        const response = await fetch(`${API_BASE}/c/${state.currentChatId}/delete_message/${messageId}`, {
            method: 'POST'
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ detail: response.statusText }));
            throw new Error(`Failed to delete message: ${errorData.detail || response.statusText}`);
        }
        await loadChat(state.currentChatId);
        await fetchChats();
    } catch (error) {
        console.error('Error deleting message:', error);
        addSystemMessage(`Failed to delete message: ${error.message}`, "error");
        try { await loadChat(state.currentChatId); } catch(e) { console.error("Failed to reload chat after deletion error:", e); }
    }
}

function startEditing(messageId) {
    const messageRow = messagesWrapper.querySelector(`.message-row[data-message-id="${messageId}"]`);
    if (!messageRow) return;
    const contentDiv = messageRow.querySelector('.message-content');
    const actionsDiv = messageRow.querySelector('.message-actions');
    if (!contentDiv) return;

    const message = state.messages.find(m => m.message_id === messageId);
    if (!message) return;

    if (message.role === 'tool') {
         addSystemMessage("Cannot edit tool result messages.", "warning");
         return;
    }
    const hasToolChild = state.messages.some(m => m.parent_message_id === messageId && m.role === 'tool');
    if ((message.role === 'llm' || message.role === 'assistant') && (hasToolChild || contentDiv.querySelector('.tool-call-block'))) {
        addSystemMessage("Editing messages that involve tool execution is not currently supported.", "warning");
        return;
    }

    const originalContentHTML = contentDiv.innerHTML;
    const originalActionsDisplay = actionsDiv ? actionsDiv.style.display : '';
    const toolBlocks = messageRow.querySelectorAll('.tool-call-block, .tool-result-block');

    contentDiv.classList.add('editing');
    if (actionsDiv) actionsDiv.style.display = 'none';
    toolBlocks.forEach(el => el.style.display = 'none');
    contentDiv.innerHTML = '';

    const textarea = document.createElement('textarea');
    textarea.className = 'edit-textarea';
    textarea.value = contentDiv.dataset.raw || message.message || '';
    textarea.rows = Math.min(20, Math.max(3, textarea.value.split('\n').length + 1));

    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'edit-buttons';

    const saveButton = document.createElement('button');
    saveButton.textContent = 'Save';
    saveButton.className = 'btn-primary';
    saveButton.onclick = () => saveEdit(messageId, textarea.value, message.role);

    const cancelButton = document.createElement('button');
    cancelButton.textContent = 'Cancel';
    cancelButton.className = 'btn-secondary';
    cancelButton.onclick = () => {
        contentDiv.classList.remove('editing');
        contentDiv.innerHTML = originalContentHTML;
        if (actionsDiv) actionsDiv.style.display = originalActionsDisplay;
        toolBlocks.forEach(el => el.style.display = '');
        contentDiv.querySelectorAll('pre:not(.code-block-wrapper pre)').forEach(pre => {
            const code = pre.querySelector('code');
            if (code) enhanceCodeBlock(pre);
        });
        contentDiv.querySelectorAll('.code-block-wrapper code:not(.hljs)').forEach(code => {
             try { hljs.highlightElement(code); } catch(e) { console.warn("Error re-highlighting on cancel edit:", e); }
        });
    };

    buttonContainer.appendChild(saveButton);

    if (message.role === 'user') {
        const saveAndSendButton = document.createElement('button');
        saveAndSendButton.innerHTML = '<i class="bi bi-send-check"></i> Save & Send';
        saveAndSendButton.className = 'btn-secondary';
        saveAndSendButton.title = 'Save changes and generate a new response';
        saveAndSendButton.onclick = () => handleSaveAndSend(messageId, textarea);
        buttonContainer.appendChild(saveAndSendButton);
    }

    buttonContainer.appendChild(cancelButton);
    contentDiv.appendChild(textarea);
    contentDiv.appendChild(buttonContainer);
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
}

async function saveEdit(messageId, newText, role, reloadChat = true) {
    const originalMessage = state.messages.find(m => m.message_id === messageId);
    if (!originalMessage) return false;

   console.log(`Saving edit for message ${messageId}. Reload chat: ${reloadChat}`);
   const attachmentsForSave = (originalMessage.attachments || []).map(att => ({
       type: att.type,
       content: att.content,
       name: att.name
   }));
   const toolCallsForSave = originalMessage.tool_calls || null;

   try {
       const response = await fetch(`${API_BASE}/c/${state.currentChatId}/edit_message/${messageId}`, {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({
                message: newText,
                model_name: originalMessage.model_name,
                attachments: attachmentsForSave,
                tool_calls: toolCallsForSave
           })
       });
       if (!response.ok) {
            const errorData = await response.json().catch(() => ({ detail: response.statusText }));
           throw new Error(`Failed to edit message: ${errorData.detail || response.statusText}`);
       }
       if (reloadChat && state.currentChatId) {
           await loadChat(state.currentChatId);
       }
       return true;
   } catch (error) {
       console.error('Error editing message:', error);
       addSystemMessage(`Failed to save changes: ${error.message}`, "error");
       return false;
   }
}

function copyMessageContent(contentDiv, buttonElement) {
    // Get the full raw message content from the data attribute.
    const rawText = contentDiv.dataset.raw || '';

    // If there's no raw text, there's nothing to process or copy.
    if (!rawText.trim()) {
        addSystemMessage("Nothing to copy.", "info");
        return;
    }

    const textWithoutThink = stripCotBlocks(rawText);

    // Trim the result to remove any leading/trailing whitespace that might result after stripping CoT blocks.
    const textToCopy = textWithoutThink.trim();

    // If after removing the think block, the message is empty, inform the user.
    if (!textToCopy) {
        addSystemMessage("Nothing to copy (content was only in thought block).", "info");
        return;
    }

    // Proceed with the clipboard operation.
    navigator.clipboard.writeText(textToCopy).then(() => {
        const originalHTML = buttonElement.innerHTML;
        buttonElement.innerHTML = '<i class="bi bi-check-lg"></i>';
        buttonElement.disabled = true;
        setTimeout(() => {
            buttonElement.innerHTML = originalHTML;
            buttonElement.disabled = false;
        }, 1500);
    }).catch(err => {
        console.error('Failed to copy processed message content:', err);
        addSystemMessage('Failed to copy text.', "error");
    });
}

function setupEventListeners() {
    messageInput.addEventListener('keydown', handleInputKeydown);
    messageInput.addEventListener('input', adjustTextareaHeight);
    sendButton.addEventListener('click', sendMessage);
    stopButton.addEventListener('click', stopStreaming);
    clearChatBtn.title = 'Delete current chat';
    clearChatBtn.onclick = deleteCurrentChat;
    newChatBtn.addEventListener('click', startNewChat);
    imageButton.addEventListener('click', () => openFileSelector('image/*'));
    fileButton.addEventListener('click', () => openFileSelector('.txt,.py,.js,.ts,.html,.css,.json,.md,.yaml,.sql,.java,.c,.cpp,.cs,.go,.php,.rb,.swift,.kt,.rs,.toml'));
    
    // Character dropdown toggle
    if (characterSelectButton && characterDropdown) {
        characterSelectButton.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = characterDropdown.style.display === 'flex';
            if (isVisible) {
                hideCharacterDropdown();
            } else {
                showCharacterDropdown();
                populateCharacterDropdown().catch(err => {
                    console.error('Failed to populate character dropdown', err);
                    if (characterDropdownList) {
                        characterDropdownList.innerHTML = '<div class="character-dropdown-loading">Failed to load characters.</div>';
                    }
                });
            }
        });

        if (characterDropdownClose) {
            characterDropdownClose.addEventListener('click', (e) => {
                e.stopPropagation();
                hideCharacterDropdown();
            });
        }

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (characterDropdown && 
                characterDropdown.style.display === 'flex' &&
                !characterDropdown.contains(e.target) &&
                !characterSelectButton.contains(e.target)) {
                hideCharacterDropdown();
            }
        });

        window.addEventListener('resize', () => {
            if (characterDropdown.style.display === 'flex') {
                showCharacterDropdown();
            }
        });

        window.addEventListener('scroll', () => {
            if (characterDropdown.style.display === 'flex') {
                showCharacterDropdown();
            }
        }, true);
    }
    
    sidebarToggle.addEventListener('click', toggleSidebar);
    document.addEventListener('paste', handlePaste);

    const mobileMenuBtn = document.getElementById('mobile-menu-btn');
    const sidebarElement = document.getElementById('sidebar');
    let sidebarOverlay = document.querySelector('.sidebar-overlay');
    if (!sidebarOverlay) {
        sidebarOverlay = document.createElement('div');
        sidebarOverlay.className = 'sidebar-overlay';
        document.body.appendChild(sidebarOverlay);
    }
    if (mobileMenuBtn && sidebarElement && sidebarOverlay) {
        mobileMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // On mobile, remove sidebar-collapsed and toggle 'show' class
            sidebarElement.classList.remove('sidebar-collapsed');
            sidebarElement.classList.toggle('show');
            sidebarOverlay.classList.toggle('show');
        });
        sidebarOverlay.addEventListener('click', () => {
            sidebarElement.classList.remove('show');
            sidebarElement.classList.add('sidebar-collapsed');
            sidebarOverlay.classList.remove('show');
        });
        document.addEventListener('click', (e) => {
            if (window.innerWidth <= 768 &&
                sidebarElement.classList.contains('show') &&
                !sidebarElement.contains(e.target) &&
                !mobileMenuBtn.contains(e.target)) {
                sidebarElement.classList.remove('show');
                sidebarElement.classList.add('sidebar-collapsed');
                sidebarOverlay.classList.remove('show');
            }
        });
    }

    messagesWrapper.addEventListener('click', (event) => {
        const thinkToggle = event.target.closest('.think-block-toggle');
        if (thinkToggle) { handleThinkBlockToggle(event); return; }
        const toolToggle = event.target.closest('.tool-collapse-btn');
        if (toolToggle) { handleToolBlockToggle(event); return; }
        const copyBtn = event.target.closest('.code-header-btn.copy-btn');
        if (copyBtn) { handleCodeCopy(copyBtn); return; }
        const collapseBtn = event.target.closest('.code-header-btn.collapse-btn');
        if (collapseBtn) { handleCodeCollapse(collapseBtn); return; }
    });

    if (settingsBtn && mainSettingsPopup) {
        settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isPopupVisible = mainSettingsPopup.style.display === 'block';
            mainSettingsPopup.style.display = isPopupVisible ? 'none' : 'block';
            if (!isPopupVisible) {
                updateAutoscrollButton();
                updateCodeblockToggleButton();
                toggleToolsBtn.classList.toggle('active', state.toolsEnabled);
            }
        });
    }
    if (closeSettingsPopupBtn && mainSettingsPopup) {
        closeSettingsPopupBtn.addEventListener('click', () => {
            mainSettingsPopup.style.display = 'none';
        });
    }

    document.querySelectorAll('.theme-option[data-theme]').forEach(button => {
        button.addEventListener('click', () => {
            applyTheme(button.dataset.theme);
        });
    });

    document.addEventListener('click', (e) => {
        if (mainSettingsPopup && mainSettingsPopup.style.display === 'block') {
            if (!mainSettingsPopup.contains(e.target) && !settingsBtn.contains(e.target)) {
                mainSettingsPopup.style.display = 'none';
            }
        }
    });

    // Settings modal open/close
    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            if (settingsModal) {
                settingsModal.style.display = 'flex';
                refreshSettingsModalState();
            } else if (mainSettingsPopup) {
                // Fallback to legacy popup if new modal absent
                mainSettingsPopup.style.display = 'block';
            } else {
                console.warn('No settings modal or popup found.');
            }
        });
    }
    if (settingsModal) {
        settingsModal.addEventListener('click', (e) => {
            if (e.target === settingsModal) settingsModal.style.display = 'none';
        });
    }
    if (settingsModalClose) {
        settingsModalClose.addEventListener('click', () => {
            settingsModal.style.display = 'none';
        });
    }

    // (Tab + settings element wiring happens on modal open in refreshSettingsModalState for reliability)
}

function activateSettingsTab(tabName) {
    if (!settingsModal) return;
    const { tabButtons, tabPanels } = querySettingsModalElements();
    tabButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabName));
    tabPanels.forEach(panel => {
        const isActive = panel.dataset.panel === tabName;
        panel.classList.toggle('active', isActive);
        panel.style.display = isActive ? 'block' : 'none';
    });
    localStorage.setItem('settingsActiveTab', tabName);
}

function refreshSettingsModalState() {
    if (!settingsModal) return;
    const {
        tabButtons,
        tabPanels,
        cbTools,
        cbAutoscroll,
        cbCodeblocks,
        toolsPromptPreview,
        toolsListContainer
    } = querySettingsModalElements();

    // Wire tab button clicks (idempotent by reassigning onclick)
    tabButtons.forEach(btn => {
        btn.onclick = () => activateSettingsTab(btn.dataset.tab);
    });

    // Populate checkboxes
    if (cbTools) {
        cbTools.checked = !!state.toolsEnabled;
        cbTools.onchange = () => {
            state.toolsEnabled = cbTools.checked;
            localStorage.setItem('toolsEnabled', state.toolsEnabled);
            updateEffectiveSystemPrompt();
            updateToolsCheckboxDisableState();
            addSystemMessage(`Tool calls ${state.toolsEnabled ? 'enabled' : 'disabled'}.`, 'info');
        };
    }
    if (cbAutoscroll) {
        cbAutoscroll.checked = !!state.autoscrollEnabled;
        cbAutoscroll.onchange = () => {
            state.autoscrollEnabled = cbAutoscroll.checked;
            localStorage.setItem('autoscrollEnabled', state.autoscrollEnabled);
            updateAutoscrollButton();
            addSystemMessage(`Autoscroll ${state.autoscrollEnabled ? 'Enabled' : 'Disabled'}`, 'info', 1500);
            if (state.autoscrollEnabled) scrollToBottom('auto');
        };
    }
    if (cbCodeblocks) {
        cbCodeblocks.checked = !!state.codeBlocksDefaultCollapsed;
        cbCodeblocks.onchange = () => {
            state.codeBlocksDefaultCollapsed = cbCodeblocks.checked;
            localStorage.setItem('codeBlocksDefaultCollapsed', state.codeBlocksDefaultCollapsed);
            updateCodeblockToggleButton();
            document.querySelectorAll('.code-block-wrapper').forEach(block => setCodeBlockCollapsedState(block, state.codeBlocksDefaultCollapsed));
        };
    }

    // Tools prompt preview (read-only)
    renderToolsCheckboxList(toolsListContainer);
    updateToolsCheckboxDisableState();
    updateToolsPromptPreviewDisplay();

    // Restore last active tab (fallback to first button)
    const lastTab = localStorage.getItem('settingsActiveTab');
    const defaultTab = tabButtons[0]?.dataset.tab;
    activateSettingsTab(lastTab || defaultTab || 'main');
}

function setupToolToggle() {
    // Load persisted state first
    const savedToolState = localStorage.getItem('toolsEnabled') === 'true';
    state.toolsEnabled = savedToolState;

    if (toggleToolsBtn) {
        toggleToolsBtn.classList.toggle('active', state.toolsEnabled);
        toggleToolsBtn.addEventListener('click', () => {
            state.toolsEnabled = !state.toolsEnabled;
            toggleToolsBtn.classList.toggle('active', state.toolsEnabled);
            localStorage.setItem('toolsEnabled', state.toolsEnabled);
            console.log("Tools enabled:", state.toolsEnabled);
            updateEffectiveSystemPrompt();
            const settingsCheckbox = document.getElementById('main-toggle-tools');
            if (settingsCheckbox) settingsCheckbox.checked = state.toolsEnabled;
            updateToolsCheckboxDisableState();
            addSystemMessage(`Tool calls ${state.toolsEnabled ? 'enabled' : 'disabled'}.`, 'info');
        });
    } else {
        console.warn("Tools toggle button not found; using saved toolsEnabled state only.");
    }

    const settingsCheckbox = document.getElementById('main-toggle-tools');
    if (settingsCheckbox) settingsCheckbox.checked = state.toolsEnabled;
    updateToolsCheckboxDisableState();
    updateEffectiveSystemPrompt();
}

function handleInputKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
        e.preventDefault();
        sendMessage();
    } else if (e.key === 'Enter' && e.ctrlKey) {
         e.preventDefault();
         sendMessage();
    }
}

function adjustTextareaHeight() {
    const initialTextareaHeight = 24;
    const maxHeight = 300;
    messageInput.style.height = 'auto';
    let newScrollHeight = messageInput.scrollHeight;
    let newHeight = Math.max(initialTextareaHeight, newScrollHeight);
    newHeight = Math.min(newHeight, maxHeight);
    messageInput.style.height = `${newHeight}px`;

    const basePaddingBottom = 100;
    const extraPadding = Math.max(0, newHeight - initialTextareaHeight);

    if (chatContainer && !document.body.classList.contains('welcome-active')) {
        chatContainer.style.paddingBottom = `${basePaddingBottom + extraPadding}px`;
    } else if (chatContainer) {
        chatContainer.style.paddingBottom = '0px';
    }
}

function toggleSidebar() {
    const isCollapsed = sidebar.classList.toggle('sidebar-collapsed');
    //const icon = sidebarToggle.querySelector('i');
    const textElements = sidebar.querySelectorAll('.sidebar-title span, .new-chat-btn span, .history-item span, .history-title');
    //icon.className = `bi bi-chevron-${isCollapsed ? 'right' : 'left'}`;
    document.documentElement.style.setProperty('--sidebar-width', isCollapsed ? '0px' : '260px');
    textElements.forEach(el => {
         el.style.display = isCollapsed ? 'none' : '';
    });
    localStorage.setItem('sidebarCollapsed', isCollapsed);
}

function getActiveCharacterModel() {
    if (!state.currentCharacterId) return null;
    if (!state.charactersCache || !state.charactersCache.length) return state.lastActivatedCharacterPreferredModel;
    const char = state.charactersCache.find(c => c.character_id === state.currentCharacterId);
    let model = char?.model_name || char?.preferred_model || state.lastActivatedCharacterPreferredModel || null;
    if (model) state.lastActivatedCharacterPreferredModel = model;
    return model;
}

function getActiveCharacterCotTags() {
    if (!state.currentCharacterId || !state.charactersCache) return { start: null, end: null };
    const char = state.charactersCache.find(c => c.character_id === state.currentCharacterId);
    return {
        start: char?.cot_start_tag ? char.cot_start_tag.trim() : null,
        end: char?.cot_end_tag ? char.cot_end_tag.trim() : null
    };
}

function activeCharacterSupportsImages() {
    if (!state.currentCharacterId || !state.charactersCache) return false;
    const char = state.charactersCache.find(c => c.character_id === state.currentCharacterId);
    if (!char) return false;
    if (char.model_supports_images !== undefined) return !!char.model_supports_images;
    if (char.preferred_model_supports_images) return true; // legacy
    return false;
}

function updateAttachmentButtonsForModel() {
    const supports = activeCharacterSupportsImages();
    if (imageButton) {
        // Hide the image button entirely when model doesn't support images
        imageButton.style.display = supports ? '' : 'none';
        imageButton.title = supports ? 'Attach image' : 'Model does not support images';
    }
    if (fileButton) fileButton.disabled = false; // Always allow text file attachments
}



function openFileSelector(accept) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = accept;
    input.addEventListener('change', (e) => {
         if (e.target.files) {
             handleFiles(e.target.files);
         }
    });
    input.click();
}

function handleFiles(files) {
    const supportsImages = activeCharacterSupportsImages();

    Array.from(files).forEach(file => {
        if (file.type.startsWith('image/') && supportsImages) {
            processImageFile(file);
        } else if (file.type.startsWith('text/') || /\.(txt|py|js|ts|html|css|json|md|yaml|sql|java|c|cpp|cs|go|php|rb|swift|kt|rs|toml)$/i.test(file.name)) {
            if (file.size > 1 * 1024 * 1024) {
                 addSystemMessage(`File "${file.name}" is too large (max 1MB).`, "warning");
                 return;
            }
            processTextFile(file);
        } else {
             console.warn(`Unsupported file type: ${file.name} (${file.type})`);
             addSystemMessage(`Unsupported file type: ${file.name}`, "warning");
        }
    });
}

function processImageFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const base64 = e.target.result.split(',')[1];
        const dataUrl = e.target.result;
        const imageData = { base64, dataUrl, type: 'image', name: file.name };
        state.currentImages.push(imageData);
        addImagePreview(imageData);
    };
    reader.onerror = (err) => {
         console.error("Error reading image file:", err);
         addSystemMessage(`Error reading image file: ${file.name}`, "error");
    };
    reader.readAsDataURL(file);
}

function addImagePreview(imageData) {
    const wrapper = document.createElement('div');
    wrapper.className = 'image-preview-wrapper attached-file-preview';

    const img = document.createElement('img');
    img.src = imageData.dataUrl;
    img.alt = imageData.name;
    img.className = 'image-preview';

    const removeButton = createRemoveButton(() => {
        const index = state.currentImages.findIndex(img => img.dataUrl === imageData.dataUrl);
        if (index > -1) state.currentImages.splice(index, 1);
        wrapper.remove();
        adjustTextareaHeight();
    });

    wrapper.appendChild(img);
    wrapper.appendChild(removeButton);
    imagePreviewContainer.appendChild(wrapper);
    adjustTextareaHeight();
}

function processTextFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const content = e.target.result;
        const filename = file.name;
        const extension = filename.split('.').pop() || 'text';
        const formattedContent = `${filename}:\n\`\`\`${extension}\n${content}\n\`\`\``;
        const fileData = { name: filename, content: formattedContent, type: 'file', rawContent: content };
        state.currentTextFiles.push(fileData);
        addFilePreview(fileData);
    };
     reader.onerror = (err) => {
         console.error("Error reading text file:", err);
         addSystemMessage(`Error reading text file: ${file.name}`, "error");
    };
    reader.readAsText(file);
}

function addFilePreview(fileData) {
    const wrapper = document.createElement('div');
    wrapper.className = 'file-preview-wrapper attached-file-preview';

    const fileInfo = document.createElement('div');
    fileInfo.className = 'file-info';
    fileInfo.innerHTML = `<i class="bi bi-file-earmark-text"></i> <span>${fileData.name}</span>`;

    const removeButton = createRemoveButton(() => {
        const index = state.currentTextFiles.findIndex(f => f.name === fileData.name && f.content === fileData.content);
        if (index > -1) state.currentTextFiles.splice(index, 1);
        wrapper.remove();
        adjustTextareaHeight();
    });

    wrapper.appendChild(fileInfo);
    wrapper.appendChild(removeButton);
    imagePreviewContainer.appendChild(wrapper);
    adjustTextareaHeight();
}

function createRemoveButton(onClickCallback) {
    const removeButton = document.createElement('button');
    removeButton.className = 'remove-attachment';
    removeButton.innerHTML = '<i class="bi bi-x"></i>';
    removeButton.title = 'Remove attachment';
    removeButton.type = 'button';

    removeButton.addEventListener('click', (e) => {
        e.stopPropagation();
        onClickCallback();
    });
    return removeButton;
}

function viewAttachmentPopup(attachment) {
     const popup = document.createElement('div');
     popup.className = 'attachment-popup-overlay';
     popup.addEventListener('click', (e) => {
         if (e.target === popup) popup.remove();
     });

     const container = document.createElement('div');
     container.className = 'attachment-popup-container';

     const closeBtn = document.createElement('button');
     closeBtn.className = 'attachment-popup-close';
     closeBtn.innerHTML = '<i class="bi bi-x-lg"></i>';
     closeBtn.title = 'Close viewer';
     closeBtn.addEventListener('click', () => popup.remove());

     let contentElement;
     if (attachment.type === 'image') {
         contentElement = document.createElement('img');
         contentElement.src = `data:image/jpeg;base64,${attachment.content}`;
         contentElement.alt = attachment.name || 'Image attachment';
         contentElement.className = 'attachment-popup-image';
     } else if (attachment.type === 'file') {
         contentElement = document.createElement('pre');
         let displayContent = attachment.rawContent !== undefined ? attachment.rawContent : attachment.content;
          if (attachment.rawContent === undefined && attachment.content) {
              const match = attachment.content.match(/^.*:\n```[^\n]*\n([\s\S]*)\n```$/);
              if (match && match[1]) displayContent = match[1];
          }
          
          // Try to determine language from filename for syntax highlighting
          const filename = attachment.name || '';
          const ext = filename.split('.').pop().toLowerCase();
          const langMap = {
              'py': 'python', 'js': 'javascript', 'ts': 'typescript', 'jsx': 'javascript',
              'tsx': 'typescript', 'json': 'json', 'html': 'html', 'css': 'css', 'scss': 'scss',
              'md': 'markdown', 'yaml': 'yaml', 'yml': 'yaml', 'xml': 'xml', 'sql': 'sql',
              'sh': 'bash', 'bash': 'bash', 'zsh': 'bash', 'c': 'c', 'cpp': 'cpp', 'h': 'c',
              'hpp': 'cpp', 'java': 'java', 'kt': 'kotlin', 'rs': 'rust', 'go': 'go',
              'rb': 'ruby', 'php': 'php', 'swift': 'swift', 'r': 'r', 'lua': 'lua',
              'toml': 'toml', 'ini': 'ini', 'dockerfile': 'dockerfile', 'makefile': 'makefile'
          };
          const lang = langMap[ext] || null;
          
          const codeElement = document.createElement('code');
          codeElement.textContent = displayContent !== null ? displayContent : "Could not load file content.";
          
          // Apply syntax highlighting if we detected a language
          if (lang && typeof hljs !== 'undefined') {
              try {
                  const highlighted = hljs.highlight(displayContent || '', { language: lang, ignoreIllegals: true });
                  codeElement.innerHTML = highlighted.value;
                  codeElement.className = `hljs language-${lang}`;
              } catch (e) {
                  console.warn('Syntax highlighting failed:', e);
              }
          }
          
          contentElement.appendChild(codeElement);
          contentElement.className = 'attachment-popup-text';
     } else {
          contentElement = document.createElement('div');
          contentElement.textContent = 'Unsupported attachment type.';
     }

     container.appendChild(closeBtn);
     container.appendChild(contentElement);
     popup.appendChild(container);
     document.body.appendChild(popup);
}

function handlePaste(e) {
    if (!activeCharacterSupportsImages()) return;

    const items = e.clipboardData.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
            const blob = items[i].getAsFile();
            if (blob) {
                processImageFile(blob);
                e.preventDefault();
            }
        }
    }
}

function setupDropZone() {
    const dropZone = document.body;

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
        document.body.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => document.body.classList.add('dragover-active'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => document.body.classList.remove('dragover-active'), false);
    });

    dropZone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files && files.length > 0) {
            handleFiles(files);
        }
    });
}

function getApiKey(provider) {
    const lowerProvider = provider.toLowerCase();
    const key = state.apiKeys[lowerProvider];
    if (!key && lowerProvider !== 'local') {
        console.warn(`API Key for ${provider} is missing in state.`);
        return null;
    }
    return key;
}

async function streamFromBackend(chatId, parentMessageId, modelName, generationArgs, toolsEnabled, onChunk, onToolStart, onToolEnd, onComplete, onError, onToolPendingConfirmation) {
    console.log(`streamFromBackend called for chat: ${chatId}, parent: ${parentMessageId}, model: ${modelName}, toolsEnabled: ${toolsEnabled}`);

    if (state.streamController && !state.streamController.signal.aborted) {
        console.warn("streamFromBackend: Aborting existing stream controller before starting new stream.");
        state.streamController.abort();
    }
    state.streamController = new AbortController();

    const url = `${API_BASE}/c/${chatId}/generate`;
    const cotTags = getActiveCharacterCotTags ? getActiveCharacterCotTags() : { start: null, end: null };
    const body = {
        parent_message_id: parentMessageId,
        model_name: modelName,
        generation_args: generationArgs || {},
        tools_enabled: toolsEnabled,
        character_id: state.currentCharacterId || null,
        cot_start_tag: cotTags.start,
        cot_end_tag: cotTags.end,
        enabled_tool_names: toolsEnabled ? getEnabledToolNamesArray() : [],
        resolve_local_runtime_model: true // hint backend to fetch runtime local model name now
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream'
            },
            body: JSON.stringify(body),
            signal: state.streamController.signal
        });

        if (!response.ok) {
            let errorDetail = `Request failed with status ${response.status}`;
            try {
                const errorData = await response.json();
                errorDetail = errorData.detail || JSON.stringify(errorData);
            } catch {
                errorDetail = await response.text().catch(() => errorDetail);
            }
            throw new Error(`Backend generation request failed: ${errorDetail}`);
        }

        if (!response.body) {
            throw new Error("Response body is missing.");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let streamEndedSuccessfully = false;

        while (true) {
            if (state.streamController.signal.aborted) {
                console.log("Frontend stream reading aborted by AbortController.");
                throw new Error("Aborted by user");
            }

            const { done, value } = await reader.read();
            if (done) {
                console.log("Backend stream finished reading.");
                if (!streamEndedSuccessfully) {
                    console.warn("Stream ended without explicit 'done' event from backend.");
                }
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            let newlineIndex;

            while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
                const line = buffer.substring(0, newlineIndex).trim();
                buffer = buffer.substring(newlineIndex + 1);

                if (line.startsWith('data:')) {
                    const dataStr = line.substring(5).trim();
                    if (dataStr) {
                        try {
                            const eventData = JSON.parse(dataStr);
                            switch (eventData.type) {
                                case 'chunk':
                                    if (typeof onChunk !== 'function') throw new Error("Internal error: Invalid onChunk callback.");
                                    if (eventData.data) onChunk(eventData.data);
                                    break;
                                case 'tool_start':
                                    if (typeof onToolStart !== 'function') throw new Error("Internal error: Invalid onToolStart callback.");
                                    onToolStart(eventData.name, eventData.args);
                                    break;
                                case 'tool_end':
                                     if (typeof onToolEnd !== 'function') throw new Error("Internal error: Invalid onToolEnd callback.");
                                    onToolEnd(eventData.name, eventData.result, eventData.error);
                                    break;
                                case 'error':
                                    console.error("Backend generation error:", eventData.message);
                                    streamEndedSuccessfully = false;
                                    throw new Error(eventData.message || "Unknown backend generation error");
                                case 'done':
                                    console.log("Received 'done' event from backend.");
                                    streamEndedSuccessfully = true;
                                    break;
                                default:
                                    console.warn("Received unknown event type from backend:", eventData.type);
                            }
                        } catch (e) {
                            console.error("Failed to parse SSE data chunk:", dataStr, e);
                            streamEndedSuccessfully = false;
                            throw new Error(`Failed to parse backend event: ${e.message}`);
                        }
                    }
                }
            }
        }

        if (streamEndedSuccessfully) {
             if (typeof onComplete !== 'function') throw new Error("Internal error: Invalid onComplete callback.");
            onComplete();
        } else {
            if (typeof onError !== 'function') throw new Error("Internal error: Invalid onError callback.");
             onError(new Error("Stream processing finished unexpectedly."), false);
        }

    } catch (error) {
        const isAbort = error.name === 'AbortError' || error.message === "Aborted by user";
        console.error(`Backend Streaming Error (${isAbort ? 'Abort' : 'Error'}):`, error);
         if (typeof onError === 'function') {
             onError(error, isAbort);
         } else {
             console.error("CRITICAL: onError callback is invalid during error handling!");
         }
    }
}

async function generateAssistantResponse(parentId, targetContentDiv, modelName, generationArgs, toolsEnabled, isEditing = false, initialText = '') {
    console.log(`[generateAssistantResponse] parentId: ${parentId}, toolsEnabled: ${toolsEnabled}`);

    if (!state.currentChatId) { console.error("generateAssistantResponse: No current chat ID."); cleanupAfterGeneration(); return; }
    if (!targetContentDiv) { console.error("generateAssistantResponse: No target content div provided."); cleanupAfterGeneration(); return; }
    if (targetContentDiv.classList.contains('streaming')) {
         console.warn("generateAssistantResponse: Generation already in progress for this element.");
         return;
    }

    // Resolve effective model name (explicit param overrides active character embedded value)
    let effectiveModelName = modelName || getActiveCharacterModel();
    if (!effectiveModelName) {
        addSystemMessage('No model set for active character (model_name empty). Edit the character to set one.', 'error');
        cleanupAfterGeneration();
        return;
    }

    // Reset timer state at the beginning of a new generation
    if (state.streamingThinkTimer.intervalId) {
        clearInterval(state.streamingThinkTimer.intervalId);
    }
    state.streamingThinkTimer = { intervalId: null, startTime: null };


    setGenerationInProgressUI(true);
    state.currentAssistantMessageDiv = targetContentDiv;
    targetContentDiv.classList.add('streaming');
    const messageDivForStream = targetContentDiv.closest('.message');
    if (messageDivForStream) {
        messageDivForStream.style.minHeight = '';
    }

    buildContentHtml(targetContentDiv, initialText);
    updateAttachmentButtonsForModel();
    targetContentDiv.querySelector('.generation-stopped-indicator')?.remove();
    targetContentDiv.insertAdjacentHTML('beforeend', '<span class="pulsing-cursor">█</span>');

    let fullRenderedContent = initialText;
    let lastRenderTime = 0;
    let pendingRenderTimeout = null;
    const RENDER_THROTTLE_MS = 50; // Only re-render every 50ms max

    const updateStreamingMinHeight = () => {
        if (targetContentDiv) {
            const messageDiv = targetContentDiv.closest('.message');
            if (messageDiv) {
                if (targetContentDiv.closest('.message-row') === messagesWrapper.lastElementChild) {
                    messageDiv.style.minHeight = 'calc(-384px + 100dvh)';
                } else {
                    messageDiv.style.minHeight = '';
                }
            }
        }
    };
    updateStreamingMinHeight();
    requestAnimationFrame(() => {
        if (chatContainer) {
            chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: 'smooth' });
        }
        updateScrollButtonVisibility();
    });

    try {
        await streamFromBackend(
            state.currentChatId,
            parentId,
            effectiveModelName,
            generationArgs,
            toolsEnabled,
            // onChunk - throttled to reduce DOM thrashing
            (textChunk) => {
                if (!targetContentDiv || state.streamController?.signal.aborted || state.currentAssistantMessageDiv !== targetContentDiv) {
                    return;
                }
                fullRenderedContent += textChunk;
                
                const now = Date.now();
                const timeSinceLastRender = now - lastRenderTime;
                
                // Clear any pending render since we have new content
                if (pendingRenderTimeout) {
                    clearTimeout(pendingRenderTimeout);
                    pendingRenderTimeout = null;
                }
                
                const doRender = () => {
                    if (!targetContentDiv || state.streamController?.signal.aborted) return;
                    
                    const cotTagPairs = getCotTagPairs();
                    const hasThinkStart = startsWithCotBlock(fullRenderedContent, cotTagPairs);
                    const hasThinkEnd = cotTagPairs.some(({ end }) => end && fullRenderedContent.includes(end));

                    // Timer logic for think blocks
                    if (hasThinkStart && !hasThinkEnd && state.streamingThinkTimer.intervalId === null) {
                        state.streamingThinkTimer.startTime = Date.now();
                        state.streamingThinkTimer.intervalId = setInterval(() => {
                            if (state.streamingThinkTimer.intervalId && state.currentAssistantMessageDiv) {
                                const timerEl = state.currentAssistantMessageDiv.querySelector('.think-timer');
                                if (timerEl) {
                                    const elapsed = ((Date.now() - state.streamingThinkTimer.startTime) / 1000).toFixed(1);
                                    timerEl.textContent = `${elapsed}s`;
                                }
                            } else if (state.streamingThinkTimer.intervalId) {
                                clearInterval(state.streamingThinkTimer.intervalId);
                            }
                        }, 100);
                    } else if (hasThinkStart && hasThinkEnd && state.streamingThinkTimer.intervalId !== null) {
                        clearInterval(state.streamingThinkTimer.intervalId);
                        if (state.currentAssistantMessageDiv) {
                            const timerEl = state.currentAssistantMessageDiv.querySelector('.think-timer');
                            if (timerEl && state.streamingThinkTimer.startTime) {
                                const elapsed = ((Date.now() - state.streamingThinkTimer.startTime) / 1000).toFixed(1);
                                timerEl.textContent = `${elapsed}s`;
                            }
                        }
                        state.streamingThinkTimer = { intervalId: null, startTime: null };
                    }

                    const thinkBlockTempId = 'streaming-think-block';
                    const remainingContentTempId = 'streaming-remaining-content';
                    let existingThinkBlockInTarget = targetContentDiv.querySelector(`.think-block[data-temp-id="${thinkBlockTempId}"]`);

                    if (hasThinkStart) {
                        const { thinkContent, remainingText } = parseThinkContent(fullRenderedContent, cotTagPairs);
                        if (existingThinkBlockInTarget) {
                            const thinkContentDiv = existingThinkBlockInTarget.querySelector('.think-content');
                            if (thinkContentDiv) {
                                thinkContentDiv.innerHTML = marked.parse(thinkContent || '');
                                thinkContentDiv.querySelectorAll('pre').forEach(pre => enhanceCodeBlock(pre));
                                applyCodeBlockDefaults(thinkContentDiv);
                                finalizeStreamingCodeBlocks(thinkContentDiv);
                            }
                            let existingRemainingDiv = targetContentDiv.querySelector(`div[data-temp-id="${remainingContentTempId}"]`);
                            if (remainingText) {
                                const remainingHtml = renderMarkdown(remainingText, true, null);
                                if (existingRemainingDiv) {
                                    existingRemainingDiv.innerHTML = remainingHtml;
                                } else {
                                    existingRemainingDiv = document.createElement('div');
                                    existingRemainingDiv.dataset.tempId = remainingContentTempId;
                                    existingRemainingDiv.innerHTML = remainingHtml;
                                    existingThinkBlockInTarget.insertAdjacentElement('afterend', existingRemainingDiv);
                                }
                                finalizeStreamingCodeBlocks(existingRemainingDiv);
                            } else if (existingRemainingDiv) {
                                existingRemainingDiv.remove();
                            }
                        } else {
                            buildContentHtml(targetContentDiv, fullRenderedContent);
                            finalizeStreamingCodeBlocks(targetContentDiv);
                        }
                    } else {
                        buildContentHtml(targetContentDiv, fullRenderedContent);
                        finalizeStreamingCodeBlocks(targetContentDiv);
                    }
                    
                    targetContentDiv.querySelector('.pulsing-cursor')?.remove();
                    if (!state.streamController?.signal.aborted) {
                        targetContentDiv.insertAdjacentHTML('beforeend', '<span class="pulsing-cursor">█</span>');
                    }
                    updateStreamingMinHeight();
                    if (state.autoscrollEnabled) requestAutoScroll();
                    
                    lastRenderTime = Date.now();
                };
                
                // Throttle: only render if enough time has passed, otherwise schedule
                if (timeSinceLastRender >= RENDER_THROTTLE_MS) {
                    doRender();
                } else {
                    // Schedule a render for when throttle period ends
                    pendingRenderTimeout = setTimeout(doRender, RENDER_THROTTLE_MS - timeSinceLastRender);
                }
            },
            // onToolStart
            (name, args) => {
                if (pendingRenderTimeout) { clearTimeout(pendingRenderTimeout); pendingRenderTimeout = null; }
                if (!targetContentDiv || state.streamController?.signal.aborted || state.currentAssistantMessageDiv !== targetContentDiv) return;
                buildContentHtml(targetContentDiv, fullRenderedContent);
                targetContentDiv.querySelector('.pulsing-cursor')?.remove();
                if (!state.streamController?.signal.aborted) {
                    targetContentDiv.insertAdjacentHTML('beforeend', '<span class="pulsing-cursor">█</span>');
                }
                finalizeStreamingCodeBlocks(targetContentDiv);
                updateStreamingMinHeight();
                if (state.autoscrollEnabled) requestAutoScroll();
            },
            // onToolEnd
            (name, result, error) => {
                if (pendingRenderTimeout) { clearTimeout(pendingRenderTimeout); pendingRenderTimeout = null; }
                if (!targetContentDiv || state.streamController?.signal.aborted || state.currentAssistantMessageDiv !== targetContentDiv) return;
                buildContentHtml(targetContentDiv, fullRenderedContent);
                targetContentDiv.querySelector('.pulsing-cursor')?.remove();
                if (!state.streamController?.signal.aborted) {
                    targetContentDiv.insertAdjacentHTML('beforeend', '<span class="pulsing-cursor">█</span>');
                }
                 finalizeStreamingCodeBlocks(targetContentDiv);
                 updateStreamingMinHeight();
                if (state.autoscrollEnabled) requestAutoScroll();
            },
            // onComplete
            async () => {
                if (pendingRenderTimeout) { clearTimeout(pendingRenderTimeout); pendingRenderTimeout = null; }
                if (state.currentAssistantMessageDiv !== targetContentDiv) {
                     console.warn("onComplete: Target div no longer active. Skipping.");
                     if (stopButton.style.display !== 'none' || sendButton.disabled) {
                          setGenerationInProgressUI(false);
                     }
                     return;
                }
                if (targetContentDiv) {
                    targetContentDiv.classList.remove('streaming');
                    targetContentDiv.querySelector('.pulsing-cursor')?.remove();
                    buildContentHtml(targetContentDiv, fullRenderedContent); 
                    finalizeStreamingCodeBlocks(targetContentDiv);
                }

                if (state.autoscrollEnabled) requestAutoScroll();
                else requestAnimationFrame(updateScrollButtonVisibility);

                // Capture collapse states from current DOM before loadChat replaces it
                const streamingRow = targetContentDiv?.closest('.message-row');
                const capturedStates = streamingRow ? captureCollapseStates(targetContentDiv) : null;

                try {
                    console.log("Reloading chat state after successful backend generation.");
                    if (state.currentChatId && streamingRow) {
                        await loadChat(state.currentChatId);
                        
                        // Apply captured states to the last assistant message (which now has real ID)
                        if (capturedStates) {
                            const lastAssistantRow = messagesWrapper.querySelector('.assistant-row:last-of-type');
                            if (lastAssistantRow) {
                                const realMessageId = lastAssistantRow.dataset.messageId;
                                if (realMessageId && !realMessageId.startsWith('temp_')) {
                                    state.userCollapseStates.set(realMessageId, capturedStates);
                                    applyPersistedCollapseStates(lastAssistantRow);
                                }
                            }
                        }
                    } else {
                         // ... (fallback logic if chat context changed)
                    }
                } catch (loadError) {
                     // ... (error handling for loadChat)
                } finally {
                    if (state.currentAssistantMessageDiv === targetContentDiv) {
                         setGenerationInProgressUI(false);
                         state.currentAssistantMessageDiv = null;
                    }
                }
            },
            // onError
            async (error, isAbort) => {
                if (pendingRenderTimeout) { clearTimeout(pendingRenderTimeout); pendingRenderTimeout = null; }
                const rowBeingStreamedTo = targetContentDiv ? targetContentDiv.closest('.message-row') : null;
                const isPlaceholderRow = rowBeingStreamedTo ? rowBeingStreamedTo.classList.contains('placeholder') : false;

                if (targetContentDiv) {
                    targetContentDiv.classList.remove('streaming');
                    targetContentDiv.querySelector('.pulsing-cursor')?.remove();
                    targetContentDiv.querySelector('.generation-stopped-indicator')?.remove();
                } else if (state.currentAssistantMessageDiv) {
                    state.currentAssistantMessageDiv.classList.remove('streaming');
                    state.currentAssistantMessageDiv.querySelector('.pulsing-cursor')?.remove();
                    state.currentAssistantMessageDiv.querySelector('.generation-stopped-indicator')?.remove();
                }

                setGenerationInProgressUI(false);
                state.currentAssistantMessageDiv = null;

                if (isAbort) {
                    addSystemMessage("Generation stopped by user.", "info", 2000);

                    if (state.currentChatId) {
                        try {
                            await new Promise(resolve => setTimeout(resolve, 750));
                            await loadChat(state.currentChatId);
                            if (state.autoscrollEnabled) scrollToBottom('smooth');
                            else requestAnimationFrame(updateScrollButtonVisibility);
                        } catch (loadError) {
                            console.error("Error reloading chat after abort:", loadError);
                            addSystemMessage("Error refreshing chat after stop.", "error");
                            if (rowBeingStreamedTo && isPlaceholderRow) {
                                rowBeingStreamedTo.remove();
                            }
                        }
                    } else if (rowBeingStreamedTo && isPlaceholderRow) {
                        rowBeingStreamedTo.remove();
                    }
                } else {
                    addSystemMessage(`Generation Error: ${error.message}`, "error");
                    // Remove the placeholder row first
                    if (rowBeingStreamedTo && isPlaceholderRow) {
                        rowBeingStreamedTo.remove();
                    }
                    // Reload chat to restore previous state (important for regenerate/branch errors)
                    if (state.currentChatId) {
                        try {
                            console.log("Reloading chat to restore state after generation error.");
                            await loadChat(state.currentChatId);
                            if (state.autoscrollEnabled) scrollToBottom('smooth');
                            else requestAnimationFrame(updateScrollButtonVisibility);
                        } catch (loadError) {
                            console.error("Error reloading chat after generation error:", loadError);
                            addSystemMessage("Error refreshing chat after generation failure.", "error");
                        }
                    }
                }
                
                const lastMessageRowElement = messagesWrapper.lastElementChild;
                if (lastMessageRowElement && lastMessageRowElement.classList.contains('assistant-row') && !lastMessageRowElement.classList.contains('placeholder')) {
                    const lastAssistantMessageDivElement = lastMessageRowElement.querySelector('.message');
                    if (lastAssistantMessageDivElement && !lastAssistantMessageDivElement.querySelector('.pulsing-cursor')) {
                        lastAssistantMessageDivElement.style.minHeight = 'calc(-384px + 100dvh)';
                    }
                }
                requestAnimationFrame(updateScrollButtonVisibility);
            },
            // onToolPendingConfirmation
            (name, args, callId) => {
                if (!targetContentDiv || state.streamController?.signal.aborted || state.currentAssistantMessageDiv !== targetContentDiv) return;
                console.log(`Tool pending confirmation: ${name}`, args);
                
                // Render accumulated content first
                buildContentHtml(targetContentDiv, fullRenderedContent);
                targetContentDiv.querySelector('.pulsing-cursor')?.remove();
                
                // Find the tool call block that was just rendered and ensure it shows confirmation UI
                const toolBlocks = targetContentDiv.querySelectorAll('.tool-call-block');
                const lastToolBlock = toolBlocks[toolBlocks.length - 1];
                if (lastToolBlock && lastToolBlock.dataset.toolName === name) {
                    // The block should already have the confirmation UI from renderToolCallPlaceholder
                    // Just make sure it's not collapsed
                    lastToolBlock.classList.remove('collapsed');
                    const collapseIcon = lastToolBlock.querySelector('.tool-collapse-btn i');
                    if (collapseIcon) collapseIcon.className = 'bi bi-chevron-up';
                }
                
                finalizeStreamingCodeBlocks(targetContentDiv);
                updateStreamingMinHeight();
                if (state.autoscrollEnabled) requestAutoScroll();
            }
        );
    } catch (error) { // Catch errors from streamFromBackend setup itself (e.g. network error before stream starts)
        console.error("Error setting up generation stream (SYNC):", error);
        addSystemMessage(`Setup Error: ${error.message}`, "error");
        if (targetContentDiv) {
            targetContentDiv.classList.remove('streaming');
            targetContentDiv.querySelector('.pulsing-cursor')?.remove();
            const messageDivOfTarget = targetContentDiv.closest('.message');
            if (messageDivOfTarget) messageDivOfTarget.style.minHeight = '';
            const placeholderRow = targetContentDiv.closest('.message-row.placeholder');
            if (placeholderRow) placeholderRow.remove();
        }
        cleanupAfterGeneration(); // This calls setGenerationInProgressUI(false)
        requestAnimationFrame(updateScrollButtonVisibility);
        const lastMessageRowAfterError = messagesWrapper.lastElementChild;
        if (lastMessageRowAfterError && lastMessageRowAfterError.classList.contains('assistant-row') && !lastMessageRowAfterError.classList.contains('placeholder')) {
            const lastAssistantMessageDiv = lastMessageRowAfterError.querySelector('.message');
            if (lastAssistantMessageDiv) {
                lastAssistantMessageDiv.style.minHeight = 'calc(-384px + 100dvh)';
            }
        }
    } finally {
         // Final min-height adjustment if the streamed message wasn't the last one
         if (targetContentDiv) {
             const messageDiv = targetContentDiv.closest('.message');
             // Check if it's still the current assistant message div to avoid conflicts
             if (messageDiv && state.currentAssistantMessageDiv !== targetContentDiv && targetContentDiv.closest('.message-row') !== messagesWrapper.lastElementChild) {
                 messageDiv.style.minHeight = '';
             }
         }
    }
}

function finalizeStreamingCodeBlocks(containerElement) {
    if (!containerElement) return;
    containerElement.querySelectorAll('.code-block-wrapper code').forEach(codeElement => {
         try {
             hljs.highlightElement(codeElement);
         } catch (e) {
             console.error(`Error during final highlight pass:`, e, codeElement.textContent.substring(0, 50));
         }
    });
    containerElement.querySelectorAll('.streaming').forEach(el => {
        el.classList.remove('streaming');
    });
}

function setGenerationInProgressUI(inProgress) {
    if (inProgress) {
        stopButton.style.display = 'flex';
        sendButton.disabled = true;
        sendButton.innerHTML = '<div class="spinner"></div>';
    } else {
        // Stop and clear any active think timer
        if (state.streamingThinkTimer.intervalId) {
            clearInterval(state.streamingThinkTimer.intervalId);
            if (state.currentAssistantMessageDiv) {
                const timerEl = state.currentAssistantMessageDiv.querySelector('.think-timer');
                if (timerEl && state.streamingThinkTimer.startTime) {
                    const elapsed = ((Date.now() - state.streamingThinkTimer.startTime) / 1000).toFixed(1);
                    timerEl.textContent = `${elapsed}s`;
                }
            }
            state.streamingThinkTimer = { intervalId: null, startTime: null };
        }

        stopButton.style.display = 'none';
        sendButton.disabled = false;
        sendButton.innerHTML = '<i class="bi bi-arrow-up"></i>';
        requestAnimationFrame(updateScrollButtonVisibility);

        if (state.streamController) {
            if (!state.streamController.signal.aborted) {
                 state.streamController.abort();
            }
            state.streamController = null;
        }
        state.toolCallPending = false;
        state.toolContinuationContext = null;
        state.currentToolCallId = null;
        state.abortingForToolCall = false;
    }
}

function clearInputArea() {
    messageInput.value = '';
    state.currentImages = [];
    state.currentTextFiles = [];
    imagePreviewContainer.innerHTML = '';
    adjustTextareaHeight();
}

function prepareChatUIForResponse() {
    if (document.body.classList.contains('welcome-active')) {
        document.body.classList.remove('welcome-active');
        welcomeContainer.style.display = 'none';
        adjustTextareaHeight();
    }
}

function checkAndShowWelcome() {
    const hasVisibleMessages = state.messages.some(m => m.role !== 'system');
    if (!hasVisibleMessages) {
        welcomeContainer.style.display = 'flex';
        document.body.classList.add('welcome-active');
        if (chatContainer) chatContainer.style.paddingBottom = '0px';
    }
}

async function sendMessage() {
    const messageText = messageInput.value.trim();
    const attachments = [
        ...state.currentImages.map(img => ({ type: 'image', content: img.base64, name: img.name })),
        ...state.currentTextFiles.map(file => ({ type: 'file', content: file.content, name: file.name }))
    ];

    if (!messageText && attachments.length === 0) return;
    if (document.getElementById('send-button').disabled) {
        addSystemMessage("Please wait for the current response to finish.", "warning");
        return;
    }

    const modelName = getActiveCharacterModel();
    if (!modelName) {
        try { await fetchCharacters(true); } catch(e) { /* ignore */ }
        const retryModel = getActiveCharacterModel();
        if (!retryModel) {
            addSystemMessage('Active character has no preferred model (assign one in the Characters tab).', 'error');
            return;
        }
    }

    const currentInputText = messageInput.value;
    clearInputArea();
    prepareChatUIForResponse();

    let currentChatId = state.currentChatId;
    let savedUserMessageId = null;
    let assistantPlaceholderRow = null;
    let assistantContentDiv = null;

    sendButton.disabled = true;
    sendButton.innerHTML = '<div class="spinner"></div>';

    try {
        const isNewChat = !currentChatId;
        if (isNewChat) {
            currentChatId = await createNewChatBackend();
            if (!currentChatId) throw new Error("Failed to create a new chat session.");
            state.currentChatId = currentChatId;
            localStorage.setItem('lastChatId', currentChatId);
            updateUrlForChat(currentChatId); // Update URL for new chat
        }

        const parentId = findLastActiveMessageId(state.messages);
        const userMessageData = {
            role: 'user',
            message: messageText || " ",
            attachments: attachments,
            parent_message_id: parentId
        };
        savedUserMessageId = await saveMessageToBackend(currentChatId, userMessageData);
        if (!savedUserMessageId) throw new Error("Failed to save user message.");
        console.log(`User message saved with ID: ${savedUserMessageId}`);

        if (isNewChat) {
            await fetchChats();
            highlightCurrentChatInSidebar();
        }

        await loadChat(currentChatId);

        assistantPlaceholderRow = createPlaceholderMessageRow(`temp_assistant_${Date.now()}`, savedUserMessageId);
        messagesWrapper.appendChild(assistantPlaceholderRow);
        assistantContentDiv = assistantPlaceholderRow.querySelector('.message-content');

        if (!assistantContentDiv) {
             throw new Error("Failed to create assistant response placeholder element.");
        }

        // The initial scroll to the placeholder will be handled by generateAssistantResponse
        // No explicit scroll here is needed. updateScrollButtonVisibility will be called
        // by generateAssistantResponse's initial scroll logic.

        await generateAssistantResponse(
            savedUserMessageId,
            assistantContentDiv,
            modelName,
            defaultGenArgs,
            state.toolsEnabled
        );

    } catch (error) {
        console.error('Error sending message or preparing generation:', error);
        addSystemMessage(`Error: ${error.message}`, "error");
        if (!messageInput.value) messageInput.value = currentInputText;
        assistantPlaceholderRow?.remove();
        cleanupAfterGeneration();
        checkAndShowWelcome();
        adjustTextareaHeight();
        requestAnimationFrame(updateScrollButtonVisibility);
    }
}

async function createNewChatBackend() {
    try {
        const response = await fetch(`${API_BASE}/c/new_chat`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ character_id: state.currentCharacterId })
        });
        if (!response.ok) throw new Error(`Failed to create chat: ${await response.text()}`);
        const { chat_id } = await response.json();
        return chat_id;
    } catch (error) {
        console.error("Error creating new chat backend:", error);
        addSystemMessage(`Error creating chat: ${error.message}`, "error");
        return null;
    }
}

async function saveMessageToBackend(chatId, messageData) {
    try {
        const url = `${API_BASE}/c/${chatId}/add_message`;
        const response = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(messageData)
        });
        if (!response.ok) {
             const errorData = await response.json().catch(() => ({ detail: response.statusText }));
             throw new Error(`Failed to save message (${messageData.role}): ${errorData.detail || response.statusText}`);
        }
        const { message_id } = await response.json();
        return message_id;
    } catch (error) {
        console.error("Error saving message to backend:", error);
        addSystemMessage(`Error saving message: ${error.message}`, "error");
        return null;
    }
}

function findLastActiveMessageId(messages) {
     if (!messages || messages.length === 0) return null;
     const messageMap = new Map(messages.map(msg => [msg.message_id, { ...msg, children: [] }]));
     const rootMessages = [];
     messages.forEach(msg => {
         if (msg.role === 'system') return;
         const msgNode = messageMap.get(msg.message_id);
         if (!msgNode) return;
         if (msg.parent_message_id && messageMap.has(msg.parent_message_id)) {
             const parent = messageMap.get(msg.parent_message_id);
             if (!parent.children) parent.children = [];
             parent.children.push(msgNode);
         } else if (!msg.parent_message_id) { rootMessages.push(msgNode); }
     });
     messageMap.forEach(node => {
         if (node.children) node.children.sort((a, b) => a.timestamp - b.timestamp);
     });
     rootMessages.sort((a, b) => a.timestamp - b.timestamp);

     let lastActiveId = null;
     function findLast(node) {
        if (!node) return null;
        let currentLastId = node.message_id;
        const children = node.children;
        if (children && children.length > 0) {
            const activeIndex = node.active_child_index ?? 0;
            const safeActiveIndex = Math.min(Math.max(0, activeIndex), children.length - 1);
            const activeChild = children[safeActiveIndex];
            if (activeChild) {
                const childLastId = findLast(activeChild);
                if (childLastId) currentLastId = childLastId;
            }
        }
        return currentLastId;
     }
     let latestTimestamp = 0;
     for (const rootNode of rootMessages) {
         const currentBranchLastId = findLast(rootNode);
         const lastNodeInBranch = messageMap.get(currentBranchLastId);
         if (lastNodeInBranch && lastNodeInBranch.timestamp > latestTimestamp) {
             latestTimestamp = lastNodeInBranch.timestamp;
             lastActiveId = currentBranchLastId;
         }
     }
     return lastActiveId;
}

function cleanupAfterGeneration() {
    setGenerationInProgressUI(false);

    if (state.currentAssistantMessageDiv) {
        state.currentAssistantMessageDiv.classList.remove('streaming');
        state.currentAssistantMessageDiv.querySelector('.pulsing-cursor')?.remove();
        state.currentAssistantMessageDiv.querySelector('.generation-stopped-indicator')?.remove();
        const messageDiv = state.currentAssistantMessageDiv.closest('.message');
        if (messageDiv) messageDiv.style.minHeight = '';
        state.currentAssistantMessageDiv = null;
    }

    state.toolCallPending = false;
    state.toolContinuationContext = null;
    state.currentToolCallId = null;
    state.abortingForToolCall = false;
}

function renderToolCallPlaceholder(messageContentDiv, toolData, options = {}) {
    if (!messageContentDiv) return;

    const toolName = toolData?.name || 'tool';
    const callId = toolData?.id || toolData?.payloadInfo?.inferredId || null;
    const payloadInfo = toolData?.payloadInfo || { arguments: {}, raw: '', error: null };
    const args = payloadInfo.arguments || {};
    const rawPayload = payloadInfo.raw || '';
    const parseError = payloadInfo.error;
    
    const toolCallBlock = document.createElement('div');
    toolCallBlock.className = 'tool-call-block collapsed';
    toolCallBlock.dataset.toolName = toolName;
    if (callId) toolCallBlock.dataset.callId = callId;

    // Get appropriate icon for the tool
    const getToolIcon = (name) => {
        const iconMap = {
            'add': 'calculator',
            'search': 'search',
            'scrape': 'globe',
            'python_interpreter': 'terminal-fill'
        };
        return iconMap[name] || 'tools';
    };

    const toolHeader = document.createElement('div');
    toolHeader.className = 'tool-header';

    const toolNameSpan = document.createElement('span');
    toolNameSpan.className = 'tool-header-name';
    const toolIcon = getToolIcon(toolName);
    
    // Display format: icon + "Using tool_name"
    const actionVerb = options.executed ? 'Ran' : 'Using';
    toolNameSpan.innerHTML = `<i class="bi bi-${toolIcon}"></i> <span class="tool-action-verb">${actionVerb}</span> <span class="tool-name-text">${escapeHtml(toolName)}</span>`;

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'tool-header-actions';
    
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'tool-collapse-btn';
    collapseBtn.innerHTML = '<i class="bi bi-chevron-down"></i>';
    collapseBtn.title = 'Expand tool call details';
    actionsDiv.appendChild(collapseBtn);

    toolHeader.appendChild(toolNameSpan);
    toolHeader.appendChild(actionsDiv);
    toolCallBlock.appendChild(toolHeader);

    const toolArgsDiv = document.createElement('div');
    toolArgsDiv.className = 'tool-arguments';
    
    try {
        const hasArgs = args && Object.keys(args).length > 0;
        const displayObject = hasArgs ? args : (!parseError && rawPayload ? JSON.parse(rawPayload) : {});
        
        // For python_interpreter, show code in a nice code block
        if (toolName === 'python_interpreter' && displayObject.code) {
            const codeContent = displayObject.code;
            const wrapper = createCodeBlockWithContent(codeContent, 'python');
            toolArgsDiv.appendChild(wrapper);
        } else {
            const argsString = JSON.stringify(displayObject, null, 2);
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            code.className = 'language-json';
            code.textContent = argsString;
            try { hljs.highlightElement(code); }
            catch (e) { console.warn('Error highlighting tool args:', e); }
            pre.appendChild(code);
            toolArgsDiv.appendChild(pre);
        }
    } catch (err) {
        toolArgsDiv.textContent = '[Invalid Arguments]';
    }

    if (parseError) {
        const errorBanner = document.createElement('div');
        errorBanner.className = 'tool-parse-error';
        errorBanner.innerHTML = `<i class="bi bi-exclamation-triangle-fill"></i> ${escapeHtml(parseError)}`;
        toolCallBlock.appendChild(errorBanner);
    }
    toolCallBlock.appendChild(toolArgsDiv);
    messageContentDiv.appendChild(toolCallBlock);
    
    return toolCallBlock;
}

function renderToolResult(messageContentDiv, resultData) {
    if (!messageContentDiv) return;

    const toolName = resultData?.name || null;
    const status = resultData?.status || null;
    const resultText = typeof resultData?.body === 'string' ? resultData.body : (typeof resultData === 'string' ? resultData : '');

    const toolResultBlock = document.createElement('div');
    toolResultBlock.className = 'tool-result-block collapsed';

    const toolHeader = document.createElement('div');
    toolHeader.className = 'tool-header';

    const toolNameSpan = document.createElement('span');
    toolNameSpan.className = 'tool-header-name';
    const lowerText = (resultText || '').toLowerCase();
    
    // Detect error or success status
    const isError = lowerText.startsWith('[error:') || lowerText.startsWith('error:') || status === 'error';
    
    // Get tool-specific icon
    const getToolIcon = (name) => {
        const iconMap = {
            'add': 'calculator',
            'search': 'search',
            'scrape': 'globe',
            'python_interpreter': 'terminal-fill'
        };
        return iconMap[name] || 'tools';
    };
    
    const toolIcon = toolName ? getToolIcon(toolName) : (isError ? 'exclamation-circle-fill' : 'check-circle-fill');
    const statusClass = isError ? 'error' : 'success';
    const statusLabel = isError ? 'Error' : 'Output';
    toolResultBlock.classList.add(statusClass);
    
    toolNameSpan.innerHTML = `<i class="bi bi-${toolIcon}"></i> <span class="tool-result-status ${statusClass}">${statusLabel}</span>${toolName ? ` <span class="tool-name-text">${escapeHtml(toolName)}</span>` : ''}`;

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'tool-header-actions';
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'tool-collapse-btn';
    collapseBtn.innerHTML = '<i class="bi bi-chevron-down"></i>';
    collapseBtn.title = 'Expand tool result';
    actionsDiv.appendChild(collapseBtn);

    toolHeader.appendChild(toolNameSpan);
    toolHeader.appendChild(actionsDiv);
    toolResultBlock.appendChild(toolHeader);

    const toolResultContent = document.createElement('div');
    toolResultContent.className = 'tool-result-content';
    
    // Check for images in the result (format: [IMAGE:base64:...])
    const imageRegex = /\[IMAGE:base64:([A-Za-z0-9+/=]+)\]/g;
    const hasImages = imageRegex.test(resultText);
    imageRegex.lastIndex = 0; // Reset regex
    
    if (hasImages) {
        // Split text by images and render each part
        let lastIndex = 0;
        let match;
        
        while ((match = imageRegex.exec(resultText)) !== null) {
            // Add text before the image
            const textBefore = resultText.substring(lastIndex, match.index).trim();
            if (textBefore) {
                const pre = document.createElement('pre');
                const code = document.createElement('code');
                code.textContent = textBefore;
                pre.appendChild(code);
                toolResultContent.appendChild(pre);
            }
            
            // Add the image
            const imgContainer = document.createElement('div');
            imgContainer.className = 'tool-result-image';
            const img = document.createElement('img');
            img.src = `data:image/png;base64,${match[1]}`;
            img.alt = 'Python output image';
            img.style.maxWidth = '100%';
            img.style.borderRadius = '4px';
            img.style.marginTop = '8px';
            imgContainer.appendChild(img);
            toolResultContent.appendChild(imgContainer);
            
            lastIndex = imageRegex.lastIndex;
        }
        
        // Add any remaining text after the last image
        const textAfter = resultText.substring(lastIndex).trim();
        if (textAfter) {
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            code.textContent = textAfter;
            pre.appendChild(code);
            toolResultContent.appendChild(pre);
        }
    } else if (toolName === 'python_interpreter' || resultText.includes('\n')) {
        // For code output, wrap in a pre/code block
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = resultText || '[Empty Result]';
        pre.appendChild(code);
        toolResultContent.appendChild(pre);
    } else {
        toolResultContent.innerHTML = renderMarkdown(resultText || '[Empty Result]');
    }

    toolResultBlock.appendChild(toolResultContent);
    messageContentDiv.appendChild(toolResultBlock);
    
    return toolResultBlock;
}

function handleToolBlockToggle(e) {
    const toggleBtn = e.target.closest('.tool-collapse-btn');
    if (toggleBtn) {
        const block = toggleBtn.closest('.tool-call-block, .tool-result-block');
        if (block) {
            block.dataset.userToggled = 'true';
            const isCollapsed = block.classList.toggle('collapsed');
            const icon = toggleBtn.querySelector('i');
            icon.className = isCollapsed ? 'bi bi-chevron-down' : 'bi bi-chevron-up';
            toggleBtn.title = isCollapsed ? 'Expand details' : 'Collapse details';
            persistCollapseState(block, 'tool', isCollapsed);
        }
    }
}

function highlightRenderedCode(element) {
    if (!element) return;
    element.querySelectorAll('pre code').forEach(block => {
         const preElement = block.parentElement;
         if (preElement && preElement.tagName === 'PRE' && !preElement.closest('.code-block-wrapper')) {
              const codeText = block.textContent;
              const langClass = block.className.split(' ').find(cls => cls.startsWith('language-'));
              const lang = langClass ? langClass.substring(9) : '';
              const wrapper = createCodeBlockWithContent(codeText, lang);
              preElement.replaceWith(wrapper);
         } else if (block.matches('.code-block-wrapper code') && !block.classList.contains('hljs')) {
             try { hljs.highlightElement(block); } catch(e) { console.error("Error highlighting mid-stream:", e); }
         } else if (!block.closest('.code-block-wrapper') && !block.classList.contains('hljs')){
               try { hljs.highlightElement(block); } catch(e) { console.error("Error highlighting loose code block:", e); }
         }
      });
 }

function createPlaceholderMessageRow(tempId, parentId) {
    const messageRow = document.createElement('div');
    messageRow.className = `message-row assistant-row placeholder`;
    messageRow.dataset.messageId = tempId;
    if (parentId) messageRow.dataset.parentId = parentId;

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    const avatarActionsDiv = document.createElement('div');
    avatarActionsDiv.className = 'message-avatar-actions placeholder-actions';

    messageDiv.appendChild(contentDiv);
    messageDiv.appendChild(avatarActionsDiv);
    messageRow.appendChild(messageDiv);
    return messageRow;
}

function removeMessageAndDescendantsFromDOM(startMessageId) {
    const startRow = findRowForMessageId(startMessageId);
    if (!startRow) {
        console.warn(`removeMessageAndDescendantsFromDOM: Start row ${startMessageId} not found.`);
        return;
    }
    const removedIds = new Set();

    function gatherIdsForRow(rowElement) {
        if (!rowElement) return [];
        const groupAttr = rowElement.dataset.groupMessageIds;
        if (groupAttr) {
            return groupAttr.split(',').map(id => id.trim()).filter(Boolean);
        }
        const singleId = rowElement.dataset.messageId;
        return singleId ? [singleId] : [];
    }

    function removeRecursively(rowElement) {
        if (!rowElement) return;

        const messageIdsForRow = gatherIdsForRow(rowElement);
        if (messageIdsForRow.length === 0) {
            console.warn('removeMessageAndDescendantsFromDOM: Row without identifiable message id encountered.');
        }

        messageIdsForRow.forEach(messageId => {
            if (!messageId || removedIds.has(messageId)) return;
            const childRows = messagesWrapper.querySelectorAll(`.message-row[data-parent-id="${messageId}"]`);
            childRows.forEach(child => removeRecursively(child));
            removedIds.add(messageId);
        });

        const logId = messageIdsForRow[messageIdsForRow.length - 1] || rowElement.dataset.messageId || 'unknown';
        console.log(`Removing DOM row for message ${logId}`);
        rowElement.remove();
    }

    removeRecursively(startRow);
    console.log("Finished removing branch from DOM, removed IDs:", Array.from(removedIds));
}

async function deleteMessageFromBackend(chatId, messageId) {
    try {
        const response = await fetch(`${API_BASE}/c/${chatId}/delete_message/${messageId}`, { method: 'POST' });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ detail: response.statusText }));
            throw new Error(`Failed to delete message: ${errorData.detail || response.statusText}`);
        }
        console.log(`Message ${messageId} deleted from backend.`);
        return true;
    } catch (error) {
        console.error('Error deleting message from backend:', error);
        addSystemMessage(`Error deleting message: ${error.message}`, "error");
        return false;
    }
}

async function regenerateMessage(messageIdToRegen, newBranch = false) {
    const currentChatId = state.currentChatId;
    if (!currentChatId || document.getElementById('send-button').disabled) {
        addSystemMessage("Cannot regenerate while busy.", "warning");
        return;
    }

    const groupInfo = resolveMessageGroupInfo(messageIdToRegen);
    let finalMessage = state.messages.find(m => m.message_id === groupInfo.finalMessageId);
    let primaryMessage = state.messages.find(m => m.message_id === groupInfo.primaryMessageId);

    // If the target message is a 'tool' message, walk up to find the parent 'llm' message
    // Tool messages have parent_message_id pointing to the LLM message that made the tool call
    if (finalMessage && finalMessage.role === 'tool') {
        const parentLlmId = finalMessage.parent_message_id;
        const parentLlm = parentLlmId ? state.messages.find(m => m.message_id === parentLlmId) : null;
        if (parentLlm && (parentLlm.role === 'llm' || parentLlm.role === 'assistant')) {
            console.log(`Regenerating from tool message ${finalMessage.message_id}, walking up to parent LLM message ${parentLlmId}`);
            // Update groupInfo to point to the LLM message instead
            primaryMessage = parentLlm;
            finalMessage = parentLlm;
        } else {
            addSystemMessage("Cannot regenerate: tool message has no valid parent assistant message.", "error");
            return;
        }
    }

    if (!finalMessage || (finalMessage.role !== 'llm' && finalMessage.role !== 'assistant')) {
        addSystemMessage("Can only regenerate assistant responses.", "error");
        return;
    }

    const parentMessageId = primaryMessage?.parent_message_id || null;
    const parentMessage = parentMessageId ? state.messages.find(m => m.message_id === parentMessageId) : null;
    if (!parentMessage) {
        addSystemMessage("Can only regenerate assistant responses that have a parent.", "error");
        return;
    }

    const modelNameToUse = getActiveCharacterModel();
    if (!modelNameToUse) {
        try { await fetchCharacters(true); } catch(e) { /* ignore */ }
        const retryModel = getActiveCharacterModel();
        if (!retryModel) {
            addSystemMessage('Active character has no preferred model (assign one before regenerating).', 'error');
            return;
        }
    }

    console.log(`Regenerating from parent ${parentMessageId} (targeting llm message ${primaryMessage.message_id}, new branch: ${newBranch}) using model ${modelNameToUse}`);
    let assistantPlaceholderRow = null;
    const generationParentId = parentMessageId;
    // Use the resolved primaryMessage.message_id for deletion (may differ from groupInfo if we walked up from tool msg)
    const messageIdToDelete = primaryMessage.message_id;

    try {
        const parentRow = parentMessageId ? findClosestMessageRow(parentMessageId) : findClosestMessageRow(messageIdToDelete);
        if (!parentRow) {
            console.error(`Parent row ${parentMessageId ?? messageIdToDelete} not found in DOM. Cannot place placeholder correctly.`);
            addSystemMessage("Error: Parent message UI not found. Aborting regeneration.", "error");
            await loadChat(currentChatId);
            cleanupAfterGeneration();
            return;
        }

        if (!newBranch) {
            console.log(`Replacing: Deleting message branch starting with ${messageIdToDelete}.`);
            removeMessageAndDescendantsFromDOM(messageIdToDelete);
            const deleteSuccess = await deleteMessageFromBackend(currentChatId, messageIdToDelete);
            if (!deleteSuccess) {
                addSystemMessage("Failed to delete old message from backend. Reloading chat.", "error");
                await loadChat(currentChatId);
                cleanupAfterGeneration();
                return;
            }
            const descendantIds = new Set();
            const queue = [messageIdToDelete];
            while(queue.length > 0) {
                const currentId = queue.shift();
                if (!currentId || descendantIds.has(currentId)) continue;
                descendantIds.add(currentId);
                state.messages.forEach(m => {
                    if (m.parent_message_id === currentId) queue.push(m.message_id);
                });
            }
            state.messages = state.messages.filter(m => !descendantIds.has(m.message_id));
            const parentMsgInState = state.messages.find(m => m.message_id === parentMessageId);
            if (parentMsgInState?.child_message_ids) {
                parentMsgInState.child_message_ids = parentMsgInState.child_message_ids.filter(
                    id => !descendantIds.has(id)
                );
            }
            console.log(`Locally removed ${descendantIds.size} messages from state for replacement.`);
        } else {
            console.log(`Branching: Visually clearing current active branch from parent ${parentMessageId} before generating new one.`);
            const parentNodeInState = state.messages.find(m => m.message_id === parentMessageId);
            
            // For branching, we need to remove the current visible branch from DOM
            // Try using child_message_ids first, fallback to finding children by parent_message_id
            let activeChildIdToClear = null;
            
            if (parentNodeInState && Array.isArray(parentNodeInState.child_message_ids) && parentNodeInState.child_message_ids.length > 0) {
                const activeChildIndex = parentNodeInState.active_child_index ?? 0;
                const safeActiveIndex = Math.min(Math.max(0, activeChildIndex), parentNodeInState.child_message_ids.length - 1);
                activeChildIdToClear = parentNodeInState.child_message_ids[safeActiveIndex];
            } else {
                // Fallback: find children by iterating state.messages
                const childMessages = state.messages.filter(m => m.parent_message_id === parentMessageId);
                if (childMessages.length > 0) {
                    // Use the first child (or the one we're trying to regenerate)
                    activeChildIdToClear = messageIdToDelete;
                }
            }
            
            if (activeChildIdToClear) {
                console.log(`Branching: Visually removing current active branch starting with ${activeChildIdToClear} from DOM.`);
                removeMessageAndDescendantsFromDOM(activeChildIdToClear);
            } else {
                console.warn(`Branching: Could not determine active child to clear from DOM for parent ${parentMessageId}.`);
            }
        }

        assistantPlaceholderRow = createPlaceholderMessageRow(`temp_assistant_${Date.now()}`, generationParentId);
        parentRow.insertAdjacentElement('afterend', assistantPlaceholderRow);
        const assistantContentDiv = assistantPlaceholderRow.querySelector('.message-content');
        if (!assistantContentDiv) {
            assistantPlaceholderRow?.remove();
            throw new Error("Failed to create assistant response placeholder element.");
        }

        await generateAssistantResponse(
            generationParentId,
            assistantContentDiv,
            modelNameToUse,
            defaultGenArgs,
            state.toolsEnabled
        );

    } catch (error) {
        console.error(`Error during regeneration (new branch: ${newBranch}):`, error);
        addSystemMessage(`Regeneration failed: ${error.message}`, "error");
        assistantPlaceholderRow?.remove();
        try {
            console.log("Reloading chat due to regeneration error to restore consistency.");
            await loadChat(currentChatId);
        } catch(e) {
            console.error("Failed to reload chat after regeneration error:", e);
        }
        cleanupAfterGeneration();
        requestAnimationFrame(updateScrollButtonVisibility);
    }
}

function requestAutoScroll(behavior = 'smooth') {
    if (!state.autoscrollEnabled || !chatContainer) {
        if (!chatContainer) requestAnimationFrame(updateScrollButtonVisibility);
        return;
    }
    if (autoScrollFrameId !== null) {
        cancelAnimationFrame(autoScrollFrameId);
    }
    autoScrollFrameId = requestAnimationFrame(() => {
        autoScrollFrameId = null;
        chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior });
        updateScrollButtonVisibility();
    });
}

function scrollToBottom(behavior = 'auto') {
    if (behavior === 'smooth' && state.autoscrollEnabled) {
        requestAutoScroll(behavior);
        return;
    }
    requestAnimationFrame(() => {
        if (chatContainer) {
            chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior });
        }
        updateScrollButtonVisibility();
    });
}

async function stopStreaming() {
    if (state.streamController && !state.streamController.signal.aborted) {
        console.log("User requested stop. Signaling backend and then aborting frontend fetch.");

        // Step 1: Signal backend to abort and save. Await its acknowledgement.
        if (state.currentChatId) {
            console.log(`Signaling backend to abort generation for chat ${state.currentChatId} and awaiting acknowledgement...`);
            try {
                // Ensure the backend endpoint only returns success after the message is saved.
                const abortResponse = await fetch(`${API_BASE}/c/${state.currentChatId}/abort_generation`, { method: 'POST' });
                if (!abortResponse.ok) {
                    const errorText = await abortResponse.text().catch(() => `Status: ${abortResponse.status}`);
                    console.error(`Backend abort request failed: ${errorText || '(empty response)'}`);
                    // Even if backend signal fails, proceed to abort frontend stream.
                } else {
                    const resultText = await abortResponse.text().catch(() => "Acknowledged (no text)");
                    console.log("Backend abort signal acknowledged by backend:", resultText || "Acknowledged");
                }
            } catch (err) {
                console.error("Error sending abort signal to backend:", err);
                // Even if backend signal fails, proceed to abort frontend stream.
            }
        } else {
            console.warn("Cannot signal backend abort: No current chat ID.");
        }

        // Step 2: Abort the frontend stream controller.
        // This will trigger the onError callback in generateAssistantResponse.
        console.log("Aborting frontend stream controller.");
        state.streamController.abort();

    } else {
        console.log("No active frontend stream to stop or already aborted.");
        // If UI is stuck in generating state without an active stream, force cleanup.
        if (document.getElementById('send-button').disabled || stopButton.style.display === 'flex') {
             console.warn("Stop clicked with no active stream or UI stuck, forcing UI cleanup.");
             cleanupAfterGeneration(); // Ensures UI is reset
        }
    }
}


function startNewChat() {
    console.log("Starting new chat...");
    if (state.streamController || state.toolCallPending) {
         addSystemMessage("Please wait for the current response or tool call to finish first.", "warning"); return;
    }
    state.currentChatId = null; state.messages = [];
    messagesWrapper.innerHTML = '';
    welcomeContainer.style.display = 'flex';
    document.body.classList.add('welcome-active');
    localStorage.removeItem('lastChatId');
    updateUrlForChat(null); // Clear URL
    highlightCurrentChatInSidebar();

    state.currentImages = []; state.currentTextFiles = [];
    imagePreviewContainer.innerHTML = '';
    adjustTextareaHeight();
    state.toolCallPending = false;
    state.toolContinuationContext = null;
    state.currentToolCallId = null;
    state.abortingForToolCall = false;
    state.codeBlocksDefaultCollapsed = false;
    updateCodeblockToggleButton();

    updateActiveCharacterUI();
    updateAutoscrollButton();

    if (chatContainer) chatContainer.style.paddingBottom = '0px';
    requestAnimationFrame(updateScrollButtonVisibility);
}

async function deleteCurrentChat() {
    if (!state.currentChatId) { addSystemMessage("No chat selected to delete.", "warning"); return; }
     if (state.streamController || state.toolCallPending) {
        addSystemMessage("Please wait for the current response or tool call to finish before deleting.", "warning"); return;
     }
    // Confirmation removed
    console.log(`Deleting chat: ${state.currentChatId}`);
    try {
        const response = await fetch(`${API_BASE}/c/${state.currentChatId}`, { method: 'DELETE' });
        if (!response.ok) { throw new Error(`Failed to delete chat: ${await response.text()}`); }
        console.log(`Chat ${state.currentChatId} deleted successfully.`);
        const deletedChatId = state.currentChatId;
        startNewChat();
        state.chats = state.chats.filter(c => c.chat_id !== deletedChatId);
        renderChatList();
    } catch (error) { console.error('Error deleting chat:', error); addSystemMessage(`Failed to delete chat: ${error.message}`, "error"); }
}

function styleThemeOptionButtons() {
    document.querySelectorAll('.theme-option[data-theme]').forEach(button => {
        const themeName = button.dataset.theme;
        const themeConfig = THEMES_CONFIG[themeName];
        if (themeConfig) {
            button.style.backgroundColor = themeConfig['--bg-primary'];
            button.style.color = themeConfig['--text-primary'];
            // Add a border to make buttons with light backgrounds visible
            button.style.border = `1px solid ${themeConfig['--accent-color']}`;
        }
    });
}

function setupThemeSwitch() {
    styleThemeOptionButtons();
    const savedTheme = localStorage.getItem('theme') || 'dark';
    applyTheme(savedTheme);
}

function applyTheme(themeName) {
    const theme = THEMES_CONFIG[themeName] || THEMES_CONFIG.dark;

    Object.entries(theme).forEach(([prop, value]) => {
        document.documentElement.style.setProperty(prop, value);
    });

    const highlightThemeLink = document.getElementById('highlight-theme');
    if (themeName === 'white' || themeName === 'claude_white' || themeName === 'solarized' || themeName === 'gruvbox_light') {
        highlightThemeLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css';
        if (themeName === 'solarized') {
            highlightThemeLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/base16/solarized-light.min.css';
        } else if (themeName === 'gruvbox_light') {
            highlightThemeLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/base16/gruvbox-light-medium.min.css';
        }
    } else if (themeName === 'gruvbox_dark') {
        highlightThemeLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/base16/gruvbox-dark-medium.min.css';
    } else {
       highlightThemeLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/stackoverflow-dark.css';
    }

     let dynamicStyle = document.getElementById('dynamic-hljs-bg');
     if (!dynamicStyle) {
          dynamicStyle = document.createElement('style');
          dynamicStyle.id = 'dynamic-hljs-bg';
          document.head.appendChild(dynamicStyle);
     }
     dynamicStyle.textContent = `
     pre code.hljs { background: var(--bg-tertiary) !important; }
     .code-block-wrapper { background: var(--bg-tertiary) !important; }
     `;

     setTimeout(() => {
         messagesWrapper.querySelectorAll('pre code').forEach(block => {
              try { hljs.highlightElement(block); }
              catch (e) { console.error("Error re-highlighting:", e); }
         });
     }, 100);

    localStorage.setItem('theme', themeName);
    console.log(`Theme applied: ${themeName}`);
}

function setupGenerationSettings() {
    const genSettingsBtnInPopup = document.getElementById('gen-settings-btn');
    const modal = document.getElementById('gen-settings-modal');
    const applyBtn = document.getElementById('apply-gen-settings');
    const cancelBtn = document.getElementById('cancel-gen-settings');

    if (genSettingsBtnInPopup && modal && mainSettingsPopup) {
        genSettingsBtnInPopup.addEventListener('click', () => {
            updateSlidersUI();
            modal.style.display = 'flex';
            mainSettingsPopup.style.display = 'none';
        });
    }

    if (applyBtn && modal) {
        applyBtn.addEventListener('click', () => {
            defaultGenArgs.temperature = document.getElementById('temp-none').checked ? null : parseFloat(document.getElementById('temp-slider').value);
            defaultGenArgs.min_p = document.getElementById('minp-none').checked ? null : parseFloat(document.getElementById('minp-slider').value);
            defaultGenArgs.max_tokens = document.getElementById('maxt-none').checked ? null : parseInt(document.getElementById('maxt-slider').value);
            
            const topPSlider = document.getElementById('topp-slider');
            const topPNoneCheckbox = document.getElementById('topp-none');
            if (topPSlider && topPNoneCheckbox) {
                 defaultGenArgs.top_p = topPNoneCheckbox.checked ? null : parseFloat(topPSlider.value);
            } else {
                 defaultGenArgs.top_p = null;
                 console.warn("Top P slider or checkbox not found in setupGenerationSettings.");
            }
            localStorage.setItem('genArgs', JSON.stringify(defaultGenArgs));
            modal.style.display = 'none';
        });
    }

    if (cancelBtn && modal) {
        cancelBtn.addEventListener('click', () => modal.style.display = 'none');
    }
    if (modal) {
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
    }

    const settingsConfig = [
        { prefix: 'temp', defaultVal: 0.7, stateKey: 'temperature' },
        { prefix: 'minp', defaultVal: 0.05, stateKey: 'min_p' },
        { prefix: 'maxt', defaultVal: 1024, stateKey: 'max_tokens' },
        { prefix: 'topp', defaultVal: 1.0, stateKey: 'top_p'}
    ];

    settingsConfig.forEach(({ prefix, stateKey }) => {
        const slider = document.getElementById(`${prefix}-slider`);
        const valueSpan = document.getElementById(`${prefix}-value`);
        const noneCheckbox = document.getElementById(`${prefix}-none`);
        if (!slider || !valueSpan || !noneCheckbox) return;

        slider.addEventListener('input', () => {
            valueSpan.textContent = slider.value;
            if (noneCheckbox.checked) { noneCheckbox.checked = false; slider.disabled = false; }
        });
        noneCheckbox.addEventListener('change', () => {
            slider.disabled = noneCheckbox.checked;
            valueSpan.textContent = noneCheckbox.checked ? 'None' : slider.value;
        });
    });

    function updateSlidersUI() {
        settingsConfig.forEach(({ prefix, stateKey }) => {
             const slider = document.getElementById(`${prefix}-slider`);
             const valueSpan = document.getElementById(`${prefix}-value`);
             const noneCheckbox = document.getElementById(`${prefix}-none`);
             if (!slider || !valueSpan || !noneCheckbox) return;
             const currentValue = defaultGenArgs[stateKey];
            const isNone = currentValue === null || currentValue === undefined;
            noneCheckbox.checked = isNone;
            slider.disabled = isNone;
            if (isNone) { valueSpan.textContent = 'None'; }
            else { slider.value = currentValue; valueSpan.textContent = currentValue; }
        });
    }
    updateSlidersUI();
}

function getPersistedCotTags() {
    if (!cachedPersistedCotTagsLoaded) {
        cachedPersistedCotTagsLoaded = true;
        try {
            cachedPersistedCotTags = JSON.parse(localStorage.getItem('cotTags') || 'null');
        } catch {
            cachedPersistedCotTags = null;
        }
    }
    return cachedPersistedCotTags;
}

function setPersistedCotTags(value) {
    cachedPersistedCotTags = value;
    cachedPersistedCotTagsLoaded = true;
}

function getCotTagPairs() {
    const pairs = [];
    const active = getActiveCharacterCotTags ? getActiveCharacterCotTags() : { start: null, end: null };
    const activeStart = active?.start ? active.start.trim() : null;
    const activeEnd = active?.end ? active.end.trim() : null;
    if (activeStart && activeEnd) pairs.push({ start: activeStart, end: activeEnd });

    const persisted = getPersistedCotTags();
    const persistedStart = persisted?.start ? persisted.start.trim() : null;
    const persistedEnd = persisted?.end ? persisted.end.trim() : null;
    if (persistedStart && persistedEnd) pairs.push({ start: persistedStart, end: persistedEnd });

    pairs.push({ start: '<think>', end: '</think>' });

    const seen = new Set();
    return pairs.filter(pair => {
        if (!pair.start || !pair.end) return false;
        const key = `${pair.start}__${pair.end}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function startsWithCotBlock(text, tagPairs = null) {
    const candidates = tagPairs || getCotTagPairs();
    const trimmed = (text || '').trimStart();
    return candidates.some(({ start }) => start && trimmed.startsWith(start));
}

function stripCotBlocks(text, tagPairs = null) {
    if (!text) return '';
    const candidates = tagPairs || getCotTagPairs();
    let result = String(text);
    candidates.forEach(({ start, end }) => {
        if (!start || !end) return;
        const regex = new RegExp(`${escapeRegExp(start)}[\s\S]*?${escapeRegExp(end)}`, 'g');
        result = result.replace(regex, '');
    });
    return result;
}

function parseThinkContent(text, tagPairs = null) {
    const sourceText = text || '';
    const candidates = tagPairs || getCotTagPairs();
    for (const { start, end } of candidates) {
        const startIndex = sourceText.indexOf(start);
        if (startIndex === -1) continue;
        const endIndex = sourceText.indexOf(end, startIndex + start.length);
        if (endIndex === -1) {
            const content = sourceText.substring(startIndex + start.length).trim();
            return { thinkContent: content, remainingText: '' };
        }
        const thinkContent = sourceText.substring(startIndex + start.length, endIndex).trim();
        const remainingText = sourceText.substring(endIndex + end.length).trim();
        return { thinkContent, remainingText };
    }
    return { thinkContent: null, remainingText: sourceText };
}

function addSystemMessage(text, type = "info", timeout = null) {
    console.log(`System Message [${type}]: ${text}`);

    let toastContainer = document.getElementById('system-toast-messages-container');
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.id = 'system-toast-messages-container';
        document.body.appendChild(toastContainer);
    }

    const messageRow = document.createElement('div');
    messageRow.className = `system-toast-message ${type}`;

    const iconClass = type === 'error' ? 'exclamation-octagon-fill' : (type === 'warning' ? 'exclamation-triangle-fill' : 'info-circle-fill');
    messageRow.innerHTML = `<i class="bi bi-${iconClass}"></i> <span>${text}</span>`;

    toastContainer.appendChild(messageRow);

    requestAnimationFrame(() => {
        messageRow.style.opacity = '1';
        messageRow.style.transform = 'translateY(0) scale(1)';
    });

    const effectiveTimeout = (timeout && typeof timeout === 'number' && timeout > 0) ? timeout : (type === 'error' || type === 'warning' ? 3000 : 2000); // Faster notifications


    setTimeout(() => {
        messageRow.style.opacity = '0';
        messageRow.style.transform = 'translateY(-20px) scale(0.95)';
        setTimeout(() => {
            messageRow.remove();
            // if (toastContainer.children.length === 0) {
            //     toastContainer.remove(); // Optionally remove if you prefer
            // }
        }, 200); // Must match CSS transition duration
    }, effectiveTimeout);
}

function setupAutoscrollToggle() {
    const savedAutoscrollState = localStorage.getItem('autoscrollEnabled');
    state.autoscrollEnabled = savedAutoscrollState !== null ? savedAutoscrollState === 'true' : false;

    if (toggleAutoscrollBtn) {
        updateAutoscrollButton();
        toggleAutoscrollBtn.addEventListener('click', () => {
            state.autoscrollEnabled = !state.autoscrollEnabled;
            localStorage.setItem('autoscrollEnabled', state.autoscrollEnabled);
            updateAutoscrollButton();
            console.log("Autoscroll enabled:", state.autoscrollEnabled);
            if (state.autoscrollEnabled) {
                scrollToBottom('smooth');
            } else {
                requestAnimationFrame(updateScrollButtonVisibility);
            }
            addSystemMessage(`Autoscroll ${state.autoscrollEnabled ? 'Enabled' : 'Disabled'}`, 'info', 1500);
        });
    } else {
        console.warn("Autoscroll toggle button not found; using saved autoscrollEnabled state only.");
    }
}

function updateAutoscrollButton() {
    if (!toggleAutoscrollBtn) return;
    const icon = toggleAutoscrollBtn.querySelector('i');
    if (!icon) return;

    if (state.autoscrollEnabled) {
        icon.className = 'bi bi-unlock-fill';
        toggleAutoscrollBtn.classList.add('active');
        toggleAutoscrollBtn.title = 'Disable Autoscroll (Lock View)';
    } else {
        icon.className = 'bi bi-lock-fill';
        toggleAutoscrollBtn.classList.remove('active');
        toggleAutoscrollBtn.title = 'Enable Autoscroll';
    }
}

document.addEventListener('DOMContentLoaded', init);