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
const modelSelect = document.getElementById('model-select');
const imageButton = document.getElementById('image-button');
const fileButton = document.getElementById('file-button');
const stopButton = document.getElementById('stop-button');
const clearChatBtn = document.getElementById('delete-chat-btn');
const newChatBtn = document.getElementById('new-chat-btn');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebar = document.getElementById('sidebar');
const imagePreviewContainer = document.getElementById('image-preview-container');
const chatHistoryContainer = document.querySelector('.chat-history');
const toggleToolsBtn = document.getElementById('toggle-tools-btn');

// State Management (Remove unused scroll flags)
const state = {
    currentChatId: null,
    chats: [], // List of {chat_id, preview, timestamp_updated}
    messages: [], // All messages for the current chat { message_id, ..., children_ids: [] }
    models: [],
    currentImages: [], // { base64, dataUrl, type, name }
    currentTextFiles: [], // { name, content (formatted), type, rawContent }
    streamController: null, // AbortController for fetch
    currentAssistantMessageDiv: null, // The div being actively streamed into
    currentCharacterId: null,
    activeSystemPrompt: null, // Store the actual character prompt text
    effectiveSystemPrompt: null, // Character prompt + optional tools prompt
    followOutput: true, // NEW: Track if user wants to follow output (used only by scroll listener now)
    activeBranchInfo: {}, // { parentMessageId: { activeIndex: number, totalBranches: number } } -> Derived from messages during render
    apiKeys: { // Store keys fetched from backend /config endpoint
        openrouter: null,
        google: null,
        local: null, // For local servers that might need a key (populated from local_api_key in backend config)
    },
    toolsEnabled: false, // Flag to control tool usage
    // Tool calling state (needed for frontend stream interruption/continuation)
    toolCallPending: false,
    // Stores { history, partialText, toolCallPlaceholder (the <tool> tag), toolResultPlaceholder (the <tool_result> tag), toolCallData, toolResultData, parentId }
    toolContinuationContext: null,
    currentToolCallId: null, // Track the ID of the current tool call being processed
    abortingForToolCall: false,
    scrollDebounceTimer: null, // NEW: For debouncing scroll listener
    codeBlocksDefaultCollapsed: false, // NEW: Default state for code blocks in the current chat (false = expanded)
};

// Default generation arguments
const defaultGenArgs = {
    temperature: null,
    min_p: null,
    max_tokens: null,
    top_p: null,
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

// Regex for detecting simple tool calls (adjust as needed, very fragile)
// Example: <tool name="add" a="1" b="2" />
const TOOL_CALL_REGEX = /<tool\s+name="(\w+)"((?:\s+\w+="[^"]*")+)\s*\/>/g;
// Regex for detecting tool result tags (used in buildContentHtml)
const TOOL_RESULT_TAG_REGEX = /<tool_result\s+tool_name="(\w+)"\s+result="((?:[^"]|&quot;)*)"\s*\/>/g;
// Combined Regex for parsing message content in buildContentHtml
const TOOL_TAG_REGEX = /(<tool\s+name="(\w+)"([^>]*)\/>)|(<tool_result\s+tool_name="(\w+)"\s+result="((?:[^"]|&quot;)*)"\s*\/>)/g;


// Helper to parse attributes string like ' a="1" b="2"' into an object
function parseAttributes(attrsString) {
    const attributes = {};
    const attrRegex = /(\w+)="([^"]*)"/g;
    let match;
    while ((match = attrRegex.exec(attrsString)) !== null) {
        attributes[match[1]] = match[2];
    }
    return attributes;
}

// (Replace the existing renderMarkdown function with this one)
// ADDED: Optional temporaryId for state preservation during streaming
function renderMarkdown(text, initialCollapsedState = true, temporaryId = null) {
    let processedText = text || '';
    let html = '';
    let thinkContent = '';
    let remainingTextAfterThink = '';
    let isThinkBlockMessage = processedText.trim().startsWith('<think>');

    // --- Handle Think Block ---
    if (isThinkBlockMessage) {
        const thinkStartIndex = processedText.indexOf('<think>');
        let thinkEndIndex = processedText.indexOf('</think>');
        if (thinkEndIndex === -1) {
            thinkContent = processedText.substring(thinkStartIndex + '<think>'.length);
            remainingTextAfterThink = '';
        } else {
            thinkContent = processedText.substring(thinkStartIndex + '<think>'.length, thinkEndIndex);
            remainingTextAfterThink = processedText.substring(thinkEndIndex + '</think>'.length);
        }

        // --- Create Think Block Structure (HTML string generation) ---
        const thinkBlockWrapper = document.createElement('div');
        thinkBlockWrapper.className = `think-block ${initialCollapsedState ? 'collapsed' : ''}`;
        // *** ADDED: Assign temporary ID if provided ***
        if (temporaryId) {
            thinkBlockWrapper.dataset.tempId = temporaryId;
        }

        const header = document.createElement('div');
        header.className = 'think-header';
        // Header Title (static)
        const titleSpan = document.createElement('span');
        titleSpan.className = 'think-header-title';
        titleSpan.innerHTML = '<i class="bi bi-lightbulb"></i> Thought Process';
        header.appendChild(titleSpan);
        // Header Actions (toggle button)
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'think-header-actions';
        const collapseBtn = document.createElement('button');
        collapseBtn.className = 'think-block-toggle'; // Class for event delegation
        collapseBtn.innerHTML = `<i class="bi bi-chevron-${initialCollapsedState ? 'down' : 'up'}"></i>`;
        collapseBtn.title = `${initialCollapsedState ? 'Expand' : 'Collapse'} thought process`;
        actionsDiv.appendChild(collapseBtn);
        header.appendChild(actionsDiv);
        thinkBlockWrapper.appendChild(header); // Add the header to the wrapper

        // Content Div
        const thinkContentDiv = document.createElement('div');
        thinkContentDiv.className = 'think-content';
        // Parse the inner think content with marked
        thinkContentDiv.innerHTML = marked.parse(thinkContent.trim());
        thinkBlockWrapper.appendChild(thinkContentDiv); // Add content div

        html += thinkBlockWrapper.outerHTML; // Add the whole block's HTML string
        processedText = remainingTextAfterThink; // Process text *after* the block
    }

    // --- Process remaining text (non-think or text after think block) ---
    if (processedText) {
        // 1. Parse the entire remaining text with marked
        let remainingHtml = marked.parse(processedText);

        // 2. Create a temporary container to manipulate the parsed HTML
        const tempContainer = document.createElement('div');
        tempContainer.innerHTML = remainingHtml;

        // 3. Find and enhance all <pre> elements within the container
        tempContainer.querySelectorAll('pre').forEach(preElement => {
            enhanceCodeBlock(preElement); // Use the helper to replace pre with wrapped version
        });

        // 4. Process LaTeX (applied to the potentially modified HTML)
        let finalHtml = tempContainer.innerHTML; // Get the HTML after code block enhancement
        finalHtml = finalHtml.replace(/\$\$([\s\S]+?)\$\$/g, (match, latex) => {
            try {
                const decodedLatex = latex.replace(/</g, '<').replace(/>/g, '>').replace(/&/g, '&');
                return katex.renderToString(decodedLatex.trim(), { displayMode: true, throwOnError: false });
            } catch (e) { console.error('KaTeX block rendering error:', e, "Input:", latex); return `<span class="katex-error">[Block LaTeX Error]</span>`; }
        });
        finalHtml = finalHtml.replace(/(?<!\$)\$([^$\n]+?)\$(?!\$)/g, (match, latex) => {
            try {
                 const decodedLatex = latex.replace(/</g, '<').replace(/>/g, '>').replace(/&/g, '&');
                return katex.renderToString(decodedLatex.trim(), { displayMode: false, throwOnError: false });
            } catch (e) { console.error('KaTeX inline rendering error:', e, "Input:", latex); return `<span class="katex-error">[Inline LaTeX Error]</span>`; }
        });


        // *** Wrap remaining content in a div if it came after a think block ***
        // This helps target it during streaming updates.
        if (isThinkBlockMessage) {
            // Use the same ID as buildContentHtml uses for the remaining content container
            const remainingContentTempId = 'streaming-remaining-content';
            html += `<div data-temp-id="${remainingContentTempId}">${finalHtml}</div>`;
        } else {
            html += finalHtml; // Add the processed HTML directly
        }
    }

    return html;
}

/**
 * Handles clicks on code block copy buttons (delegated).
 * @param {HTMLButtonElement} copyBtn - The clicked copy button element.
 */
function handleCodeCopy(copyBtn) {
    const wrapper = copyBtn.closest('.code-block-wrapper');
    if (!wrapper) return;

    // Retrieve raw code from the data attribute
    const codeText = wrapper.dataset.rawCode || ''; // Use stored raw code

    if (!codeText) {
        console.warn("Could not find code text to copy.");
        return;
    }

    navigator.clipboard.writeText(codeText).then(() => {
        copyBtn.innerHTML = '<i class="bi bi-check-lg"></i> Copied';
        copyBtn.disabled = true;
        setTimeout(() => {
            copyBtn.innerHTML = '<i class="bi bi-clipboard"></i> Copy';
            copyBtn.disabled = false;
        }, 1500);
    }).catch(err => {
        console.error('Failed to copy code:', err);
        copyBtn.innerHTML = 'Error'; // Indicate copy failure briefly
         setTimeout(() => {
             copyBtn.innerHTML = '<i class="bi bi-clipboard"></i> Copy';
         }, 1500);
    });
    // No need for stopPropagation here as the main listener handles it
}

/**
 * Handles clicks on code block collapse buttons (delegated).
 * @param {HTMLButtonElement} collapseBtn - The clicked collapse button element.
 */
function handleCodeCollapse(collapseBtn) {
    const wrapper = collapseBtn.closest('.code-block-wrapper');
    const preElement = wrapper?.querySelector('pre'); // Find the pre element to hide/show
    const collapseInfoSpan = wrapper?.querySelector('.collapse-info');
    const icon = collapseBtn.querySelector('i');

    if (!wrapper || !preElement || !collapseInfoSpan || !icon) {
        console.warn("Could not find necessary elements for code collapse.");
        return;
    }

    const isCollapsed = wrapper.classList.toggle('collapsed');

    if (isCollapsed) {
        icon.className = 'bi bi-chevron-down';
        collapseBtn.title = 'Expand code';
        const codeText = wrapper.dataset.rawCode || ''; // Use raw code for accurate count
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
    // No need for stopPropagation here
}

// handleThinkBlockToggle - UPDATED to use .collapsed class
function handleThinkBlockToggle(e) {
    const toggleBtn = e.target.closest('.think-block-toggle');
    if (toggleBtn) {
        const block = toggleBtn.closest('.think-block');
        if (block) {
            const isCollapsed = block.classList.toggle('collapsed');
            const icon = toggleBtn.querySelector('i');
            // Update icon and title based on the new state (after toggle)
            if (isCollapsed) {
                icon.className = 'bi bi-chevron-down';
                toggleBtn.title = 'Expand thought process';
            } else {
                icon.className = 'bi bi-chevron-up';
                toggleBtn.title = 'Collapse thought process';
            }
        }
    }
}

// --- Tool Prompting Update ---
function updateEffectiveSystemPrompt() {
    let basePrompt = state.activeSystemPrompt || "";
    let toolsPrompt = "";
    if (state.toolsEnabled && TOOLS_SYSTEM_PROMPT) {
        toolsPrompt = `\n\n${TOOLS_SYSTEM_PROMPT}`; // Add separator
    }
    state.effectiveSystemPrompt = (basePrompt + toolsPrompt).trim() || null;
    // Update the display banner IF a character is selected (it shows character name)
    // If no character is selected, the banner is empty anyway.
    if (state.currentCharacterId) {
        fetchCharacters().then(characters => {
            const char = characters.find(c => c.character_id === state.currentCharacterId);
            displayActiveSystemPrompt(char?.character_name, state.effectiveSystemPrompt);
        });
    } else {
        displayActiveSystemPrompt(state.toolsEnabled ? "Tools Enabled" : null, state.effectiveSystemPrompt);
    }
    console.log("Effective system prompt updated:", state.effectiveSystemPrompt ? state.effectiveSystemPrompt.substring(0, 100) + "..." : "None");
}

// --- NEW Scroll Handling Functions ---

/** Debounce helper function */
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

/** Updates visibility of the scroll-to-bottom button */
function updateScrollButtonVisibility() {
    const scrollButton = document.getElementById('scroll-to-bottom-btn');
    if (!chatContainer || !scrollButton) return;

    // Show button only if NOT scrolled near the bottom
    const isNearBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 30; // 30px tolerance
    scrollButton.style.display = isNearBottom ? 'none' : 'flex'; // Use flex to match other buttons
}

/** Sets up scroll listener and button click handler */
function setupScrollListener() {
    const scrollButton = document.getElementById('scroll-to-bottom-btn');
    if (!chatContainer || !scrollButton) {
        console.error("Chat container or scroll button not found for scroll listener setup.");
        return;
    }

    // Debounced listener for scroll events
    chatContainer.addEventListener('scroll', debounce(updateScrollButtonVisibility, 100));

    // Click listener for the button
    scrollButton.addEventListener('click', () => {
        chatContainer.scrollTo({
            top: chatContainer.scrollHeight,
            behavior: 'smooth'
        });
    });

    // Initial check in case content is already scrollable on load
    requestAnimationFrame(updateScrollButtonVisibility);
}

async function init() {
    // Setup fetch calls
    await fetchProviderConfig();
    await fetchToolsSystemPrompt(); // Fetch tool descriptions
    await loadGenArgs();
    await fetchChats(); // Keep fetch for sidebar history

    // Setup UI elements and listeners
    await populateCharacterSelect(); // Populates dropdown, restores last selection if any
    setupCharacterEvents();
    setupEventListeners();
    setupScrollListener(); // NEW: Setup scroll listener for button
    adjustTextareaHeight(); // Call initially to set correct height/padding
    setupDropZone();
    setupThemeSwitch();
    setupGenerationSettings();
    setupToolToggle(); // Setup the new button listener
    setupCodeblockToggle(); // NEW: Setup the global codeblock toggle button

    // Always start with a new chat interface
    startNewChat();

    applySidebarState(); // Apply sidebar collapsed/expanded state
}


// --- Config & Model Fetching (MODIFIED) ---

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

        console.log("Fetched provider config and populated API keys (values hidden).");
        await fetchModels();

    } catch (error) {
        console.error('Error fetching provider config:', error);
        addSystemMessage("Failed to fetch API configuration from backend. Models requiring keys may be disabled.", "error");
        populateModelSelect();
    }
}

async function fetchToolsSystemPrompt() {
    try {
        const response = await fetch(`${API_BASE}/tools/system_prompt`);
        if (!response.ok) throw new Error(`Failed to fetch tools prompt: ${response.statusText}`);
        const data = await response.json();
        TOOLS_SYSTEM_PROMPT = data.prompt || "";
        console.log("Fetched tools system prompt.");
        updateEffectiveSystemPrompt(); // Update effective prompt after fetching
    } catch (error) {
        console.error('Error fetching tools system prompt:', error);
        TOOLS_SYSTEM_PROMPT = ""; // Ensure it's empty on error
        updateEffectiveSystemPrompt(); // Still update effective prompt
        addSystemMessage("Failed to fetch tool descriptions from backend.", "warning");
    }
}


async function loadGenArgs() {
    const savedGenArgs = localStorage.getItem('genArgs');
    if (savedGenArgs) {
        try { Object.assign(defaultGenArgs, JSON.parse(savedGenArgs)); }
        catch { /* ignore parse error */ }
    }
    defaultGenArgs.temperature = defaultGenArgs.temperature ?? null;
    defaultGenArgs.min_p = defaultGenArgs.min_p ?? null;
    defaultGenArgs.max_tokens = defaultGenArgs.max_tokens ?? null;
    defaultGenArgs.top_p = defaultGenArgs.top_p ?? null;
}

async function fetchModels() {
    try {
        const response = await fetch(`${API_BASE}/models`);
        if (!response.ok) throw new Error(`Failed to fetch models: ${response.statusText}`);
        state.models = await response.json();
        state.models.sort((a, b) => a.displayName.localeCompare(b.displayName));
        populateModelSelect(); // Populate select after fetching
    } catch (error) {
        console.error('Error fetching models:', error);
        state.models = [];
        populateModelSelect(); // Show error state in dropdown
    }
}

function populateModelSelect() {
    modelSelect.innerHTML = '';
    if (state.models.length === 0) {
        modelSelect.innerHTML = '<option value="" disabled>No models available</option>';
    } else {
        state.models.forEach(model => {
            const option = document.createElement('option');
            option.value = model.name;
            option.dataset.modelIdentifier = model.model_identifier;
            option.dataset.supportsImages = model.supportsImages;
            option.dataset.provider = model.provider;

            // Check if API key is available FOR THIS PROVIDER in state
            const apiKeyAvailable = !!getApiKey(model.provider); // Use getApiKey helper

            option.textContent = `${model.displayName}${apiKeyAvailable ? '' : ' (Key Missing)'}`;
            option.disabled = !apiKeyAvailable;

            modelSelect.appendChild(option);
        });

        // Restore selection logic
        const lastModel = localStorage.getItem('lastModelName');
        const lastModelOption = Array.from(modelSelect.options).find(opt => opt.value === lastModel && !opt.disabled);
        if (lastModelOption) {
            modelSelect.value = lastModel;
        } else {
            const firstEnabledOption = modelSelect.querySelector('option:not([disabled])');
            if (firstEnabledOption) {
                modelSelect.value = firstEnabledOption.value;
                localStorage.setItem('lastModelName', modelSelect.value);
            } else {
                 modelSelect.value = '';
            }
        }
    }
    updateAttachButtons();
}


// --- Chat Data Fetching & Rendering ---

async function fetchChats() {
    try {
        const response = await fetch(`${API_BASE}/chat/get_chats?limit=100`);
        if (!response.ok) throw new Error(`Failed to fetch chats: ${response.statusText}`);
        state.chats = await response.json();
        renderChatList();
    } catch (error) {
        console.error('Error fetching chats:', error);
        state.chats = [];
        renderChatList();
    }
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

        item.addEventListener('click', async () => { // Make the handler async
            if (state.currentChatId !== chat.chat_id) {
                try {
                    // Wait for the chat to load completely
                    await loadChat(chat.chat_id);

                    // After loadChat is done and the messages are rendered,
                    // scroll to the bottom instantly.
                    requestAnimationFrame(() => {
                        scrollToBottom('auto'); // Use 'auto' for instant scroll
                    });

                } catch (error) {
                    // Handle potential errors from loadChat if necessary
                    console.error(`Error loading chat ${chat.chat_id} from sidebar click:`, error);
                    // Optionally display an error to the user here
                    addSystemMessage(`Failed to load chat: ${error.message}`, "error");
                }
            }
            // If it's the same chat, do nothing (no scroll needed)
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
    state.followOutput = true; // Default to following on new chat load
    state.toolCallPending = false;
    state.toolContinuationContext = null;

    // Reset code block default when loading a chat - REMOVED THIS LINE:
    // state.codeBlocksDefaultCollapsed = false; // <<< REMOVE THIS LINE >>>
    // The global button state should persist for the loaded chat session.
    updateCodeblockToggleButton(); // Still update global button state based on current state

    if (state.streamController && !state.streamController.signal.aborted) {
        console.log("Aborting active stream before loading new chat.");
        state.streamController.abort();
        cleanupAfterGeneration();
    }

    try {
        const response = await fetch(`${API_BASE}/chat/${chatId}`);
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

        localStorage.setItem('lastChatId', chatId);
        document.getElementById('character-select').value = state.currentCharacterId || '';
        updateCharacterActionButtons();

        if (state.currentCharacterId) {
             try {
                  const charResponse = await fetch(`${API_BASE}/chat/get_character/${state.currentCharacterId}`);
                  if (charResponse.ok) {
                       const activeChar = await charResponse.json();
                       state.activeSystemPrompt = activeChar?.sysprompt || null;
                  } else {
                        console.warn(`Failed to fetch character ${state.currentCharacterId} details. Character might be deleted.`);
                        state.currentCharacterId = null;
                        document.getElementById('character-select').value = '';
                        updateCharacterActionButtons();
                  }
             } catch (charError) {
                console.error("Error fetching character details:", charError);
                state.currentCharacterId = null;
                document.getElementById('character-select').value = '';
                updateCharacterActionButtons();
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
             // renderActiveMessages will now respect the *current* state.codeBlocksDefaultCollapsed
             // because we didn't reset it above.
             renderActiveMessages();
             adjustTextareaHeight();
        }

    } catch (error) {
        console.error('Error loading chat:', error);
        messagesWrapper.innerHTML = `<div class="system-message error">Failed to load chat: ${error.message}</div>`;
        welcomeContainer.style.display = 'none';
        document.body.classList.remove('welcome-active');
        state.currentChatId = null;
        document.getElementById('character-select').value = '';
        updateCharacterActionButtons();
        highlightCurrentChatInSidebar();
    } finally {
        requestAnimationFrame(updateScrollButtonVisibility);
    }
}

function renderActiveMessages() {
    messagesWrapper.innerHTML = ''; // Clear previous render
    state.activeBranchInfo = {}; // Reset derived branch info

    if (!state.messages || state.messages.length === 0) {
        console.log("No messages to render.");
        return; // Welcome screen handled by caller
    }

    // --- Step 1: Build Tree Structure (No Change Needed) ---
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

    // --- Step 2: Render all messages in the active branch initially ---
    function renderBranch(messageNode) { // No Change Needed
        if (!messageNode || messageNode.role === 'system') return;
        addMessage(messageNode); // Creates separate rows for each DB message initially
        const children = messageNode.children;
        if (children && children.length > 0) {
            const activeIndex = messageNode.active_child_index ?? 0;
            const safeActiveIndex = Math.min(Math.max(0, activeIndex), children.length - 1);
            const activeChildNode = children[safeActiveIndex];
            if (activeChildNode) { renderBranch(activeChildNode); }
            else { console.warn(`Could not find active child at index ${safeActiveIndex}...`); }
        }
    }
    rootMessages.forEach(rootNode => renderBranch(rootNode));

    // --- Step 3: Post-processing: Merge sequential Assistant/Tool rows ---
    const allRows = Array.from(messagesWrapper.querySelectorAll('.message-row'));
    const rowsToRemove = new Set(); // Use a Set to automatically handle duplicates
    let currentMergeTargetRow = null; // The first assistant row in a sequence
    let accumulatedContentHTML = ''; // To store HTML from subsequent rows

    for (let i = 0; i < allRows.length; i++) {
        const currentRow = allRows[i];
        const isAssistant = currentRow.classList.contains('assistant-row');
        const isTool = currentRow.classList.contains('tool-row');
        const isUser = currentRow.classList.contains('user-row');

        if (isAssistant || isTool) {
            if (!currentMergeTargetRow) {
                // This is the FIRST assistant/tool message after a user message (or start)
                // This becomes the row we merge INTO.
                if (isAssistant) { // Only start merging with an assistant row
                   currentMergeTargetRow = currentRow;
                   accumulatedContentHTML = ''; // Reset accumulator
                   console.log(`Starting merge sequence with target: ${currentRow.dataset.messageId}`);
                }
                // If the first non-user message is a tool message, something is odd, don't merge.
            } else {
                // This is a SUBSEQUENT assistant or tool message in the sequence.
                // Add its content to the accumulator and mark it for removal.
                const contentDiv = currentRow.querySelector('.message-content');
                if (contentDiv) {
                     // We directly append the innerHTML, preserving blocks like tool calls/results
                     accumulatedContentHTML += contentDiv.innerHTML;
                     console.log(`Accumulating content from: ${currentRow.dataset.messageId}`);
                }
                rowsToRemove.add(currentRow);
            }
        }

        // If we hit a user message OR the end of messages, AND we have a merge target,
        // finalize the merge for the previous sequence.
        if ((isUser || i === allRows.length - 1) && currentMergeTargetRow) {
            if (accumulatedContentHTML) {
                const targetContentDiv = currentMergeTargetRow.querySelector('.message-content');
                if (targetContentDiv) {
                    console.log(`Finalizing merge into target: ${currentMergeTargetRow.dataset.messageId}`);
                    // Append all accumulated HTML
                    targetContentDiv.insertAdjacentHTML('beforeend', accumulatedContentHTML);
                } else {
                     console.warn(`Target merge row ${currentMergeTargetRow.dataset.messageId} missing content div.`);
                }
            } else {
                 console.log(`No accumulated content to merge into target: ${currentMergeTargetRow.dataset.messageId}`);
            }
            // Reset for the next potential sequence (which might start with the current user row)
            currentMergeTargetRow = null;
            accumulatedContentHTML = '';
        }

        // If the current row is User, ensure any merge sequence is reset
        if (isUser) {
            currentMergeTargetRow = null;
            accumulatedContentHTML = '';
        }
    }

    // --- Step 4: Remove the merged rows from the DOM ---
    rowsToRemove.forEach(row => row.remove());
    if (rowsToRemove.size > 0) {
       console.log(`Removed ${rowsToRemove.size} rows after merging.`);
    }

    // --- Step 5: Final post-processing (code block highlighting on potentially modified content) ---
    requestAnimationFrame(() => {
         messagesWrapper.querySelectorAll('.message-content pre code').forEach(block => {
            highlightRenderedCode(block.closest('pre'));
         });
    });
}

/**
 * Forces a specific code block wrapper element into the desired collapsed/expanded state.
 * @param {HTMLElement} wrapper - The .code-block-wrapper element.
 * @param {boolean} shouldBeCollapsed - True to collapse, false to expand.
 */
function setCodeBlockCollapsedState(wrapper, shouldBeCollapsed) {
    if (!wrapper) return;

    const preElement = wrapper.querySelector('pre');
    const collapseInfoSpan = wrapper.querySelector('.collapse-info');
    const collapseBtn = wrapper.querySelector('.collapse-btn');
    const icon = collapseBtn?.querySelector('i');

    if (!preElement || !collapseInfoSpan || !collapseBtn || !icon) {
        // console.warn("setCodeBlockCollapsedState: Missing elements in wrapper", wrapper);
        return; // Don't proceed if elements are missing
    }

    const isCurrentlyCollapsed = wrapper.classList.contains('collapsed');

    // Only act if the state needs changing
    if (shouldBeCollapsed && !isCurrentlyCollapsed) {
        // Collapse it
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
        // Expand it
        wrapper.classList.remove('collapsed');
        icon.className = 'bi bi-chevron-up';
        collapseBtn.title = 'Collapse code';
        collapseInfoSpan.style.display = 'none';
        preElement.style.display = '';
    }
}

/**
 * Updates the global code block toggle button's icon and title
 * based on the current state.codeBlocksDefaultCollapsed value.
 */
function updateCodeblockToggleButton() {
    const button = document.getElementById('toggle-codeblocks-btn');
    if (!button) return;
    const icon = button.querySelector('i');
    if (!icon) return;
    
    button.classList.toggle('active', state.codeBlocksDefaultCollapsed);

    if (state.codeBlocksDefaultCollapsed) {
        // Default is COLLAPSED, button should show EXPAND action
        icon.className = 'bi bi-arrows-expand';
        button.title = 'Expand All Code Blocks (Default)';
    } else {
        // Default is EXPANDED, button should show COLLAPSE action
        icon.className = 'bi bi-arrows-collapse';
        button.title = 'Collapse All Code Blocks (Default)';
    }
}

/**
 * Sets up the event listener for the global code block toggle button.
 */
function setupCodeblockToggle() {
    const button = document.getElementById('toggle-codeblocks-btn');
    if (!button) {
        console.error("Global code block toggle button not found!");
        return;
    }

    button.addEventListener('click', () => {
        // 1. Toggle the state variable
        state.codeBlocksDefaultCollapsed = !state.codeBlocksDefaultCollapsed;
        console.log("Code block default collapsed state toggled to:", state.codeBlocksDefaultCollapsed);

        // 2. Update the button's appearance
        updateCodeblockToggleButton();

        // 3. Apply the new default state to all *existing* code blocks
        const allCodeBlocks = messagesWrapper.querySelectorAll('.code-block-wrapper');
        console.log(`Applying new default state to ${allCodeBlocks.length} existing code blocks.`);
        allCodeBlocks.forEach(block => {
            setCodeBlockCollapsedState(block, state.codeBlocksDefaultCollapsed);
        });

        // Optional: If persistence per chat across sessions is desired, save state here
        // e.g., localStorage.setItem(`chat_${state.currentChatId}_codeCollapsed`, state.codeBlocksDefaultCollapsed);
    });

    // Set initial button state (important if page loaded with a non-default state somehow)
    updateCodeblockToggleButton();
}

/**
 * Takes a <pre> element generated by marked.js, extracts its content and language,
 * and replaces it with a new structure including a header with language and copy button.
 * Applies the current default collapsed state from state.codeBlocksDefaultCollapsed.
 * Event listeners are NOT attached here; they are handled by delegation.
 * @param {HTMLPreElement} preElement - The original <pre> element.
 */
function enhanceCodeBlock(preElement) {
    const codeElement = preElement.querySelector('code');
    if (!codeElement) return;

    const codeText = codeElement.textContent || '';
    const langClass = Array.from(codeElement.classList).find(cls => cls.startsWith('language-'));
    const lang = langClass ? langClass.substring(9) : '';

    // --- Check the current default state ---
    const isInitiallyCollapsed = state.codeBlocksDefaultCollapsed; // Read from global state

    // --- Create the new wrapper structure ---
    const wrapper = document.createElement('div');
    // Apply 'collapsed' class based on the default state
    wrapper.className = `code-block-wrapper ${isInitiallyCollapsed ? 'collapsed' : ''}`;
    wrapper.dataset.rawCode = codeText;

    // Header
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
    // Set initial icon and title based on default state
    collapseBtn.innerHTML = `<i class="bi bi-chevron-${isInitiallyCollapsed ? 'down' : 'up'}"></i>`;
    collapseBtn.title = isInitiallyCollapsed ? 'Expand code' : 'Collapse code';

    const collapseInfoSpan = document.createElement('span');
    collapseInfoSpan.className = 'collapse-info';
    // Set initial info text and display based on default state
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
    copyBtn.innerHTML = '<i class="bi bi-clipboard"></i> Copy';
    copyBtn.title = 'Copy code';
    actionsDiv.appendChild(copyBtn);
    header.appendChild(actionsDiv);

    // --- Create new PRE and CODE elements for highlighting ---
    const newPre = document.createElement('pre');
    // Set initial display state based on default
    newPre.style.display = isInitiallyCollapsed ? 'none' : '';
    const newCode = document.createElement('code');
    if (lang) {
        newCode.className = `language-${lang}`;
    }
    newCode.textContent = codeText;

    try {
        hljs.highlightElement(newCode);
    } catch (e) {
        console.error("Error highlighting enhanced code block:", e);
    }

    newPre.appendChild(newCode);
    wrapper.appendChild(header);
    wrapper.appendChild(newPre);

    // --- Replace the original pre element ---
    preElement.replaceWith(wrapper);
}

function buildContentHtml(targetContentDiv, messageText, isStreaming = false) {
    const textToParse = messageText || '';
    const thinkBlockTempId = 'streaming-think-block';
    const remainingContentTempId = 'streaming-remaining-content'; // ID for content after think block

    // --- Handle Think Block Messages ---
    if (textToParse.trim().startsWith('<think>')) {
        const { thinkContent, remainingText } = parseThinkContent(textToParse);
        let existingThinkBlock = null;
        let thinkBlockWasCollapsed = true; // Default assumption

        if (isStreaming) {
            existingThinkBlock = targetContentDiv.querySelector(`.think-block[data-temp-id="${thinkBlockTempId}"]`);
            if (existingThinkBlock) {
                thinkBlockWasCollapsed = existingThinkBlock.classList.contains('collapsed');
            }
        }

        if (isStreaming && existingThinkBlock) {
            // --- Targeted Update (Think Block Exists) ---
            const existingThinkContentDiv = existingThinkBlock.querySelector('.think-content');
            if (existingThinkContentDiv) {
                const newThinkHtml = marked.parse(thinkContent || '');
                if (existingThinkContentDiv.innerHTML !== newThinkHtml) {
                    existingThinkContentDiv.innerHTML = newThinkHtml;
                }
            } else {
                 console.warn("Streaming update: Could not find existing .think-content for targeted update.");
            }

            // --- Handle Remaining Text (After Think Block) During Streaming ---
            let existingRemainingContentDiv = targetContentDiv.querySelector(`div[data-temp-id="${remainingContentTempId}"]`);
            if (remainingText || existingRemainingContentDiv) {
                 if (!existingRemainingContentDiv) {
                      existingRemainingContentDiv = document.createElement('div');
                      existingRemainingContentDiv.dataset.tempId = remainingContentTempId;
                      targetContentDiv.appendChild(existingRemainingContentDiv);
                 }
                 const newRemainingHtml = renderMarkdown(remainingText, true, null);
                 if (existingRemainingContentDiv.innerHTML !== newRemainingHtml) {
                      existingRemainingContentDiv.innerHTML = newRemainingHtml;
                 }
            }

        } else {
            // --- Full Redraw (Not streaming, or first chunk of think block) ---
            const fullRenderedHtml = renderMarkdown(textToParse, thinkBlockWasCollapsed, isStreaming ? thinkBlockTempId : null);
            targetContentDiv.innerHTML = fullRenderedHtml;
            if (isStreaming) {
                const newlyRenderedThinkBlock = targetContentDiv.querySelector('.think-block');
                if (newlyRenderedThinkBlock && !newlyRenderedThinkBlock.dataset.tempId) {
                    newlyRenderedThinkBlock.dataset.tempId = thinkBlockTempId;
                }
                const thinkBlock = targetContentDiv.querySelector('.think-block');
                const potentialRemainingDiv = thinkBlock?.nextElementSibling;
                if (potentialRemainingDiv && potentialRemainingDiv.tagName === 'DIV' && !potentialRemainingDiv.dataset.tempId && remainingText) {
                     potentialRemainingDiv.dataset.tempId = remainingContentTempId;
                }
            }
        }
    }
    // --- Handle Non-Think Block Messages OR Text After Tool Tags ---
    else {
        // Store existing code block states before clearing (if needed for preserving manual toggles - not doing this yet)
        // For now, we rely on re-applying the default state after render.

        targetContentDiv.innerHTML = ''; // Clear previous content

        // --- Separate Tool Tags from Text ---
        let lastIndex = 0;
        const segments = [];
        TOOL_TAG_REGEX.lastIndex = 0;
        let match;
        while ((match = TOOL_TAG_REGEX.exec(textToParse)) !== null) {
            const textBefore = textToParse.substring(lastIndex, match.index);
            if (textBefore) { segments.push({ type: 'text', data: textBefore }); }
            const toolCallTag = match[1]; const toolResultTag = match[4];
            if (toolCallTag) {
                const toolName = match[2]; const attrsString = match[3] || "";
                segments.push({ type: 'tool', data: { name: toolName, args: parseAttributes(attrsString) } });
            } else if (toolResultTag) {
                const toolName = match[5]; let resultString = match[6] || "";
                 try { resultString = resultString.replace(/"/g, '"'); } catch(e) { console.warn("Error decoding result string", e)}
                segments.push({ type: 'result', data: resultString });
            }
            lastIndex = TOOL_TAG_REGEX.lastIndex;
        }
        const remainingText = textToParse.substring(lastIndex);
        if (remainingText) { segments.push({ type: 'text', data: remainingText }); }

        // --- Render Segments ---
        segments.forEach(segment => {
            if (segment.type === 'text') {
                // renderMarkdown calls enhanceCodeBlock, which uses the default state
                targetContentDiv.insertAdjacentHTML('beforeend', renderMarkdown(segment.data, true, null));
            } else if (segment.type === 'tool') {
                renderToolCallPlaceholder(targetContentDiv, segment.data.name, segment.data.args);
            } else if (segment.type === 'result') {
                renderToolResult(targetContentDiv, segment.data);
            }
        });
    }

    // --- Apply Default Code Block State AFTER Rendering ---
    // This ensures that even if innerHTML was replaced, the code blocks
    // within the target div conform to the current default setting.
    applyCodeBlockDefaults(targetContentDiv);

    // Highlighting is handled separately after this function returns in the stream handler
}

/**
 * Finds all code block wrappers within a given container element
 * and applies the current default collapsed state from state.codeBlocksDefaultCollapsed.
 * @param {HTMLElement} containerElement - The parent element to search within.
 */
function applyCodeBlockDefaults(containerElement) {
    if (!containerElement) return;
    const codeBlocks = containerElement.querySelectorAll('.code-block-wrapper');
    // console.log(`Applying default state (${state.codeBlocksDefaultCollapsed ? 'collapsed' : 'expanded'}) to ${codeBlocks.length} blocks in container.`);
    codeBlocks.forEach(block => {
        // Use the existing helper to set the state based on the global default
        setCodeBlockCollapsedState(block, state.codeBlocksDefaultCollapsed);
    });
}

/**
 * Handles the click on the "Generate" or "Regenerate Response" button on a user message.
 * Determines whether to simply generate a new response or replace an existing one.
 * @param {string} userMessageId - The ID of the user message triggering the action.
 */
async function handleGenerateOrRegenerateFromUser(userMessageId) {
    const currentChatId = state.currentChatId;
    // Use generation state flag check
    if (!currentChatId || document.getElementById('send-button').disabled) {
        addSystemMessage("Cannot generate while busy.", "warning");
        return;
    }

    const userMessage = state.messages.find(m => m.message_id === userMessageId);
    if (!userMessage || userMessage.role !== 'user') {
        addSystemMessage("Invalid target message for generation.", "error");
        return;
    }

    // Always use the currently selected model from the UI
    const modelNameToUse = modelSelect.value;
    if (!modelNameToUse) {
        addSystemMessage("Please select a model before generating.", "error");
        return;
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
            // --- Regenerate Logic (Replace existing response) ---
            if (!confirm("This will delete the existing response and generate a new one. Proceed?")) {
                return;
            }
            console.log(`Regenerating response for user message ${userMessageId}. Replacing existing branch.`);

            // Find the direct active child (assistant message)
            const childMessage = state.messages.find(m =>
                m.parent_message_id === userMessageId &&
                m.role === 'llm' && // Assuming direct child is 'llm'
                userMessage.child_message_ids?.includes(m.message_id) && // Check it's a known child
                (userMessage.active_child_index === undefined || userMessage.child_message_ids[userMessage.active_child_index ?? 0] === m.message_id) // Check if it's the active one
            );

            if (childMessage) {
                const childMessageIdToDelete = childMessage.message_id;
                console.log(`Found child message ${childMessageIdToDelete} to delete.`);
                // 1. Remove visually first
                removeMessageAndDescendantsFromDOM(childMessageIdToDelete);
                // 2. Delete from backend
                const deleteSuccess = await deleteMessageFromBackend(currentChatId, childMessageIdToDelete);
                if (!deleteSuccess) {
                    throw new Error("Failed to delete existing message branch before regenerating.");
                }
                // State will be updated by loadChat after generation completes/errors
            } else {
                console.warn(`Could not find the active assistant message following ${userMessageId} to replace. Proceeding to generate.`);
                // If no child found (e.g., data inconsistency or deleted previously), just generate.
            }
        } else {
            // --- Generate Logic (Message is last) ---
            console.log(`Generating new response for last user message ${userMessageId}.`);
            // No deletion needed.
        }

        // --- Create Placeholder & Start Generation (Common Logic) ---
        assistantPlaceholderRow = createPlaceholderMessageRow(`temp_assistant_${Date.now()}`, userMessageId);
        // Insert placeholder immediately after the user message row
        userMessageRow.insertAdjacentElement('afterend', assistantPlaceholderRow);

        const assistantContentDiv = assistantPlaceholderRow.querySelector('.message-content');
        if (!assistantContentDiv) {
             assistantPlaceholderRow?.remove();
             throw new Error("Failed to create assistant response placeholder element.");
        }
        scrollToBottom('smooth');

        // Start generation - this will save the new message(s) and trigger loadChat on completion/error
        await generateAssistantResponse(
            userMessageId, // Parent is the user message itself
            assistantContentDiv,
            modelNameToUse,
            defaultGenArgs,
            state.toolsEnabled
        );
        // NOTE: loadChat inside generateAssistantResponse's callbacks will handle the final UI update and state refresh.

    } catch (error) {
        console.error(`Error during generate/regenerate from user message ${userMessageId}:`, error);
        addSystemMessage(`Generation failed: ${error.message}`, "error");
        assistantPlaceholderRow?.remove(); // Remove placeholder on error
        // Consider reloading the chat to revert to a consistent state on failure
        try { await loadChat(currentChatId); } catch(e) {
            console.error("Failed to reload chat after generation error:", e);
        }
        cleanupAfterGeneration(); // Use standard cleanup
    }
}

/**
 * Handles the "Save & Send" button click during user message editing.
 * Saves the edit, then triggers handleGenerateOrRegenerateFromUser.
 * @param {string} userMessageId - The ID of the user message being edited.
 * @param {HTMLTextAreaElement} textareaElement - The textarea containing the edited text.
 */
async function handleSaveAndSend(userMessageId, textareaElement) {
    const newText = textareaElement.value.trim();
    const originalMessage = state.messages.find(m => m.message_id === userMessageId);

    if (!originalMessage || originalMessage.role !== 'user') {
        console.error("handleSaveAndSend: Invalid original message or not a user message.");
        return;
    }

    // Disable buttons temporarily to prevent double clicks
    const buttonContainer = textareaElement.closest('.edit-buttons');
    const buttons = buttonContainer?.querySelectorAll('button');
    buttons?.forEach(btn => btn.disabled = true);

    try {
        console.log(`Save & Send: Saving edit for user message ${userMessageId}`);
        // Call saveEdit (assuming it reloads the chat on success)
        // Modify saveEdit to return success status if not already doing so.
        const saveSuccess = await saveEdit(userMessageId, newText, 'user', false); // Pass flag to NOT reload automatically

        if (saveSuccess) {
            console.log(`Save & Send: Edit saved successfully. Now triggering generation for ${userMessageId}.`);

            // Manually update the DOM to remove editing controls after successful save
            const messageRow = messagesWrapper.querySelector(`.message-row[data-message-id="${userMessageId}"]`);
            const contentDiv = messageRow?.querySelector('.message-content');
            const actionsDiv = messageRow?.querySelector('.message-actions');

            if (contentDiv) {
                contentDiv.classList.remove('editing');
                contentDiv.innerHTML = renderMarkdown(newText); // Render the new markdown
                contentDiv.dataset.raw = newText; // Update raw dataset
                // Re-run highlighting/enhancements
                 contentDiv.querySelectorAll('pre code').forEach(block => {
                     highlightRenderedCode(block.closest('pre'));
                 });
            }
             if (actionsDiv) actionsDiv.style.display = ''; // Restore actions visibility


            // Update local state message text (since we skipped reload in saveEdit)
            const msgIndex = state.messages.findIndex(m => m.message_id === userMessageId);
            if (msgIndex > -1) {
                 state.messages[msgIndex].message = newText;
            }

            // Now trigger the generate/regenerate logic using the updated message ID
            // This function will handle deleting subsequent branches if necessary based on the *current* state.
            await handleGenerateOrRegenerateFromUser(userMessageId);
        } else {
             // Save failed, re-enable buttons
             buttons?.forEach(btn => btn.disabled = false);
             addSystemMessage("Failed to save changes before sending.", "error");
        }

    } catch (error) {
        console.error('Error during Save & Send:', error);
        addSystemMessage(`Error: ${error.message}`, "error");
        // Re-enable buttons on error
        buttons?.forEach(btn => btn.disabled = false);
        // Optionally restore textarea content? Or leave as is for user to retry.
    }
    // Note: cleanupAfterGeneration() is handled within handleGenerateOrRegenerateFromUser if generation starts/fails.
}

// --- addMessage (MODIFIED for User Generate/Regen Button and Tool Role Rendering) ---
function addMessage(message) {
    if (message.role === 'system') return null;

    // Map llm to assistant for CSS/logic consistency, keep tool as tool
    const role = message.role === 'llm' ? 'assistant' : message.role; // 'user', 'assistant', or 'tool'
    const messageRow = document.createElement('div');
    // Add specific class for tool messages for potential styling
    messageRow.className = `message-row ${role}-row ${role === 'tool' ? 'tool-message' : ''}`;
    messageRow.dataset.messageId = message.message_id;
    if (message.parent_message_id) {
        messageRow.dataset.parentId = message.parent_message_id;
    }

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.dataset.raw = message.message || ''; // Store raw message

    const avatarActionsDiv = document.createElement('div');
    avatarActionsDiv.className = 'message-avatar-actions';
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'message-actions';

    // Branch Navigation Logic (unchanged)
    const branchInfo = state.activeBranchInfo[message.message_id];
    if (branchInfo && branchInfo.totalBranches > 1) {
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

    // Standard Action Buttons (Hide some for 'tool' role)
    const copyBtn = document.createElement('button');
    copyBtn.className = 'message-action-btn';
    copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>';
    copyBtn.title = 'Copy message text';
    copyBtn.addEventListener('click', () => copyMessageContent(contentDiv, copyBtn));
    actionsDiv.appendChild(copyBtn);

    // Edit button - Hide for tool results
    const editBtn = document.createElement('button');
    editBtn.className = 'message-action-btn';
    editBtn.innerHTML = '<i class="bi bi-pencil"></i>';
    editBtn.title = 'Edit message';
    editBtn.addEventListener('click', () => startEditing(message.message_id));
    if (role !== 'tool') { // Hide Edit for tool messages
        actionsDiv.appendChild(editBtn);
    }

    // --- ADDED: Generate/Regenerate Button for User Messages ---
    if (role === 'user') {
        const isLastMessage = findLastActiveMessageId(state.messages) === message.message_id;
        const genRegenBtn = document.createElement('button');
        genRegenBtn.className = 'message-action-btn';
        genRegenBtn.onclick = () => handleGenerateOrRegenerateFromUser(message.message_id);

        if (isLastMessage) {
            genRegenBtn.innerHTML = '<i class="bi bi-play-circle"></i>'; // Icon for "Generate"
            genRegenBtn.title = 'Generate response to this message';
        } else {
            genRegenBtn.innerHTML = '<i class="bi bi-arrow-repeat"></i>'; // Icon for "Regenerate"
            genRegenBtn.title = 'Regenerate response (Replace existing)';
        }
        actionsDiv.appendChild(genRegenBtn);
    }
    // --- END ADDED ---


    // Assistant-specific buttons
    if (role === 'assistant') {
        const regenerateBtn = document.createElement('button');
        regenerateBtn.className = 'message-action-btn';
        regenerateBtn.innerHTML = '<i class="bi bi-arrow-repeat"></i>';
        regenerateBtn.title = 'Regenerate this response (Replace)';
        regenerateBtn.addEventListener('click', () => regenerateMessage(message.message_id, false));
        actionsDiv.appendChild(regenerateBtn);

        const branchBtn = document.createElement('button');
        branchBtn.className = 'message-action-btn';
        branchBtn.innerHTML = '<i class="bi bi-diagram-3"></i>';
        branchBtn.title = 'Regenerate as new branch';
        branchBtn.addEventListener('click', () => regenerateMessage(message.message_id, true));
        actionsDiv.appendChild(branchBtn);

        const continueBtn = document.createElement('button');
        continueBtn.className = 'message-action-btn';
        continueBtn.innerHTML = '<i class="bi bi-arrow-bar-right"></i>';
        continueBtn.title = 'Continue generating this response';
        continueBtn.addEventListener('click', () => continueMessage(message.message_id));
        actionsDiv.appendChild(continueBtn);
    }

    // Delete button - Show for all roles
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'message-action-btn delete-btn';
    deleteBtn.innerHTML = '<i class="bi bi-trash"></i>';
    deleteBtn.title = 'Delete message (and descendants)';
    deleteBtn.addEventListener('click', () => deleteMessage(message.message_id));
    actionsDiv.appendChild(deleteBtn);


    // --- Render Content based on Role ---
    if (role === 'user') {
        contentDiv.innerHTML = renderMarkdown(message.message || '');
    } else if (role === 'assistant') {
        buildContentHtml(contentDiv, message.message);
    } else if (role === 'tool') {
        renderToolResult(contentDiv, message.message || '[Empty Tool Result]');
    }

    messageDiv.appendChild(contentDiv);

    contentDiv.querySelectorAll('pre code').forEach(block => {
       highlightRenderedCode(block.closest('pre'));
    });

    // --- Attachments Display (Append to contentDiv) ---
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

    // --- Final Assembly ---
    avatarActionsDiv.appendChild(actionsDiv); // Add actions below content
    messageDiv.appendChild(avatarActionsDiv);
    messageRow.appendChild(messageDiv);
    messagesWrapper.appendChild(messageRow);

    return contentDiv; // Return the main content div
}


async function setActiveBranch(parentMessageId, newIndex) {
     console.log(`Setting active branch for parent ${parentMessageId} to index ${newIndex}`);
     if (!state.currentChatId) return;

     try {
         const response = await fetch(`${API_BASE}/chat/${state.currentChatId}/set_active_branch/${parentMessageId}`, {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ child_index: newIndex })
         });
         if (!response.ok) {
             const errorData = await response.json().catch(() => ({ detail: response.statusText }));
             throw new Error(`Failed to set active branch: ${errorData.detail || response.statusText}`);
         }

         // *** Reload chat state from backend to reflect the change ***
         await loadChat(state.currentChatId);

     } catch (error) {
         console.error('Error setting active branch:', error);
         alert(`Failed to switch branch: ${error.message}`);
     }
}

async function deleteMessage(messageId) {
    if (!state.currentChatId) return;

    const messageToDelete = state.messages.find(m => m.message_id === messageId);
    if (!messageToDelete) {
        console.warn(`Message ${messageId} not found in state for deletion.`);
        return;
    }

    // Check if this message has a tool message child
    const hasToolChild = state.messages.some(m => m.parent_message_id === messageId && m.role === 'tool');
    const baseText = messageToDelete.message?.substring(0, 80) || `message ID ${messageId}`;
    let confirmMessage = `Are you sure you want to delete this message and all its subsequent responses/branches?\n"${baseText}..."`;

    if (hasToolChild) {
        confirmMessage = `Are you sure you want to delete this message, the associated tool action(s), and any subsequent response? This affects the entire sequence.\n"${baseText}..."`;
    }

    if (!confirm(confirmMessage)) {
        return;
    }

    console.log(`Deleting message ${messageId} and descendants (cascade handled by backend).`);

    try {
        // Backend DELETE handles cascade based on parent_message_id foreign key constraints
        const response = await fetch(`${API_BASE}/chat/${state.currentChatId}/delete_message/${messageId}`, {
            method: 'POST' // Assuming POST based on previous setup, adjust if DELETE
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ detail: response.statusText }));
            throw new Error(`Failed to delete message: ${errorData.detail || response.statusText}`);
        }

        // Reload the chat to reflect the deletion across the entire branch
        await loadChat(state.currentChatId);
        await fetchChats(); // Update sidebar as well

    } catch (error) {
        console.error('Error deleting message:', error);
        alert(`Failed to delete message: ${error.message}`);
        // Optionally reload chat even on error to ensure consistency with backend state
        try { await loadChat(state.currentChatId); } catch(e) {}
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

    // --- Prevent Editing Tool/Merged Messages ---
    if (message.role === 'tool') {
         alert("Cannot edit tool result messages.");
         return;
    }
    // Check if this assistant message initiated a tool call sequence
    const hasToolChild = state.messages.some(m => m.parent_message_id === messageId && m.role === 'tool');
    if ((message.role === 'llm' || message.role === 'assistant') && (hasToolChild || contentDiv.querySelector('.tool-call-block'))) {
        alert("Editing messages that involve tool execution is not currently supported.");
        return;
    }
    // --- End Prevention ---

    const originalContentHTML = contentDiv.innerHTML;
    const originalActionsDisplay = actionsDiv ? actionsDiv.style.display : '';
    // Hide tool blocks if they exist
    const toolBlocks = messageRow.querySelectorAll('.tool-call-block, .tool-result-block'); // Combined selector

    contentDiv.classList.add('editing');
    if (actionsDiv) actionsDiv.style.display = 'none';
    toolBlocks.forEach(el => el.style.display = 'none'); // Hide tool blocks during edit
    contentDiv.innerHTML = ''; // Clear current content

    const textarea = document.createElement('textarea');
    textarea.className = 'edit-textarea';
    // Use dataset.raw which should hold the *original* text of just this part
    // Fallback to message.message if dataset isn't populated correctly
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
        contentDiv.innerHTML = originalContentHTML; // Restore original rendered HTML
        if (actionsDiv) actionsDiv.style.display = originalActionsDisplay;
        toolBlocks.forEach(el => el.style.display = ''); // Restore tool block display
        // Re-run highlighting and code block enhancement
        contentDiv.querySelectorAll('pre:not(.code-block-wrapper pre)').forEach(pre => {
            const code = pre.querySelector('code');
            if (code) enhanceCodeBlock(pre); // Use the enhance function
        });
        contentDiv.querySelectorAll('.code-block-wrapper code:not(.hljs)').forEach(code => {
             try { hljs.highlightElement(code); } catch(e) {} // Re-highlight if needed
        });
    };

    buttonContainer.appendChild(saveButton);

    // --- ADDED: Save & Send Button for User Messages ---
    if (message.role === 'user') {
        const saveAndSendButton = document.createElement('button');
        saveAndSendButton.innerHTML = '<i class="bi bi-send-check"></i> Save & Send'; // Or "Save & Regenerate"
        saveAndSendButton.className = 'btn-secondary'; // Style as secondary or primary as preferred
        saveAndSendButton.title = 'Save changes and generate a new response';
        // Use the new handler, passing the textarea element directly
        saveAndSendButton.onclick = () => handleSaveAndSend(messageId, textarea);
        buttonContainer.appendChild(saveAndSendButton);
    }
    // --- END ADDED ---

    buttonContainer.appendChild(cancelButton);

    contentDiv.appendChild(textarea);
    contentDiv.appendChild(buttonContainer);

    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
}


/**
 * Saves an edited message to the backend.
 * @param {string} messageId - The ID of the message to edit.
 * @param {string} newText - The new message text content.
 * @param {string} role - The role of the message ('user' or 'assistant').
 * @param {boolean} [reloadChat=true] - Whether to reload the chat state after saving.
 * @returns {Promise<boolean>} True if the save was successful, false otherwise.
 */
async function saveEdit(messageId, newText, role, reloadChat = true) {
    const originalMessage = state.messages.find(m => m.message_id === messageId);
    if (!originalMessage) return false; // Indicate failure

   console.log(`Saving edit for message ${messageId}. Reload chat: ${reloadChat}`);

   // Preserve original attachments when editing text
   const attachmentsForSave = (originalMessage.attachments || []).map(att => ({
       type: att.type,
       content: att.content,
       name: att.name
   }));
   const toolCallsForSave = originalMessage.tool_calls || null;

   try {
       const response = await fetch(`${API_BASE}/chat/${state.currentChatId}/edit_message/${messageId}`, {
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

       // --- Conditional Reload ---
       if (reloadChat && state.currentChatId) {
           await loadChat(state.currentChatId);
       }
       // --- End Conditional Reload ---

       return true; // Indicate success

   } catch (error) {
       console.error('Error editing message:', error);
       alert(`Failed to save changes: ${error.message}`);
       return false; // Indicate failure
   }
}

function copyMessageContent(contentDiv, buttonElement) {
    let textToCopy = '';
    let accumulatedText = ''; // Buffer for text between blocks

    // Iterate through the direct children nodes of the contentDiv
    contentDiv.childNodes.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
            // Append text nodes to the buffer
            accumulatedText += node.textContent;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            // If we encounter a block element, process the accumulated text first
            if (accumulatedText.trim()) {
                textToCopy += accumulatedText + '\n'; // Add accumulated text with a newline
                accumulatedText = ''; // Reset buffer
            }

            // Handle specific element types
            if (node.classList.contains('tool-call-block')) {
                const toolName = node.dataset.toolName || 'unknown_tool';
                const argsElement = node.querySelector('.tool-arguments');
                const argsText = argsElement ? argsElement.textContent.trim() : '{}';
                // Format the tool call representation for copy
                textToCopy += `\n[Tool Call: ${toolName}]\nArguments:\n${argsText}\n\n`;
            } else if (node.classList.contains('tool-result-block')) {
                const resultElement = node.querySelector('.tool-result-content');
                // Use innerText on the result element to better handle potential formatting inside result
                const resultText = resultElement ? resultElement.innerText.trim() : '[No Result Content]';
                 // Format the tool result representation for copy
                 textToCopy += `[Tool Result]\n${resultText}\n\n`;
            } else if (!node.classList.contains('attachments-container') && !node.classList.contains('message-avatar-actions') && !node.closest('.tool-header')) {
                // For other relevant elements (like paragraphs, divs, pre) NOT inside tool headers,
                // add their text content to the buffer. innerText might be better here too.
                accumulatedText += node.innerText || node.textContent;
            }
            // Ignore attachments, action buttons, and elements within tool headers
        }
    });

    // Add any remaining accumulated text at the end
    if (accumulatedText.trim()) {
        textToCopy += accumulatedText;
    }

    textToCopy = textToCopy.trim().replace(/\n{3,}/g, '\n\n'); // Normalize excessive newlines

    // Fallback if structured copy yielded nothing
    if (!textToCopy) {
        console.warn("Structured copy resulted in empty string, falling back to dataset.raw or textContent");
        textToCopy = contentDiv.dataset.raw || contentDiv.textContent || '';
        textToCopy = textToCopy.trim();
    }

    if (!textToCopy) {
        alert("Nothing to copy.");
        return;
    }

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
        alert('Failed to copy text.');
    });
}

// --- Event Listeners Setup ---
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
    sidebarToggle.addEventListener('click', toggleSidebar);
    modelSelect.addEventListener('change', handleModelChange);
    document.addEventListener('paste', handlePaste);

    // --- Delegated Event Listeners ---
    messagesWrapper.addEventListener('click', (event) => {
        // Think Block Toggle
        const thinkToggle = event.target.closest('.think-block-toggle');
        if (thinkToggle) {
            handleThinkBlockToggle(event); // Pass the event
            return; // Stop further processing if handled
        }

        // Tool Block Toggle
        const toolToggle = event.target.closest('.tool-collapse-btn');
         if (toolToggle) {
             handleToolBlockToggle(event); // Pass the event
             return; // Stop further processing
         }

        // Code Block - Copy Button
        const copyBtn = event.target.closest('.code-header-btn.copy-btn');
        if (copyBtn) {
            handleCodeCopy(copyBtn); // Pass the button element
            return;
        }

        // Code Block - Collapse Button
        const collapseBtn = event.target.closest('.code-header-btn.collapse-btn');
        if (collapseBtn) {
            handleCodeCollapse(collapseBtn); // Pass the button element
            return;
        }
    });

    // Settings button now opens theme modal
    document.getElementById('settings-btn').addEventListener('click', () => {
        document.getElementById('theme-modal').style.display = 'flex';
    });
}

function setupToolToggle() {
    // Restore state from localStorage
    const savedToolState = localStorage.getItem('toolsEnabled') === 'true';
    state.toolsEnabled = savedToolState;
    toggleToolsBtn.classList.toggle('active', state.toolsEnabled);
    updateEffectiveSystemPrompt(); // Update prompt based on restored state

    toggleToolsBtn.addEventListener('click', () => {
        state.toolsEnabled = !state.toolsEnabled;
        toggleToolsBtn.classList.toggle('active', state.toolsEnabled);
        localStorage.setItem('toolsEnabled', state.toolsEnabled);
        console.log("Tools enabled:", state.toolsEnabled);
        updateEffectiveSystemPrompt(); // Update the effective system prompt when toggled
        // Optionally add a system message?
        addSystemMessage(`Tool calls ${state.toolsEnabled ? 'enabled' : 'disabled'}.`, 'info');
    });
}


function handleModelChange() {
     updateAttachButtons();
     localStorage.setItem('lastModelName', modelSelect.value);
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
    const inputArea = document.querySelector('.input-area'); // Get the input area element
    const inputAreaHeight = inputArea?.offsetHeight || 0; // Get its current height

    messageInput.style.height = 'auto';
    let newScrollHeight = messageInput.scrollHeight;
    let newHeight = Math.max(initialTextareaHeight, newScrollHeight);
    newHeight = Math.min(newHeight, maxHeight);
    messageInput.style.height = `${newHeight}px`;

    // Adjust padding-bottom on the SCROLLABLE container (.chat-container)
    // to prevent the input area from overlapping the last message when at the bottom.
    // Do not add padding if the welcome screen is active (input area is centered).
    const basePaddingBottom = 100; // Base padding needed when input is at bottom
    const extraPadding = Math.max(0, newHeight - initialTextareaHeight); // Extra padding based on textarea height

    if (chatContainer && !document.body.classList.contains('welcome-active')) {
        // Apply padding only when input is at the bottom
        chatContainer.style.paddingBottom = `${basePaddingBottom + extraPadding}px`;
    } else if (chatContainer) {
        // Remove padding when input is centered
        chatContainer.style.paddingBottom = '0px';
    }
}

function toggleSidebar() {
    const isCollapsed = sidebar.classList.toggle('sidebar-collapsed');
    const icon = sidebarToggle.querySelector('i');
    const textElements = sidebar.querySelectorAll('.sidebar-title span, .new-chat-btn span, .history-item span, .history-title');
    icon.className = `bi bi-chevron-${isCollapsed ? 'right' : 'left'}`;
    document.documentElement.style.setProperty('--sidebar-width', isCollapsed ? '0px' : '260px');
    textElements.forEach(el => {
         el.style.display = isCollapsed ? 'none' : '';
    });
    localStorage.setItem('sidebarCollapsed', isCollapsed);
}

function applySidebarState() {
     const isCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';
     const icon = sidebarToggle.querySelector('i');
     const textElements = sidebar.querySelectorAll('.sidebar-title span, .new-chat-btn span, .history-item span, .history-title');
     if (isCollapsed) {
          sidebar.classList.add('sidebar-collapsed');
          icon.className = `bi bi-chevron-right`;
          textElements.forEach(el => { el.style.display = 'none'; });
          document.documentElement.style.setProperty('--sidebar-width', '0px');
     } else {
          sidebar.classList.remove('sidebar-collapsed');
          icon.className = `bi bi-chevron-left`;
          textElements.forEach(el => { el.style.display = ''; });
          document.documentElement.style.setProperty('--sidebar-width', '260px');
     }
}

function updateAttachButtons() {
    const selectedOption = modelSelect.options[modelSelect.selectedIndex];
    const supportsImages = selectedOption ? selectedOption.dataset.supportsImages === 'true' : false;
    imageButton.style.display = supportsImages ? 'flex' : 'none';
    fileButton.style.display = 'flex';
}

// --- File Handling & Previews ---
function openFileSelector(accept) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true; // Allow multiple files
    input.accept = accept;
    input.addEventListener('change', (e) => {
         if (e.target.files) {
             handleFiles(e.target.files);
         }
    });
    input.click();
}

function handleFiles(files) {
    const selectedOption = modelSelect.options[modelSelect.selectedIndex];
    const supportsImages = selectedOption ? selectedOption.dataset.supportsImages === 'true' : false;

    Array.from(files).forEach(file => {
        if (file.type.startsWith('image/') && supportsImages) {
            processImageFile(file);
        } else if (file.type.startsWith('text/') || /\.(txt|py|js|ts|html|css|json|md|yaml|sql|java|c|cpp|cs|go|php|rb|swift|kt|rs|toml)$/i.test(file.name)) {
            if (file.size > 1 * 1024 * 1024) { // 1MB limit
                 alert(`File "${file.name}" is too large (max 1MB).`);
                 return;
            }
            processTextFile(file);
        } else {
             console.warn(`Unsupported file type: ${file.name} (${file.type})`);
             alert(`Unsupported file type: ${file.name}`);
        }
    });
}

function processImageFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const base64 = e.target.result.split(',')[1];
        const dataUrl = e.target.result;
        // Store base64 along with dataUrl for preview removal
        const imageData = { base64, dataUrl, type: 'image', name: file.name };
        state.currentImages.push(imageData);
        addImagePreview(imageData);
    };
    reader.onerror = (err) => {
         console.error("Error reading image file:", err);
         alert(`Error reading image file: ${file.name}`);
    };
    reader.readAsDataURL(file);
}

function addImagePreview(imageData) {
    const wrapper = document.createElement('div');
    wrapper.className = 'image-preview-wrapper attached-file-preview'; // Common + specific class

    const img = document.createElement('img');
    img.src = imageData.dataUrl;
    img.alt = imageData.name;
    img.className = 'image-preview'; // For styling thumbnail

    const removeButton = createRemoveButton(() => {
        const index = state.currentImages.findIndex(img => img.dataUrl === imageData.dataUrl);
        if (index > -1) state.currentImages.splice(index, 1);
        wrapper.remove();
        adjustTextareaHeight(); // Re-adjust height after removing preview
    });

    wrapper.appendChild(img);
    wrapper.appendChild(removeButton);
    imagePreviewContainer.appendChild(wrapper);
    adjustTextareaHeight(); // Re-adjust height after adding preview
}

function processTextFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const content = e.target.result;
        const filename = file.name;
        // Format for sending to API (include filename and code block)
        const extension = filename.split('.').pop() || 'text';
        const formattedContent = `${filename}:\n\`\`\`${extension}\n${content}\n\`\`\``;
        // Store raw content for potential viewing and formatted for sending
        const fileData = { name: filename, content: formattedContent, type: 'file', rawContent: content };
        state.currentTextFiles.push(fileData);
        addFilePreview(fileData);
    };
     reader.onerror = (err) => {
         console.error("Error reading text file:", err);
         alert(`Error reading text file: ${file.name}`);
    };
    reader.readAsText(file);
}

function addFilePreview(fileData) {
    const wrapper = document.createElement('div');
    wrapper.className = 'file-preview-wrapper attached-file-preview'; // Common + specific class

    const fileInfo = document.createElement('div');
    fileInfo.className = 'file-info'; // Inner div for content if needed by CSS
    fileInfo.innerHTML = `<i class="bi bi-file-earmark-text"></i> <span>${fileData.name}</span>`; // Wrap name in span

    const removeButton = createRemoveButton(() => {
        const index = state.currentTextFiles.findIndex(f => f.name === fileData.name && f.content === fileData.content);
        if (index > -1) state.currentTextFiles.splice(index, 1);
        wrapper.remove();
        adjustTextareaHeight(); // Re-adjust height
    });

    wrapper.appendChild(fileInfo);
    wrapper.appendChild(removeButton);
    imagePreviewContainer.appendChild(wrapper);
    adjustTextareaHeight(); // Re-adjust height
}

// Helper to create standardized remove button
function createRemoveButton(onClickCallback) {
    const removeButton = document.createElement('button');
    removeButton.className = 'remove-attachment'; // Use this class for CSS targeting
    removeButton.innerHTML = '<i class="bi bi-x"></i>';
    removeButton.title = 'Remove attachment';
    removeButton.type = 'button'; // Ensure it doesn't submit forms

    removeButton.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent triggering preview click
        onClickCallback();
    });
    return removeButton;
}

// View attachment in popup
function viewAttachmentPopup(attachment) {
     const popup = document.createElement('div');
     popup.className = 'attachment-popup-overlay';
     popup.addEventListener('click', (e) => {
         if (e.target === popup) popup.remove(); // Close if clicked outside
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
         // Use rawContent if passed, otherwise fallback to stored content (which might be formatted)
         let displayContent = attachment.rawContent !== undefined ? attachment.rawContent : attachment.content;
         // If falling back to formatted content, try parsing it back one last time
          if (attachment.rawContent === undefined && attachment.content) {
              const match = attachment.content.match(/^.*:\n```[^\n]*\n([\s\S]*)\n```$/);
              if (match && match[1]) displayContent = match[1];
          }
          contentElement.textContent = displayContent !== null ? displayContent : "Could not load file content.";
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
    const selectedOption = modelSelect.options[modelSelect.selectedIndex];
    const supportsImages = selectedOption ? selectedOption.dataset.supportsImages === 'true' : false;
    if (!supportsImages) return; // Only handle paste if images are supported

    const items = e.clipboardData.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
            const blob = items[i].getAsFile();
            if (blob) {
                processImageFile(blob);
                e.preventDefault(); // Prevent pasting image data as text
            }
        }
    }
}

// --- Drag and Drop ---
function setupDropZone() {
    const dropZone = document.body; // Or a more specific element

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
            handleFiles(files); // Use the same handler as file input
        }
    });
}

// --- Frontend Generation Logic (MODIFIED for Tool Calls) ---

// Helper to get API key for a provider (uses state populated by backend)
function getApiKey(provider) {
    const lowerProvider = provider.toLowerCase();
    const key = state.apiKeys[lowerProvider];
    // Allow local without key explicitly set
    if (!key && lowerProvider !== 'local') {
        console.warn(`API Key for ${provider} is missing in state.`);
        return null; // Return null if key is missing
    }
    return key;
}

async function streamFromBackend(chatId, parentMessageId, modelName, generationArgs, toolsEnabled, onChunk, onToolStart, onToolEnd, onComplete, onError) {
    console.log(`streamFromBackend called for chat: ${chatId}, parent: ${parentMessageId}, model: ${modelName}, toolsEnabled: ${toolsEnabled}`);

    if (state.streamController && !state.streamController.signal.aborted) {
        console.warn("streamFromBackend: Aborting existing stream controller before starting new stream.");
        state.streamController.abort();
    }
    state.streamController = new AbortController();

    const url = `${API_BASE}/chat/${chatId}/generate`;
    const body = {
        parent_message_id: parentMessageId,
        model_name: modelName,
        generation_args: generationArgs || {},
        tools_enabled: toolsEnabled
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
                                    if (typeof onChunk !== 'function') {
                                        console.error("CRITICAL: onChunk is not a function!", onChunk);
                                        throw new Error("Internal error: Invalid onChunk callback.");
                                    }
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
            } // end while (newlineIndex)
        } // end while (true)

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
         if (typeof onError !== 'function') {
              console.error("CRITICAL: onError callback is invalid during error handling!");
         } else {
             onError(error, isAbort);
         }
    } finally {
       // Let generateAssistantResponse handle nullifying state.streamController via cleanup
    }
}

async function generateAssistantResponse(parentId, targetContentDiv, modelName, generationArgs, toolsEnabled, isEditing = false, initialText = '') {
    console.log(`%c[generateAssistantResponse RUN - Backend Mode] parentId: ${parentId}, toolsEnabled: ${toolsEnabled}, isEditing: ${isEditing}, targetContentDiv provided: ${!!targetContentDiv}`, "color: purple; font-weight: bold;", { currentChatId: state.currentChatId });

    if (!state.currentChatId) { console.error("generateAssistantResponse: No current chat ID."); cleanupAfterGeneration(); return; }
    if (!targetContentDiv) { console.error("generateAssistantResponse: No target content div provided."); cleanupAfterGeneration(); return; }
    if (targetContentDiv.classList.contains('streaming')) {
         console.warn("generateAssistantResponse: Generation already in progress for this element.");
         return;
    }

    setGenerationInProgressUI(true);
    state.currentAssistantMessageDiv = targetContentDiv;
    targetContentDiv.classList.add('streaming');
    // Initial render respects default via buildContentHtml -> renderMarkdown -> enhanceCodeBlock
    buildContentHtml(targetContentDiv, initialText, true);
    targetContentDiv.insertAdjacentHTML('beforeend', '<span class="pulsing-cursor">█</span>');

    let fullRenderedContent = initialText;
    let streamErrorOccurred = null;

    try {
        await streamFromBackend(
            state.currentChatId,
            parentId,
            modelName,
            generationArgs,
            toolsEnabled,
            // --- onChunk Callback ---
            (textChunk) => {
                if (!targetContentDiv || state.streamController?.signal.aborted || state.currentAssistantMessageDiv !== targetContentDiv) return;
                fullRenderedContent += textChunk;
                // buildContentHtml now applies default state internally
                buildContentHtml(targetContentDiv, fullRenderedContent, true);
                targetContentDiv.querySelector('.pulsing-cursor')?.remove();
                targetContentDiv.insertAdjacentHTML('beforeend', '<span class="pulsing-cursor">█</span>');
                // Finalize blocks incrementally for responsiveness
                finalizeStreamingCodeBlocks(targetContentDiv);
            },
            // --- onToolStart Callback ---
            (name, args) => {
                if (!targetContentDiv || state.streamController?.signal.aborted || state.currentAssistantMessageDiv !== targetContentDiv) return;
                console.log(`Tool Start received: ${name}`, args);
                const rawTag = `<tool name="${name}" ${Object.entries(args).map(([k, v]) => `${k}="${v}"`).join(' ')} />`;
                const contentEndsWithTag = fullRenderedContent.trimEnd().endsWith('/>') && fullRenderedContent.includes(`<tool name="${name}"`);
                if (!contentEndsWithTag) {
                    fullRenderedContent += rawTag;
                }
                buildContentHtml(targetContentDiv, fullRenderedContent, true);
                targetContentDiv.querySelector('.pulsing-cursor')?.remove();
                targetContentDiv.insertAdjacentHTML('beforeend', '<span class="pulsing-cursor">█</span>');
                 // Finalize blocks incrementally
                finalizeStreamingCodeBlocks(targetContentDiv);
            },
            // --- onToolEnd Callback ---
            (name, result, error) => {
                if (!targetContentDiv || state.streamController?.signal.aborted || state.currentAssistantMessageDiv !== targetContentDiv) return;
                console.log(`Tool End received: ${name}`, error ? `Error: ${error}` : `Result: ${result}`);
                const resultString = error ? `[Error: ${error}]` : result;
                const encodedResult = resultString.replace(/"/g, '"');
                const rawTag = `<tool_result tool_name="${name}" result="${encodedResult}" />`;
                const contentEndsWithTag = fullRenderedContent.trimEnd().endsWith('/>') && fullRenderedContent.includes(`<tool_result tool_name="${name}"`);
                 if (!contentEndsWithTag) {
                    fullRenderedContent += rawTag;
                }
                buildContentHtml(targetContentDiv, fullRenderedContent, true);
                targetContentDiv.querySelector('.pulsing-cursor')?.remove();
                targetContentDiv.insertAdjacentHTML('beforeend', '<span class="pulsing-cursor">█</span>');
                 // Finalize blocks incrementally
                finalizeStreamingCodeBlocks(targetContentDiv);
            },
            // --- onComplete Callback ---
            async () => {
                if (state.currentAssistantMessageDiv !== targetContentDiv) {
                     console.warn("onComplete: Target div no longer the active streaming div. Skipping final updates.");
                     if (state.streamController && !state.streamController.signal.aborted) {
                         setGenerationInProgressUI(false);
                     }
                     return;
                }
                console.log("Backend generation completed successfully.");
                targetContentDiv?.classList.remove('streaming');
                targetContentDiv?.querySelector('.pulsing-cursor')?.remove();
                // Final buildContentHtml call applies default state
                buildContentHtml(targetContentDiv, fullRenderedContent, false);
                // Run finalize *after* the final build to highlight correctly
                finalizeStreamingCodeBlocks(targetContentDiv);
                streamErrorOccurred = false;

                try {
                    console.log("Reloading chat state after successful backend generation.");
                    if (state.currentChatId && targetContentDiv.closest('.message-row')) {
                        await loadChat(state.currentChatId);
                    } else {
                         console.warn("Skipping chat reload in onComplete: Chat context changed or message row removed.");
                    }
                } catch (loadError) {
                     console.error("Error reloading chat after successful generation:", loadError);
                     addSystemMessage("Error refreshing chat: " + loadError.message, "error");
                } finally {
                    if (state.currentAssistantMessageDiv === targetContentDiv) {
                         setGenerationInProgressUI(false);
                         state.currentAssistantMessageDiv = null;
                    }
                }
            },
            // --- onError Callback ---
             async (error, isAbort) => {
                console.warn(`>>> onError called: isAbort=${isAbort}`, error.message);
                streamErrorOccurred = error;

                if (state.currentAssistantMessageDiv !== targetContentDiv && targetContentDiv) {
                     console.warn("onError: Target div no longer the active streaming div. Skipping UI updates for this div.");
                     if (state.streamController && state.streamController.signal.aborted) {
                          setGenerationInProgressUI(false);
                     }
                     return;
                }

                targetContentDiv?.classList.remove('streaming');
                targetContentDiv?.querySelector('.pulsing-cursor')?.remove();
                if (targetContentDiv) {
                    // Final buildContentHtml applies default state even on error/abort
                    buildContentHtml(targetContentDiv, fullRenderedContent, false);
                    // Finalize highlighting
                    finalizeStreamingCodeBlocks(targetContentDiv);
                }

                console.warn(">>> Calling setGenerationInProgressUI(false) from onError");
                setGenerationInProgressUI(false);
                if (state.currentAssistantMessageDiv === targetContentDiv) {
                    console.warn(">>> Clearing currentAssistantMessageDiv in onError");
                    state.currentAssistantMessageDiv = null;
                }

                if (isAbort) {
                    addSystemMessage("Generation stopped. Reloading...", "info", 1500);
                    console.warn(">>> User abort detected. Attempting reload after delay...");
                    await new Promise(resolve => setTimeout(resolve, 50));
                    try {
                        if (state.currentChatId) {
                           await loadChat(state.currentChatId);
                           console.log("Chat reloaded after user abort.");
                        } else {
                           console.warn("Skipping reload after abort: No current chat ID.");
                           startNewChat();
                        }
                    } catch (loadError) {
                        console.error("Error reloading chat after abort:", loadError);
                        addSystemMessage("Error refreshing chat state after stopping.", "error");
                        targetContentDiv?.insertAdjacentHTML('beforeend', `<br><span class="system-info-row warning">Stopped. Refresh failed.</span>`);
                    }
                } else { // Handle non-abort errors
                    addSystemMessage(`Generation Error: ${error.message}`, "error");
                    targetContentDiv?.insertAdjacentHTML('beforeend', `<br><span class="system-info-row error">Error: ${error.message}</span>`);
                    const placeholderRow = targetContentDiv?.closest('.message-row.placeholder');
                    if (placeholderRow) {
                        console.warn(">>> Removing placeholder on error");
                        placeholderRow.remove();
                    }
                }
                console.warn(">>> Exiting onError handler");
            }
        );

    } catch (error) {
        console.error("Error setting up generation stream (SYNC):", error);
        addSystemMessage(`Setup Error: ${error.message}`, "error");
        targetContentDiv?.classList.remove('streaming');
        targetContentDiv?.querySelector('.pulsing-cursor')?.remove();
        const placeholderRow = targetContentDiv?.closest('.message-row.placeholder');
        if (placeholderRow) placeholderRow.remove();
        cleanupAfterGeneration();
    } finally {
         console.log(">>> generateAssistantResponse function finally block executing.");
         if (state.currentAssistantMessageDiv === targetContentDiv) {
              // Ensure cleanup happens even if errors occurred during the process
              targetContentDiv?.classList.remove('streaming');
              targetContentDiv?.querySelector('.pulsing-cursor')?.remove();
              setGenerationInProgressUI(false); // Redundant with onError/onComplete but safe
              state.currentAssistantMessageDiv = null;
         } else {
             // If the target div changed, ensure the global UI state is still cleaned up
             if (stopButton.style.display !== 'none' || sendButton.disabled) {
                 console.warn(">>> generateAssistantResponse finally: Target div changed, forcing UI cleanup.");
                 setGenerationInProgressUI(false);
             }
         }
         console.log(">>> generateAssistantResponse finally block finished.");
    }
}

// (Replace the existing finalizeStreamingCodeBlocks function with this one)
function finalizeStreamingCodeBlocks(containerElement) {
    if (!containerElement) return;
    // console.log("Finalizing code blocks (highlighting pass)...");

    // Find all code blocks within the container that might need highlighting.
    // This targets code inside our wrappers.
    containerElement.querySelectorAll('.code-block-wrapper code').forEach(codeElement => {
         try {
             // Re-highlight or highlight if missed. highlightElement is idempotent.
             hljs.highlightElement(codeElement);
         } catch (e) {
             console.error(`Error during final highlight pass:`, e, codeElement.textContent.substring(0, 50));
         }
    });

    // Clean up any potential streaming classes left over (belt-and-suspenders)
    containerElement.querySelectorAll('.streaming').forEach(el => {
        el.classList.remove('streaming');
    });
}

/**
 * Sets the UI state to indicate generation is in progress or finished.
 * Handles Stop button display, disables send button.
 * @param {boolean} inProgress - True if generation is starting, false if ending.
 */
function setGenerationInProgressUI(inProgress) {
    console.log(`>>> setGenerationInProgressUI called with inProgress = ${inProgress}`);
    if (inProgress) {
        stopButton.style.display = 'flex';
        sendButton.disabled = true;
        sendButton.innerHTML = '<div class="spinner"></div>';
        // REMOVED: isAutoScrolling logic
    } else {
        stopButton.style.display = 'none';
        sendButton.disabled = false;
        sendButton.innerHTML = '<i class="bi bi-arrow-up"></i>';
        console.log(">>> Send button state reset in setGenerationInProgressUI");

        // REMOVED: isAutoScrolling logic

        if (state.streamController) {
            if (!state.streamController.signal.aborted) {
                console.warn(">>> Controller not aborted when setGenerationInProgressUI(false) called. Aborting now.");
                state.streamController.abort();
            }
            state.streamController = null;
            console.log(">>> Cleared streamController reference");
        } else {
             console.log(">>> No streamController reference to clear");
        }

        state.toolCallPending = false;
        state.toolContinuationContext = null;
        state.currentToolCallId = null;
        state.abortingForToolCall = false;
        console.log(">>> Reset tool state flags");
    }
}

/**
 * Clears the message input area, including text and attachment previews/state.
 */
function clearInputArea() {
    messageInput.value = '';
    state.currentImages = [];
    state.currentTextFiles = [];
    imagePreviewContainer.innerHTML = '';
    adjustTextareaHeight(); // Reset height
}

/**
 * Prepares the chat UI for receiving a new response (hides welcome, adjusts padding).
 */
function prepareChatUIForResponse() {
    if (document.body.classList.contains('welcome-active')) {
        document.body.classList.remove('welcome-active');
        welcomeContainer.style.display = 'none';
        adjustTextareaHeight(); // Recalculate padding for chat view
    }
}

/**
 * Checks if the chat is empty and shows the welcome screen if necessary.
 */
function checkAndShowWelcome() {
    const hasVisibleMessages = state.messages.some(m => m.role !== 'system');
    if (!hasVisibleMessages) {
        welcomeContainer.style.display = 'flex';
        document.body.classList.add('welcome-active');
        if (chatContainer) chatContainer.style.paddingBottom = '0px'; // No padding for welcome
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

    const selectedOption = modelSelect.options[modelSelect.selectedIndex];
    if (!selectedOption) {
         alert("Please select a model."); return;
    }
    const modelName = selectedOption.value;

    const currentInputText = messageInput.value; // Keep track of input before clearing
    clearInputArea();
    prepareChatUIForResponse();

    let currentChatId = state.currentChatId;
    let savedUserMessageId = null;
    let assistantPlaceholderRow = null;
    let assistantContentDiv = null;

    sendButton.disabled = true;
    sendButton.innerHTML = '<div class="spinner"></div>';

    try {
        if (!currentChatId) {
            currentChatId = await createNewChatBackend();
            if (!currentChatId) throw new Error("Failed to create a new chat session.");
            state.currentChatId = currentChatId;
            await fetchChats();
            localStorage.setItem('lastChatId', currentChatId);
            highlightCurrentChatInSidebar();
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

        await loadChat(currentChatId); // Reload state (will render user msg, won't auto-scroll)

        assistantPlaceholderRow = createPlaceholderMessageRow(`temp_assistant_${Date.now()}`, savedUserMessageId);
        messagesWrapper.appendChild(assistantPlaceholderRow);
        assistantContentDiv = assistantPlaceholderRow.querySelector('.message-content');

        if (!assistantContentDiv) {
             throw new Error("Failed to create assistant response placeholder element.");
        }

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
        if (!messageInput.value) messageInput.value = currentInputText; // Restore input if needed
        assistantPlaceholderRow?.remove();
        cleanupAfterGeneration();
        checkAndShowWelcome();
        adjustTextareaHeight();
        // Update button visibility on error
        updateScrollButtonVisibility();
    }
}

/**
 * Creates a new chat session on the backend.
 * @returns {Promise<string|null>} The new chat ID or null on failure.
 */
async function createNewChatBackend() {
    try {
        const response = await fetch(`${API_BASE}/chat/new_chat`, {
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

/**
 * Saves a message (user or assistant partial/error) to the backend.
 * @param {string} chatId The chat ID.
 * @param {object} messageData The message data ({role, message, attachments, parent_message_id, model_name?, tool_calls?, tool_call_id?}).
 * @returns {Promise<string|null>} The saved message ID or null on failure.
 */
async function saveMessageToBackend(chatId, messageData) {
    try {
        const url = `${API_BASE}/chat/${chatId}/add_message`;
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


// Function to find the last message ID in the active branch of the local state
function findLastActiveMessageId(messages) {
     if (!messages || messages.length === 0) return null;
     const messageMap = new Map(messages.map(msg => [msg.message_id, { ...msg, children: [] }]));
     const rootMessages = [];
     messages.forEach(msg => {
         if (msg.role === 'system') return;
         const msgNode = messageMap.get(msg.message_id);
         if (!msgNode) return;
         if (msg.parent_message_id && messageMap.has(msg.parent_message_id)) {
             // Ensure parent has children array initialized
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
     // Start traversal from all roots and find the absolute last message in the active path
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
                if (childLastId) currentLastId = childLastId; // Update if child path goes deeper
            }
        }
        return currentLastId;
     }

     // Iterate through roots and find the one with the latest timestamp overall in its active branch
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

/**
 * Cleans up UI state after generation finishes or is stopped/errored.
 */
function cleanupAfterGeneration() {
    console.log("Running cleanupAfterGeneration");
    sendButton.disabled = false;
    sendButton.innerHTML = '<i class="bi bi-arrow-up"></i>';
    // REMOVED: isAutoScrolling logic
    state.currentAssistantMessageDiv = null;
    setGenerationInProgressUI(false); // Ensures flags/controller cleared
}

// (Replace the existing renderToolCallPlaceholder function with this one)
function renderToolCallPlaceholder(messageContentDiv, toolName, args) {
    if (!messageContentDiv) return;

    const toolCallBlock = document.createElement('div');
    toolCallBlock.className = 'tool-call-block collapsed'; // Start collapsed
    toolCallBlock.dataset.toolName = toolName;

    const toolHeader = document.createElement('div');
    toolHeader.className = 'tool-header';
    const toolNameSpan = document.createElement('span');
    toolNameSpan.className = 'tool-header-name';
    const toolIcon = toolName === 'add' ? 'calculator' : (toolName === 'search' ? 'search' : 'tools'); // Added search icon
    toolNameSpan.innerHTML = `<i class="bi bi-${toolIcon}"></i> Calling: ${toolName}`;
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'tool-header-actions';
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'tool-collapse-btn'; // Class for delegation
    collapseBtn.innerHTML = '<i class="bi bi-chevron-down"></i>';
    collapseBtn.title = 'Expand tool call details';
    actionsDiv.appendChild(collapseBtn);
    toolHeader.appendChild(toolNameSpan);
    toolHeader.appendChild(actionsDiv);
    toolCallBlock.appendChild(toolHeader);

    const toolArgsDiv = document.createElement('div');
    toolArgsDiv.className = 'tool-arguments';
    try {
        // Pretty print JSON if args is an object
        toolArgsDiv.textContent = typeof args === 'object' && args !== null ? JSON.stringify(args, null, 2) : String(args);
    } catch {
        toolArgsDiv.textContent = "[Invalid Arguments]";
    }
    toolCallBlock.appendChild(toolArgsDiv);

    messageContentDiv.appendChild(toolCallBlock);
}

// (Replace the existing renderToolResult function with this one)
function renderToolResult(messageContentDiv, resultText) {
    if (!messageContentDiv) return;

    const toolResultBlock = document.createElement('div');
    toolResultBlock.className = 'tool-result-block collapsed'; // Start collapsed

    const toolHeader = document.createElement('div');
    toolHeader.className = 'tool-header';
    const toolNameSpan = document.createElement('span');
    toolNameSpan.className = 'tool-header-name';
    // Check if result text indicates an error
    const isError = typeof resultText === 'string' && resultText.toLowerCase().startsWith('[error:')
    const iconClass = isError ? 'exclamation-circle-fill text-danger' : 'check-circle-fill'; // Use danger color for error icon
    const titleText = isError ? 'Tool Error' : 'Tool Result';
    toolNameSpan.innerHTML = `<i class="bi bi-${iconClass}"></i> ${titleText}`;
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'tool-header-actions';
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'tool-collapse-btn'; // Class for delegation
    collapseBtn.innerHTML = '<i class="bi bi-chevron-down"></i>';
    collapseBtn.title = 'Expand tool result';
    actionsDiv.appendChild(collapseBtn);
    toolHeader.appendChild(toolNameSpan);
    toolHeader.appendChild(actionsDiv);
    toolResultBlock.appendChild(toolHeader);

    const toolResultContent = document.createElement('div');
    toolResultContent.className = 'tool-result-content';
     // Render result text potentially as markdown if it contains formatting like code blocks
     toolResultContent.innerHTML = renderMarkdown(resultText || '[Empty Result]');
    // Original simple text rendering:
    // toolResultContent.textContent = resultText || '[Empty Result]';

    toolResultBlock.appendChild(toolResultContent);

    messageContentDiv.appendChild(toolResultBlock);
}


// --- NEW Function: Handle Tool Block Toggling ---
function handleToolBlockToggle(e) {
    const toggleBtn = e.target.closest('.tool-collapse-btn');
    if (toggleBtn) {
        const block = toggleBtn.closest('.tool-call-block, .tool-result-block');
        if (block) {
            const isCollapsed = block.classList.toggle('collapsed');
            const icon = toggleBtn.querySelector('i');
            icon.className = isCollapsed ? 'bi bi-chevron-down' : 'bi bi-chevron-up';
            toggleBtn.title = isCollapsed ? 'Expand details' : 'Collapse details';
        }
    }
}

// Helper to highlight code blocks within a newly updated div
// --- highlightRenderedCode (Modified selector) ---
function highlightRenderedCode(element) {
    if (!element) return;
    // Select code blocks directly within the element passed (e.g., contentDiv)
    element.querySelectorAll('pre code').forEach(block => {
         // Check if it needs highlighting or wrapping
         const preElement = block.parentElement;
         if (preElement && preElement.tagName === 'PRE' && !preElement.closest('.code-block-wrapper')) {
              const codeText = block.textContent;
              const langClass = block.className.split(' ').find(cls => cls.startsWith('language-'));
              const lang = langClass ? langClass.substring(9) : '';
              const wrapper = createCodeBlockWithContent(codeText, lang);
              preElement.replaceWith(wrapper);
         } else if (block.matches('.code-block-wrapper code') && !block.classList.contains('hljs')) {
             // If it's already wrapped but not highlighted (e.g., during streaming)
             try { hljs.highlightElement(block); } catch(e) { console.error("Error highlighting mid-stream:", e); }
         } else if (!block.closest('.code-block-wrapper') && !block.classList.contains('hljs')){
              // If it's not wrapped and not highlighted (should be caught by first case, but as fallback)
               try { hljs.highlightElement(block); } catch(e) { console.error("Error highlighting loose code block:", e); }
         }
      });
 }

/**
 * Creates a placeholder message row DOM element.
 * @param {string} tempId - A temporary unique ID for the placeholder.
 * @param {string} parentId - The ID of the parent message.
 * @returns {HTMLElement} The placeholder row element.
 */
function createPlaceholderMessageRow(tempId, parentId) {
    const messageRow = document.createElement('div');
    messageRow.className = `message-row assistant-row placeholder`; // Add placeholder class
    messageRow.dataset.messageId = tempId; // Temporary ID
    if (parentId) messageRow.dataset.parentId = parentId; // Store parent ref if needed

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';

    // Message Content placeholder (initially empty, cursor added by generateAssistantResponse)
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    // Placeholder for avatar/actions
    const avatarActionsDiv = document.createElement('div');
    avatarActionsDiv.className = 'message-avatar-actions placeholder-actions'; // Minimal actions placeholder

    messageDiv.appendChild(contentDiv);
    messageDiv.appendChild(avatarActionsDiv); // Add actions below content
    messageRow.appendChild(messageDiv);
    return messageRow;
}

// Removes a specific message row and all its subsequent descendants *currently rendered in the DOM*.
function removeMessageAndDescendantsFromDOM(startMessageId) {
    const startRow = messagesWrapper.querySelector(`.message-row[data-message-id="${startMessageId}"]`);
    if (!startRow) {
        console.warn(`removeMessageAndDescendantsFromDOM: Start row ${startMessageId} not found.`);
        return;
    }

    const removedIds = new Set(); // Keep track of IDs whose rows are removed

    function removeRecursively(rowElement) {
        if (!rowElement) return;
        const messageId = rowElement.dataset.messageId;
        // Base cases: no ID, or already processed (avoids infinite loops in weird DOM states)
        if (!messageId || removedIds.has(messageId)) return;

        // Find direct children rendered in the DOM (must have the correct parentId)
        const childRows = messagesWrapper.querySelectorAll(`.message-row[data-parent-id="${messageId}"]`);

        // Recursively remove children first (depth-first removal)
        childRows.forEach(child => removeRecursively(child));

        // After all children are removed, remove the current row
        console.log(`Removing DOM row for message ${messageId}`);
        rowElement.remove();
        removedIds.add(messageId);
    }

    removeRecursively(startRow);
    console.log("Finished removing branch from DOM, removed IDs:", Array.from(removedIds));
}

/**
 * Deletes a message and its descendants from the backend.
 * @param {string} chatId The chat ID.
 * @param {string} messageId The ID of the message branch to delete.
 * @returns {Promise<boolean>} True on success, false on failure.
 */
async function deleteMessageFromBackend(chatId, messageId) {
    try {
        const response = await fetch(`${API_BASE}/chat/${chatId}/delete_message/${messageId}`, { method: 'POST' }); // Use POST as per previous example
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
    // Use generation state flag check
    if (!currentChatId || document.getElementById('send-button').disabled) {
        addSystemMessage("Cannot regenerate while busy.", "warning");
        return;
    }

    const messageToRegen = state.messages.find(m => m.message_id === messageIdToRegen);
    // We actually need the PARENT message to initiate regeneration from
    const parentMessage = messageToRegen?.parent_message_id
        ? state.messages.find(m => m.message_id === messageToRegen.parent_message_id)
        : null;

    // Ensure we are regenerating an assistant response and have its parent
    if (!messageToRegen || messageToRegen.role !== 'llm' || !parentMessage) {
        addSystemMessage("Can only regenerate assistant responses that have a parent.", "error");
        return;
    }
    const parentMessageId = parentMessage.message_id;

    // Always use the currently selected model from the UI
    const modelNameToUse = modelSelect.value;
    if (!modelNameToUse) {
        addSystemMessage("Please select a model before regenerating.", "error");
        return;
    }

    console.log(`Regenerating from parent ${parentMessageId} (replacing/branching from ${messageIdToRegen}, new branch: ${newBranch}) using model ${modelNameToUse}`);
    let assistantPlaceholderRow = null;
    let generationParentId = parentMessageId; // ID to pass to generateAssistantResponse

    try {
        if (!newBranch) {
            // --- Replace Logic ---
            if (!confirm("Replacing will delete this message and all subsequent responses/branches in this specific branch. Proceed?")) return;
            console.log(`Deleting message branch starting with ${messageIdToRegen} for replacement.`);

            // 1. Remove visually first for responsiveness
            removeMessageAndDescendantsFromDOM(messageIdToRegen);

            // 2. Delete from backend
            const deleteSuccess = await deleteMessageFromBackend(currentChatId, messageIdToRegen);
            if (!deleteSuccess) throw new Error("Failed to delete message branch for replacement.");

            // 3. Update local state (remove deleted messages) - NO intermediate render
            const descendantIds = new Set();
            const queue = [messageIdToRegen];
            while(queue.length > 0) {
                const currentId = queue.shift();
                if (!currentId || descendantIds.has(currentId)) continue; // Prevent reprocessing
                descendantIds.add(currentId);
                // Find children efficiently from state
                state.messages.forEach(m => {
                    if (m.parent_message_id === currentId) {
                         queue.push(m.message_id);
                    }
                });
            }
            state.messages = state.messages.filter(m => !descendantIds.has(m.message_id));
            console.log(`Locally removed ${descendantIds.size} messages from state.`);
            // --- REMOVED intermediate renderActiveMessages() call ---
            // The parent's child list and active index will be corrected by the backend
            // and reflected accurately when loadChat is called after generation.

        } else {
            // --- New Branch Logic ---
            console.log(`Branching: Removing current active branch visually before generating new one.`);
            const parentNode = state.messages.find(m => m.message_id === parentMessageId);
            if (parentNode) {
                const childrenIds = parentNode.child_message_ids || [];
                const activeIndex = parentNode.active_child_index ?? 0;
                // Ensure index is valid even if child_message_ids is out of sync (shouldn't happen ideally)
                const safeActiveIndex = Math.min(Math.max(0, activeIndex), childrenIds.length - 1);
                const activeChildId = childrenIds.length > 0 ? childrenIds[safeActiveIndex] : null;

                if (activeChildId) {
                    console.log(`Branching: Removing current active branch starting with ${activeChildId} from DOM.`);
                    removeMessageAndDescendantsFromDOM(activeChildId); // Remove the currently displayed branch visually
                } else {
                    console.log("Branching: Parent had no known active children in state to remove from DOM.");
                }
            } else {
                console.warn(`Could not find parent ${parentMessageId} in local state for branch removal.`);
            }
            // generationParentId remains parentMessageId
        }

        // --- Create Placeholder & Start Generation (Common for both Replace and New Branch) ---
        assistantPlaceholderRow = createPlaceholderMessageRow(`temp_assistant_${Date.now()}`, generationParentId);
        // Find the parent row in the DOM to append after
        const parentRow = messagesWrapper.querySelector(`.message-row[data-message-id="${generationParentId}"]`);
        if (parentRow) {
             // Insert the placeholder *immediately* after the parent row
             parentRow.insertAdjacentElement('afterend', assistantPlaceholderRow);
        } else {
             // Fallback: If parent row somehow not found (e.g., root message), append to end
             console.warn(`Parent row ${generationParentId} not found in DOM, appending placeholder to end.`);
             messagesWrapper.appendChild(assistantPlaceholderRow);
        }

        const assistantContentDiv = assistantPlaceholderRow.querySelector('.message-content');
        if (!assistantContentDiv) {
             // If placeholder creation failed, clean up and stop
             assistantPlaceholderRow?.remove();
             throw new Error("Failed to create assistant response placeholder element.");
        }
        scrollToBottom('smooth'); // Scroll to new placeholder smoothly

        // Start generation - this will save the new message(s) and trigger loadChat on completion/error
        await generateAssistantResponse(
            generationParentId,
            assistantContentDiv,
            modelNameToUse,
            defaultGenArgs,
            state.toolsEnabled
        );
        // NOTE: loadChat inside generateAssistantResponse's callbacks will handle the final UI update

    } catch (error) {
        console.error(`Error during regeneration (new branch: ${newBranch}):`, error);
        addSystemMessage(`Regeneration failed: ${error.message}`, "error");
        assistantPlaceholderRow?.remove(); // Remove placeholder on error
        // Consider reloading the chat to revert to a consistent state on failure
        try { await loadChat(currentChatId); } catch(e) {
            console.error("Failed to reload chat after regeneration error:", e);
        }
        cleanupAfterGeneration(); // Use standard cleanup
    }
}



// Scroll Utility
function scrollToBottom(behavior = 'auto') { // 'smooth' or 'auto'
    // Use requestAnimationFrame to ensure scrolling happens after DOM updates
    requestAnimationFrame(() => {
        if (chatContainer) {
            chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: behavior });
        }
    });
}

async function continueMessage(messageIdToContinue) {
    // Use generation state flag
    if (!state.currentChatId || document.getElementById('send-button').disabled) {
        addSystemMessage("Cannot continue while busy.", "warning");
        return;
    }
    const messageToContinue = state.messages.find(m => m.message_id === messageIdToContinue);
    if (!messageToContinue || messageToContinue.role !== 'llm') {
        addSystemMessage("Can only continue assistant messages.", "error"); return;
    }

    // *** FIX: Always use the currently selected model from the UI ***
    const modelNameToUse = modelSelect.value;
    if (!modelNameToUse) {
        addSystemMessage("Please select a model before continuing.", "error");
        return; // Stop if no model is selected
    }
    // --- Removed fallback to messageToContinue.model_name ---

    const parentId = messageToContinue.parent_message_id; // Need parent ID for backend context building

    // --- Check if message ends with tool tag (simple check, backend might handle more robustly) ---
    const rawMessage = messageToContinue.message || '';
    TOOL_TAG_REGEX.lastIndex = 0; // Reset regex
    let endsWithToolTag = false;
    let match;
    let lastTagEnd = -1;
    while ((match = TOOL_TAG_REGEX.exec(rawMessage)) !== null) { lastTagEnd = match.index + match[0].length; }
    if (lastTagEnd > 0 && lastTagEnd >= rawMessage.trimEnd().length) endsWithToolTag = true;

    if (endsWithToolTag) {
         addSystemMessage("Cannot continue a message ending with a tool action. Please regenerate.", "warning");
         return;
    }
    if (!parentId) {
         addSystemMessage("Cannot continue message without a parent.", "error"); return;
    }

    console.log(`Continuing message ${messageIdToContinue} using model ${modelNameToUse}`);

    // --- Find Target Div ---
    const targetMessageRow = messagesWrapper.querySelector(`.message-row[data-message-id="${messageIdToContinue}"]`);
    const targetContentDiv = targetMessageRow?.querySelector('.message-content');
    if (!targetContentDiv) {
        addSystemMessage("Error: Could not find message content area.", "error"); return;
    }

    // --- Start Generation ---
    await generateAssistantResponse(
        parentId, // Pass the original parent ID
        targetContentDiv,
        modelNameToUse, // Use the currently selected model
        defaultGenArgs,
        state.toolsEnabled,
        true, // isEditing = true (we are effectively editing)
        messageToContinue.message || '' // initialText = current message content
    );
}


async function stopStreaming() {
    // Check the stream controller used by streamFromBackend
    if (state.streamController && !state.streamController.signal.aborted) {
        console.log("User requested stop. Aborting frontend fetch...");
        // 1. Abort the frontend fetch request (triggers onError in generateAssistantResponse)
        state.streamController.abort();

        // 2. Signal the backend asynchronously (don't await this in the main stop flow)
        if (state.currentChatId) {
            console.log(`Signaling backend to abort generation for chat ${state.currentChatId}...`);
            // Send signal without waiting for backend response here
            fetch(`${API_BASE}/chat/${state.currentChatId}/abort_generation`, { method: 'POST' })
                .then(response => {
                    if (!response.ok) {
                        console.error(`Backend abort request failed: ${response.status}`);
                    }
                    return response.json();
                })
                .then(result => console.log("Backend abort signal result:", result?.message || 'No message'))
                .catch(err => console.error("Error sending abort signal to backend:", err));
        } else {
            console.warn("Cannot signal backend abort: No current chat ID.");
        }
        // NOTE: UI cleanup (buttons, etc.) is now handled by the onError callback
        // triggered by state.streamController.abort() above.
    } else {
        console.log("No active frontend stream to stop or already aborted.");
        // Cleanup potentially stuck UI state if stop is clicked unexpectedly
        if (document.getElementById('send-button').disabled || stopButton.style.display === 'flex') {
             console.warn("Stop clicked with no active stream, forcing UI cleanup.");
             cleanupAfterGeneration(); // Force reset UI state
        }
    }
}

// --- Character Handling ---

async function fetchCharacters() {
    try {
        const response = await fetch(`${API_BASE}/chat/list_characters`);
        if (!response.ok) throw new Error(`Failed to fetch characters: ${response.statusText}`);
        return await response.json();
    } catch (error) {
        console.error('Error fetching characters:', error);
        return []; // Return empty array on error
    }
}

async function populateCharacterSelect() {
    const characters = await fetchCharacters();
    const select = document.getElementById('character-select');
    const currentVal = select.value; // Preserve current selection if possible
    select.innerHTML = '<option value="">No Character</option>'; // Clear and add default

    if (characters.length > 0) {
        characters.forEach(char => {
            const option = document.createElement('option');
            option.value = char.character_id;
            option.textContent = char.character_name;
            select.appendChild(option);
        });
        // Restore previous selection if it still exists
        if (characters.some(c => c.character_id === currentVal)) {
             select.value = currentVal;
        } else if (state.currentCharacterId && characters.some(c => c.character_id === state.currentCharacterId)) {
            // If selection lost, try restoring from state
             select.value = state.currentCharacterId;
        }
    }

    // Update edit/delete buttons based on the FINAL selection state
    updateCharacterActionButtons();
}

function displayActiveSystemPrompt(characterName, promptText) {
    const promptContainer = document.getElementById('active-prompt-container');
    if (!promptContainer) return;

    // Show character name if available, otherwise show "Tools Enabled" if applicable
    const nameToDisplay = characterName || (state.toolsEnabled ? 'Tools Enabled' : '');

    if (!nameToDisplay && !promptText) { // Completely empty state
        promptContainer.innerHTML = '';
        promptContainer.onclick = null;
        promptContainer.style.cursor = 'default';
        promptContainer.style.visibility = 'hidden'; // Hide if totally empty
        return;
    }

    promptContainer.style.visibility = 'visible'; // Ensure visible
    promptContainer.innerHTML = `
        <i class="bi ${characterName ? 'bi-person-check-fill' : (state.toolsEnabled ? 'bi-tools' : '')}"></i>
        ${nameToDisplay ? `<span class="active-prompt-name">${nameToDisplay}</span>` : ''}
    `;

    // Only allow viewing popup if there's actual prompt text
    if (promptText) {
        promptContainer.onclick = () => viewSystemPromptPopup(promptText, characterName || "Effective System Prompt");
        promptContainer.style.cursor = 'pointer';
        promptContainer.title = 'View effective system prompt';
    } else {
        promptContainer.onclick = null;
        promptContainer.style.cursor = 'default';
        promptContainer.title = ''; // No tooltip if no prompt
    }
}


function viewSystemPromptPopup(promptText, characterName = "System Prompt") {
    const popup = document.createElement('div');
    popup.className = 'attachment-popup-overlay'; // Reuse overlay class
    popup.addEventListener('click', (e) => {
        if (e.target === popup) popup.remove(); // Close if clicked outside
    });

    const container = document.createElement('div');
    container.className = 'attachment-popup-container'; // Reuse container class

    const closeBtn = document.createElement('button');
    closeBtn.className = 'attachment-popup-close'; // Reuse close button class
    closeBtn.innerHTML = '<i class="bi bi-x-lg"></i>';
    closeBtn.title = `Close ${characterName} Prompt`;
    closeBtn.addEventListener('click', () => popup.remove());

    // Content element for the prompt text
    const contentElement = document.createElement('pre');
    contentElement.textContent = promptText;
    contentElement.className = 'system-prompt-popup-text'; // Use specific class for styling if needed, or reuse attachment-popup-text

    // Optional: Add a title inside the popup
    const titleElement = document.createElement('h4');
    titleElement.textContent = characterName; // Use the provided name directly
    titleElement.style.color = "var(--text-primary)";
    titleElement.style.marginTop = "10px"; // Adjust spacing as needed
    titleElement.style.textAlign = "center";

    container.appendChild(closeBtn);
    container.appendChild(titleElement); // Add title
    container.appendChild(contentElement);
    popup.appendChild(container);
    document.body.appendChild(popup);
}

// Simplified Character Modal Logic
function openCharacterModal(mode, character = null) {
    const modal = document.getElementById('character-modal');
    const form = document.getElementById('character-form');
    const titleSpan = document.getElementById('modal-title');
    const submitBtn = document.getElementById('submit-btn');
    const characterIdInput = document.getElementById('character-id');
    const nameInput = document.getElementById('character-name');
    const syspromptInput = document.getElementById('character-sysprompt');

    form.reset(); // Clear previous input
    form.dataset.mode = mode; // Store mode (create/edit)

    if (mode === 'create') {
        titleSpan.textContent = 'Create New Character';
        submitBtn.textContent = 'Create';
        characterIdInput.value = ''; // Ensure ID is empty
    } else if (mode === 'edit' && character) {
        titleSpan.textContent = 'Edit Character';
        submitBtn.textContent = 'Save Changes';
        characterIdInput.value = character.character_id;
        nameInput.value = character.character_name;
        syspromptInput.value = character.sysprompt;
    } else {
         console.error("Invalid call to openCharacterModal");
         return; // Don't open if invalid state
    }

    modal.style.display = 'flex';
    nameInput.focus(); // Focus name field
}

function setupCharacterEvents() {
    const characterBtn = document.getElementById('character-btn');
    const characterPopup = document.getElementById('character-popup');
    const characterSelect = document.getElementById('character-select');
    const characterCreateBtn = document.getElementById('character-create-btn');
    const characterEditBtn = document.getElementById('character-edit-btn');
    const characterDeleteBtn = document.getElementById('character-delete-btn');
    const characterModal = document.getElementById('character-modal');
    const characterForm = document.getElementById('character-form');
    const cancelCreateBtn = document.getElementById('cancel-create-btn');

    characterBtn.addEventListener('click', (e) => {
        characterPopup.style.display = characterPopup.style.display === 'none' ? 'block' : 'none';
        e.stopPropagation();
    });

    characterSelect.addEventListener('change', async () => {
        const selectedCharacterId = characterSelect.value || null;
        localStorage.setItem('lastCharacterId', selectedCharacterId || '');
        updateCharacterActionButtons(); // Update buttons immediately

         let selectedChar = null;
         if (selectedCharacterId) {
              try { // Fetch details to update activeSystemPrompt
                  const characters = await fetchCharacters(); // TODO: Cache this?
                  selectedChar = characters.find(c => c.character_id === selectedCharacterId);
              } catch (e) { console.error("Failed to fetch selected character details", e); }
         }
         state.currentCharacterId = selectedCharacterId;
         state.activeSystemPrompt = selectedChar?.sysprompt || null; // Update base prompt state
         updateEffectiveSystemPrompt(); // Update combined prompt and display

        // Update the character association in the backend *if a chat is loaded*
        if (state.currentChatId) {
            try {
                const response = await fetch(`${API_BASE}/chat/${state.currentChatId}/set_active_character`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ character_id: selectedCharacterId })
                });
                if (!response.ok) throw new Error(`Failed to set character: ${await response.text()}`);
                console.log(`Chat ${state.currentChatId} character set to ${selectedCharacterId}`);
            } catch (error) {
                console.error('Error setting character for chat:', error);
                alert(`Failed to set active character: ${error.message}`);
                // Should we revert the dropdown? For now, no.
            }
        }
        characterPopup.style.display = 'none'; // Close popup
    });

    characterCreateBtn.addEventListener('click', () => {
        openCharacterModal('create');
        characterPopup.style.display = 'none';
    });

    characterEditBtn.addEventListener('click', async () => {
        const characterId = characterSelect.value;
        if (!characterId) return;

        try {
             const response = await fetch(`${API_BASE}/chat/get_character/${characterId}`);
             if (!response.ok) throw new Error(`Failed to fetch character details: ${await response.text()}`);
             const character = await response.json();
             openCharacterModal('edit', character);
        } catch (error) {
             console.error('Error fetching character for edit:', error);
             alert(`Failed to load character details: ${error.message}`);
        }
        characterPopup.style.display = 'none';
    });

    characterDeleteBtn.addEventListener('click', async () => {
        const characterId = characterSelect.value;
        const characterName = characterSelect.options[characterSelect.selectedIndex]?.textContent || 'this character';
        if (!characterId) return;

        if (confirm(`Are you sure you want to delete character "${characterName}"? This cannot be undone.`)) {
            try {
                const response = await fetch(`${API_BASE}/chat/delete_character/${characterId}`, {
                    method: 'DELETE'
                });
                if (!response.ok) throw new Error(`Failed to delete character: ${await response.text()}`);
                console.log(`Character ${characterId} deleted.`);

                 // If the deleted character was active, clear the state and update chat/UI
                 if (state.currentCharacterId === characterId) {
                     state.currentCharacterId = null;
                     state.activeSystemPrompt = null;
                     localStorage.removeItem('lastCharacterId');
                      updateEffectiveSystemPrompt(); // Update prompt display
                      if (state.currentChatId) { // Update chat if one is loaded
                          await fetch(`${API_BASE}/chat/${state.currentChatId}/set_active_character`, {
                               method: 'POST', headers: { 'Content-Type': 'application/json' },
                               body: JSON.stringify({ character_id: null })
                          });
                      }
                 }
                 await populateCharacterSelect(); // Refresh list (selects default, updates buttons)

            } catch (error) {
                console.error('Error deleting character:', error);
                alert(`Failed to delete character: ${error.message}`);
            }
        }
        characterPopup.style.display = 'none'; // Close popup regardless
    });

    // Close popup if clicked outside
    document.addEventListener('click', (e) => {
        if (characterPopup.style.display === 'block' && !characterBtn.contains(e.target) && !characterPopup.contains(e.target)) {
            characterPopup.style.display = 'none';
        }
    });

    // --- Character Modal Form Handling ---
    characterForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const mode = e.target.dataset.mode;
        const name = document.getElementById('character-name').value.trim();
        const sysprompt = document.getElementById('character-sysprompt').value.trim();
        const characterId = document.getElementById('character-id').value;

        if (!name || !sysprompt) {
            alert('Character Name and System Prompt are required.');
            return;
        }

        const characterData = { character_name: name, sysprompt, settings: {} };

        try {
             let response;
             let outcomeCharacterId = null;
             if (mode === 'create') {
                 console.log("Creating character:", characterData);
                 response = await fetch(`${API_BASE}/chat/create_character`, {
                     method: 'POST', headers: { 'Content-Type': 'application/json' },
                     body: JSON.stringify(characterData)
                 });
                 if (response.ok) outcomeCharacterId = (await response.json()).character_id;
             } else if (mode === 'edit' && characterId) {
                  // script.js
// ... (previous code from the last response) ...

                 console.log(`Updating character ${characterId}:`, characterData);
                 response = await fetch(`${API_BASE}/chat/update_character/${characterId}`, {
                     method: 'PUT', headers: { 'Content-Type': 'application/json' },
                     body: JSON.stringify(characterData)
                 });
                 if (response.ok) outcomeCharacterId = characterId;
             } else { throw new Error("Invalid form mode or missing character ID for edit."); }

             if (!response.ok) {
                 const errorData = await response.json().catch(() => ({ detail: response.statusText }));
                 throw new Error(`Failed to ${mode} character: ${errorData.detail || response.statusText}`);
             }

             console.log(`Character ${mode === 'create' ? 'created' : 'updated'} successfully.`);
             characterModal.style.display = 'none';
             await populateCharacterSelect(); // Refresh dropdown

             // Reselect the character after create/edit and trigger update
             if (outcomeCharacterId) {
                 characterSelect.value = outcomeCharacterId;
                 // Trigger change event programmatically to ensure state/UI/backend sync
                 // Use await to ensure event processing finishes before potentially leaving the function
                 // Dispatching event needs to be synchronous, await is not needed here.
                 characterSelect.dispatchEvent(new Event('change', { bubbles: true }));
                 // No need for explicit updateCharacterActionButtons here,
                 // populateCharacterSelect and the change event handle it.
             }


        } catch (error) {
             console.error(`Error saving character (mode: ${mode}):`, error);
             alert(`Failed to save character: ${error.message}`);
        }
    });

    cancelCreateBtn.addEventListener('click', () => {
        characterModal.style.display = 'none';
    });

    // Close modal if background overlay is clicked
    characterModal.addEventListener('click', (e) => {
        if (e.target === characterModal) {
            characterModal.style.display = 'none';
        }
    });
}

function updateCharacterActionButtons() {
    const select = document.getElementById('character-select');
    const selectedId = select.value; // Read the *current* value from the DOM element
    const hasSelection = !!selectedId; // True if selectedId is not empty string or null/undefined

    document.getElementById('character-edit-btn').disabled = !hasSelection;
    document.getElementById('character-delete-btn').disabled = !hasSelection;
}

// --- Chat Actions ---

function startNewChat() {
    console.log("Starting new chat...");
    if (state.streamController || state.toolCallPending) {
         alert("Please wait for the current response or tool call to finish first."); return;
    }
    state.currentChatId = null; state.messages = [];
    messagesWrapper.innerHTML = '';
    welcomeContainer.style.display = 'flex'; // Show welcome message
    document.body.classList.add('welcome-active'); // Add class for centered input
    localStorage.removeItem('lastChatId');
    highlightCurrentChatInSidebar();
    // messageInput.focus(); // Keep commented out as per previous decision

    const selectedCharacterId = document.getElementById('character-select').value || null;
    state.currentCharacterId = selectedCharacterId;
    if (selectedCharacterId) {
         // Fetch character details to set activeSystemPrompt
         fetchCharacters().then(characters => { // TODO: Cache characters
             const selectedChar = characters.find(c => c.character_id === selectedCharacterId);
             state.activeSystemPrompt = selectedChar?.sysprompt || null;
             updateEffectiveSystemPrompt(); // Update combined prompt and display
         });
     } else {
         state.activeSystemPrompt = null;
         updateEffectiveSystemPrompt(); // Update combined prompt and display
     }
    state.currentImages = []; state.currentTextFiles = [];
    imagePreviewContainer.innerHTML = '';
    adjustTextareaHeight(); // Adjust height and padding (will remove chat padding)
    // Reset tool state for new chat
    state.toolCallPending = false;
    state.toolContinuationContext = null;
    state.currentToolCallId = null;
    state.abortingForToolCall = false; // Reset abort reason

    // Reset code block default for new chat
    state.codeBlocksDefaultCollapsed = false; // Default to expanded
    updateCodeblockToggleButton(); // Update the global button icon/title

    // Ensure chat container doesn't have leftover padding
    if (chatContainer) chatContainer.style.paddingBottom = '0px';
}

async function deleteCurrentChat() {
    if (!state.currentChatId) { alert("No chat selected to delete."); return; }
     if (state.streamController || state.toolCallPending) {
        alert("Please wait for the current response or tool call to finish before deleting."); return;
     }
    const chatPreview = state.chats.find(c => c.chat_id === state.currentChatId)?.preview || `Chat ${state.currentChatId.substring(0,6)}`;
    if (!confirm(`Are you sure you want to permanently delete this chat?\n"${chatPreview}"`)) { return; }
    console.log(`Deleting chat: ${state.currentChatId}`);
    try {
        const response = await fetch(`${API_BASE}/chat/${state.currentChatId}`, { method: 'DELETE' });
        if (!response.ok) { throw new Error(`Failed to delete chat: ${await response.text()}`); }
        console.log(`Chat ${state.currentChatId} deleted successfully.`);
        const deletedChatId = state.currentChatId;
        startNewChat(); // Go to new chat state
        state.chats = state.chats.filter(c => c.chat_id !== deletedChatId); // Update local list
        renderChatList(); // Re-render sidebar
    } catch (error) { console.error('Error deleting chat:', error); alert(`Failed to delete chat: ${error.message}`); }
}

// --- Theme & Settings ---
function setupThemeSwitch() {
    const themeModal = document.getElementById('theme-modal');
    const themes = {
        white: {
            '--bg-primary': '#ffffff', '--bg-secondary': '#f7f7f7', '--bg-tertiary': '#f0f0f0',
            '--text-primary': '#1f2328', '--text-secondary': '#57606a', '--accent-color': '#101010',
            '--accent-hover': '#1f2328', '--accent-color-highlight': 'rgba(31, 35, 40, 0.3)', '--error-color': '#d73a49', '--error-hover': '#b22222',
            '--message-user': '#f0f0f0', '--scrollbar-bg': '#f0f0f0',
            '--scrollbar-thumb': '#cccccc', '--border-color': '#d0d7de',
             '--tool-call-bg': 'rgba(0, 0, 0, 0.03)', '--tool-call-border': '#444',
             '--tool-result-bg': 'rgba(0, 0, 0, 0.02)', '--tool-result-border': '#aaa',
        },
        solarized: {
            '--bg-primary': '#fdf6e3', '--bg-secondary': '#eee8d5', '--bg-tertiary': '#e8e1cf',
            '--text-primary': '#657b83', '--text-secondary': '#839496', '--accent-color': '#2aa198', // Solarized Cyan
            '--accent-hover': '#217d77', '--accent-color-highlight': 'rgba(42, 161, 152, 0.3)', '--error-color': '#dc322f', '--error-hover': '#b52a27',
            '--message-user': '#eee8d5', '--scrollbar-bg': '#eee8d5',
            '--scrollbar-thumb': '#93a1a1', '--border-color': '#d9cfb3',
            '--tool-call-bg': 'rgba(42, 161, 152, 0.08)', '--tool-call-border': '#2aa198',
            '--tool-result-bg': 'rgba(147, 161, 161, 0.08)', '--tool-result-border': '#93a1a1',
        },
        dark: { // Default theme from original CSS
            '--bg-primary': '#0a0a10', '--bg-secondary': '#0f0f15', '--bg-tertiary': '#16161e',
            '--text-primary': '#e0e0e8', '--text-secondary': '#a0a0b0', '--accent-color': '#b86a38',
            '--accent-hover': '#d07c46', '--accent-color-highlight': 'rgba(184, 106, 56, 0.3)', '--error-color': '#e53e3e', '--error-hover': '#ff6666',
            '--message-user': '#141419', '--scrollbar-bg': '#1a1a24',
            '--scrollbar-thumb': '#38383f', '--border-color': '#2a2a38',
            // Tool colors updated with brownish-orange theme
            '--tool-call-bg': 'rgba(184, 106, 56, 0.08)', '--tool-call-border': '#b86a38',
            '--tool-result-bg': 'rgba(184, 106, 56, 0.05)', '--tool-result-border': '#9a5a30',
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
            '--message-user': '#f0f0f0', 
            '--scrollbar-bg': '#f0f0f0',
            '--scrollbar-thumb': '#cccccc', 
            '--border-color': '#e0e0e0',
            '--tool-call-bg': 'rgba(0, 0, 0, 0.03)', 
            '--tool-call-border': '#444',
            '--tool-result-bg': 'rgba(0, 0, 0, 0.02)', 
            '--tool-result-border': '#aaa',
        }
    };

    function applyTheme(themeName) {
         const theme = themes[themeName] || themes.dark; // Default to dark

         Object.entries(theme).forEach(([prop, value]) => {
             document.documentElement.style.setProperty(prop, value);
         });

         // Update highlight.js theme
         const highlightThemeLink = document.getElementById('highlight-theme');
         if (themeName === 'white') {
             highlightThemeLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css';
         } else if (themeName === 'solarized') {
             highlightThemeLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/base16/solarized-light.min.css';
        } else if (themeName === 'claude_white') {
            highlightThemeLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/base16/solarized-light.min.css';
         } else { // dark theme
            highlightThemeLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/stackoverflow-dark.css';
         }

          // Ensure custom style for background exists or update it
          let dynamicStyle = document.getElementById('dynamic-hljs-bg');
          if (!dynamicStyle) {
               dynamicStyle = document.createElement('style');
               dynamicStyle.id = 'dynamic-hljs-bg';
               document.head.appendChild(dynamicStyle);
          }
          // Apply background override based on theme's tertiary color
          dynamicStyle.textContent = `
          pre code.hljs { background: var(--bg-tertiary) !important; }
          .code-block-wrapper { background: var(--bg-tertiary) !important; }
          `;

         // Re-highlight existing code blocks after theme change
          setTimeout(() => {
              messagesWrapper.querySelectorAll('pre code').forEach(block => {
                   try { hljs.highlightElement(block); }
                   catch (e) { console.error("Error re-highlighting:", e); }
              });
          }, 100);

         localStorage.setItem('theme', themeName);
         console.log(`Theme applied: ${themeName}`);
    }

    // --- Event Listeners for Theme Modal ---
    document.querySelectorAll('.theme-option[data-theme]').forEach(button => {
        button.addEventListener('click', () => { applyTheme(button.dataset.theme); });
    });
    themeModal.addEventListener('click', (e) => { if (e.target === themeModal) themeModal.style.display = 'none'; });

    const savedTheme = localStorage.getItem('theme') || 'dark';
    applyTheme(savedTheme);
}


function setupGenerationSettings() {
    const genSettingsBtn = document.getElementById('gen-settings-btn');
    const modal = document.getElementById('gen-settings-modal');
    const applyBtn = document.getElementById('apply-gen-settings');
    const cancelBtn = document.getElementById('cancel-gen-settings');

    genSettingsBtn.addEventListener('click', () => { updateSlidersUI(); modal.style.display = 'flex'; });
    applyBtn.addEventListener('click', () => {
        defaultGenArgs.temperature = document.getElementById('temp-none').checked ? null : parseFloat(document.getElementById('temp-slider').value);
        defaultGenArgs.min_p = document.getElementById('minp-none').checked ? null : parseFloat(document.getElementById('minp-slider').value);
        defaultGenArgs.max_tokens = document.getElementById('maxt-none').checked ? null : parseInt(document.getElementById('maxt-slider').value);
        const topPSlider = document.getElementById('topp-slider');
        if (topPSlider) { defaultGenArgs.top_p = document.getElementById('topp-none')?.checked ? null : parseFloat(topPSlider.value); }
        else { defaultGenArgs.top_p = null; }

        localStorage.setItem('genArgs', JSON.stringify(defaultGenArgs));
        modal.style.display = 'none';
    });
    cancelBtn.addEventListener('click', () => modal.style.display = 'none');
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });

    const settingsConfig = [
        { prefix: 'temp', defaultVal: 0.7, stateKey: 'temperature' },
        { prefix: 'minp', defaultVal: 0.05, stateKey: 'min_p' },
        { prefix: 'maxt', defaultVal: 1024, stateKey: 'max_tokens' },
        { prefix: 'topp', defaultVal: 1.0, stateKey: 'top_p'} // Added Top P
    ];
    settingsConfig.forEach(({ prefix, defaultVal, stateKey }) => {
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
    updateSlidersUI(); // Initial UI update
}

// Helper to parse think block content and remaining text
function parseThinkContent(text) {
    let thinkContent = '';
    let remainingText = '';
    const thinkStartIndex = text.indexOf('<think>');
    if (thinkStartIndex === -1) {
        // Should not happen if called correctly, but handle anyway
        return { thinkContent: null, remainingText: text };
    }

    let thinkEndIndex = text.indexOf('</think>');
    if (thinkEndIndex === -1) {
        // No closing tag, capture till end
        thinkContent = text.substring(thinkStartIndex + '<think>'.length);
        remainingText = '';
    } else {
        thinkContent = text.substring(thinkStartIndex + '<think>'.length, thinkEndIndex);
        remainingText = text.substring(thinkEndIndex + '</think>'.length);
    }
    return { thinkContent: thinkContent.trim(), remainingText: remainingText.trim() };
}

// Added auto-removal timeout
function addSystemMessage(text, type = "info", timeout = null) { // type can be 'info', 'error', 'warning'
    console.log(`System Message [${type}]: ${text}`);
    const messageRow = document.createElement('div');
    messageRow.className = `system-info-row ${type}`; // Use distinct classes
    const iconClass = type === 'error' ? 'exclamation-octagon-fill' : (type === 'warning' ? 'exclamation-triangle-fill' : 'info-circle-fill');
    messageRow.innerHTML = `<i class="bi bi-${iconClass}"></i> <span>${text}</span>`; // Wrap text in span

    messagesWrapper.appendChild(messageRow);
    scrollToBottom(); // Scroll to show the message

    // Auto-remove if timeout is provided
    if (timeout && typeof timeout === 'number' && timeout > 0) {
        setTimeout(() => {
            messageRow.style.transition = 'opacity 0.5s ease';
            messageRow.style.opacity = '0';
            setTimeout(() => messageRow.remove(), 500); // Remove after fade out
        }, timeout);
    }
    else{
        setTimeout(() => {
            messageRow.style.transition = 'opacity 0.3s ease';
            messageRow.style.opacity = '0';
            setTimeout(() => messageRow.remove(), 300); // Remove after fade out
        }, 300);
    }
}

// Start the Application
document.addEventListener('DOMContentLoaded', init);
