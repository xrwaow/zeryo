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

// State Management
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
    userHasScrolled: false,
    lastScrollTop: 0,
    isAutoScrolling: true,
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

// Render markdown with think block handling and LaTeX rendering
// ADDED: Optional temporaryId for state preservation during streaming
function renderMarkdown(text, initialCollapsedState = true, temporaryId = null) {
    let processedText = text || ''; // Ensure text is a string
    const thinkBlockPlaceholder = '___THINK_BLOCK_PLACEHOLDER___';
    let html = '';
    let thinkContent = '';
    let remainingTextAfterThink = '';
    let isThinkBlockMessage = processedText.trim().startsWith('<think>');

    if (isThinkBlockMessage) {
        const thinkStartIndex = processedText.indexOf('<think>');
        let thinkEndIndex = processedText.indexOf('</think>');
        if (thinkEndIndex === -1) {
            thinkEndIndex = processedText.length;
            thinkContent = processedText.substring(thinkStartIndex + '<think>'.length);
            remainingTextAfterThink = '';
        } else {
            thinkContent = processedText.substring(thinkStartIndex + '<think>'.length, thinkEndIndex);
            remainingTextAfterThink = processedText.substring(thinkEndIndex + '</think>'.length);
        }

        // --- Create Think Block Structure ---
        const thinkBlockWrapper = document.createElement('div');
        thinkBlockWrapper.className = `think-block ${initialCollapsedState ? 'collapsed' : ''}`;
        // Add temporary ID if provided (for state tracking during stream)
        if (temporaryId) {
            thinkBlockWrapper.dataset.tempId = temporaryId;
        }

        // Header
        const header = document.createElement('div');
        header.className = 'think-header';
        const titleSpan = document.createElement('span');
        titleSpan.className = 'think-header-title';
        titleSpan.innerHTML = '<i class="bi bi-lightbulb"></i> Thought Process';
        header.appendChild(titleSpan);
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'think-header-actions';
        const collapseBtn = document.createElement('button');
        collapseBtn.className = 'think-block-toggle';
        collapseBtn.innerHTML = `<i class="bi bi-chevron-${initialCollapsedState ? 'down' : 'up'}"></i>`;
        collapseBtn.title = `${initialCollapsedState ? 'Expand' : 'Collapse'} thought process`;
        actionsDiv.appendChild(collapseBtn);
        header.appendChild(actionsDiv);
        thinkBlockWrapper.appendChild(header);

        // Content Div
        const thinkContentDiv = document.createElement('div');
        thinkContentDiv.className = 'think-content';
        thinkContentDiv.innerHTML = marked.parse(thinkContent.trim());
        // Note: Highlighting inside think block is now done in buildContentHtml *after* insertion
        thinkBlockWrapper.appendChild(thinkContentDiv);

        html += thinkBlockWrapper.outerHTML;
        processedText = remainingTextAfterThink;
    }

    // --- Process remaining text ---
    if (processedText) {
        // ... (rest of the function for processing non-think text remains the same) ...
        const parts = [];
        let lastIndex = 0;
        const blockRegex = /(```[\s\S]*?```)/g;
        let match;

        while ((match = blockRegex.exec(processedText)) !== null) {
            const beforeBlock = processedText.slice(lastIndex, match.index);
            parts.push(beforeBlock.replace(/</g, '<').replace(/>/g, '>'));
            parts.push(match[0]);
            lastIndex = blockRegex.lastIndex;
        }
        const remaining = processedText.slice(lastIndex);
        parts.push(remaining.replace(/</g, '<').replace(/>/g, '>'));

        const escapedProcessedText = parts.join('');
        let remainingHtml = marked.parse(escapedProcessedText);

        // LaTeX processing remains the same
        remainingHtml = remainingHtml.replace(/\$\$([\s\S]+?)\$\$/g, (match, latex) => {
            try {
                const decodedLatex = latex.replace(/</g, '<').replace(/>/g, '>').replace(/&/g, '&');
                return katex.renderToString(decodedLatex.trim(), { displayMode: true, throwOnError: false });
            } catch (e) { console.error('KaTeX block rendering error:', e, "Input:", latex); return `<span class="katex-error">[Block LaTeX Error]</span>`; }
        });
        remainingHtml = remainingHtml.replace(/(?<!\$)\$([^$\n]+?)\$(?!\$)/g, (match, latex) => {
            try {
                 const decodedLatex = latex.replace(/</g, '<').replace(/>/g, '>').replace(/&/g, '&');
                return katex.renderToString(decodedLatex.trim(), { displayMode: false, throwOnError: false });
            } catch (e) { console.error('KaTeX inline rendering error:', e, "Input:", latex); return `<span class="katex-error">[Inline LaTeX Error]</span>`; }
        });

        html += remainingHtml;
    }

    return html;
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
    adjustTextareaHeight(); // Call initially to set correct height/padding
    setupDropZone();
    setupThemeSwitch();
    setupGenerationSettings();
    setupToolToggle(); // Setup the new button listener

    // --- MODIFIED ---
    // Always start with a new chat interface instead of loading the last one.
    // populateCharacterSelect above already handled restoring the last selected character
    // into the dropdown. startNewChat will read this dropdown value.
    startNewChat();
    // --- END MODIFICATION ---

    applySidebarState(); // Apply sidebar collapsed/expanded state
    // updateCharacterActionButtons is called by populateCharacterSelect/characterSelect change handler
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

        item.addEventListener('click', () => {
             if (state.currentChatId !== chat.chat_id) {
                 loadChat(chat.chat_id);
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
    state.isAutoScrolling = true; state.userHasScrolled = false;
    state.toolCallPending = false; // Reset tool state on chat load
    state.toolContinuationContext = null;

    // Abort any ongoing stream before loading a new chat
    if (state.streamController && !state.streamController.signal.aborted) {
        console.log("Aborting active stream before loading new chat.");
        state.streamController.abort();
        // Cleanup might be needed if abort doesn't trigger onError properly
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
        state.activeSystemPrompt = null; // Reset base prompt

        localStorage.setItem('lastChatId', chatId);
        document.getElementById('character-select').value = state.currentCharacterId || '';

        // Fetch character details if associated
        if (state.currentCharacterId) {
             try {
                  const charResponse = await fetch(`${API_BASE}/chat/get_character/${state.currentCharacterId}`);
                  if (charResponse.ok) {
                       const activeChar = await charResponse.json();
                       state.activeSystemPrompt = activeChar?.sysprompt || null;
                  } else { console.warn(`Failed to fetch character ${state.currentCharacterId} details.`); }
             } catch (charError) { console.error("Error fetching character details:", charError); }
        }
        updateEffectiveSystemPrompt(); // Update combined prompt and display banner

        messagesWrapper.innerHTML = ''; // Clear old messages
        highlightCurrentChatInSidebar();

        // Determine if welcome screen should be active
        const hasVisibleMessages = state.messages.some(m => m.role !== 'system');
        if (!hasVisibleMessages) {
             welcomeContainer.style.display = 'flex';
             document.body.classList.add('welcome-active');
             if (chatContainer) chatContainer.style.paddingBottom = '0px'; // No padding for welcome
        } else {
             welcomeContainer.style.display = 'none';
             document.body.classList.remove('welcome-active');
             renderActiveMessages(); // Render the messages for the loaded chat
             adjustTextareaHeight(); // Adjust padding for messages
        }

    } catch (error) {
        console.error('Error loading chat:', error);
        messagesWrapper.innerHTML = `<div class="system-message error">Failed to load chat: ${error.message}</div>`;
        welcomeContainer.style.display = 'none';
        document.body.classList.remove('welcome-active');
        state.currentChatId = null;
        highlightCurrentChatInSidebar();
    } finally {
        // Scroll to bottom after rendering (if not welcome screen)
        if (!document.body.classList.contains('welcome-active')) {
             setTimeout(() => {
                 // Scroll only if user hasn't manually scrolled up during load
                 if (!state.userHasScrolled) {
                     scrollToBottom('auto'); // Use instant scroll on load
                 }
                 state.isAutoScrolling = false; // Allow user scrolling after initial load
             }, 100); // Delay slightly for render
        } else {
             state.isAutoScrolling = false; // Not auto-scrolling on welcome screen
        }
    }
}

function renderActiveMessages() {
    messagesWrapper.innerHTML = ''; // Clear previous render
    state.activeBranchInfo = {}; // Reset derived branch info

    if (!state.messages || state.messages.length === 0) {
        console.log("No messages to render.");
        // Ensure welcome screen logic is handled by caller (loadChat)
        return;
    }

    // Build tree structure from flat list
    const messageMap = new Map(state.messages.map(msg => [msg.message_id, { ...msg, children: [] }]));
    const rootMessages = [];

    state.messages.forEach(msg => {
        if (msg.role === 'system') return; // Don't render system messages directly

        const msgNode = messageMap.get(msg.message_id);
        if (!msgNode) return; // Should not happen

        if (msg.parent_message_id && messageMap.has(msg.parent_message_id)) {
            const parentNode = messageMap.get(msg.parent_message_id);
            if (!parentNode.children) parentNode.children = [];
            parentNode.children.push(msgNode);
        } else if (!msg.parent_message_id) { // Only add true roots
            rootMessages.push(msgNode);
        }
    });

    // Sort children and roots by timestamp
    messageMap.forEach(node => {
        if (node.children && node.children.length > 0) {
            node.children.sort((a, b) => a.timestamp - b.timestamp);
             // Derive branch info for UI display where multiple children exist
             if (node.child_message_ids && node.child_message_ids.length > 1) {
                  state.activeBranchInfo[node.message_id] = {
                      // Use active_child_index from the message data, default 0
                      activeIndex: node.active_child_index ?? 0,
                      totalBranches: node.child_message_ids.length
                  };
             }
        }
    });
    rootMessages.sort((a, b) => a.timestamp - b.timestamp);

    // Recursive function to render the active branch
    function renderBranch(messageNode) {
        if (!messageNode || messageNode.role === 'system') return;

        addMessage(messageNode); // Render the current node

        const children = messageNode.children; // Already sorted by timestamp
        if (children && children.length > 0) {
            // Determine the active child based on backend data
            const activeIndex = messageNode.active_child_index ?? 0;
            const safeActiveIndex = Math.min(Math.max(0, activeIndex), children.length - 1);
            const activeChildNode = children[safeActiveIndex];

            if (activeChildNode) {
                renderBranch(activeChildNode); // Recursively render the active child's branch
            } else {
                 console.warn(`Could not find active child at index ${safeActiveIndex} for message ${messageNode.message_id}`);
            }
        }
    }

    // Start rendering from each root node
    rootMessages.forEach(rootNode => renderBranch(rootNode));

    // Final post-processing (code block wrapping/highlighting) - Deferred
    requestAnimationFrame(() => {
         messagesWrapper.querySelectorAll('pre code').forEach(block => {
            highlightRenderedCode(block.parentElement); // Pass the <pre> element
         });
    });
}

// Helper function to create a code block with header and content
function createCodeBlockWithContent(codeText, lang = '') {
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper'; // Add base class

    // Create header
    const header = document.createElement('div');
    header.className = 'code-header';

    // File type/language
    const filetypeSpan = document.createElement('span');
    filetypeSpan.className = 'code-header-filetype';
    let cleanLang = lang || 'code'; // Use provided lang or default
    filetypeSpan.textContent = cleanLang;
    header.appendChild(filetypeSpan);

    // Actions (copy, collapse/expand)
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'code-header-actions';

    // Collapse/Expand button
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'code-header-btn collapse-btn';
    collapseBtn.innerHTML = '<i class="bi bi-chevron-up"></i>'; // Start expanded
    collapseBtn.title = 'Collapse code';

    // Info span for collapsed state (initially hidden)
    const collapseInfoSpan = document.createElement('span');
    collapseInfoSpan.className = 'collapse-info'; // Class to toggle display
    collapseInfoSpan.style.display = 'none'; // Hidden by default

    actionsDiv.appendChild(collapseInfoSpan); // Add info span next to button area
    actionsDiv.appendChild(collapseBtn); // Add collapse button

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'code-header-btn copy-btn';
    copyBtn.innerHTML = '<i class="bi bi-clipboard"></i> Copy';
    copyBtn.title = 'Copy code';
    actionsDiv.appendChild(copyBtn); // Add copy button

    header.appendChild(actionsDiv);

    // Create new <pre> and <code> elements
    const newPre = document.createElement('pre');
    const newCode = document.createElement('code');
    // Set language class for hljs
    if (lang) {
        newCode.className = `language-${lang}`;
    }
    newCode.textContent = codeText; // Set the text content

    // Highlight the *new* code block
    try {
       hljs.highlightElement(newCode);
    } catch(e) {
        console.error("Error highlighting newly created code block:", e);
    }

    newPre.appendChild(newCode); // Add code to pre
    wrapper.appendChild(header);
    wrapper.appendChild(newPre); // Add pre to wrapper


    // --- Add Event Listeners ---
    copyBtn.addEventListener('click', (e) => {
        navigator.clipboard.writeText(newCode.textContent).then(() => { // Use newCode.textContent
             copyBtn.innerHTML = '<i class="bi bi-check-lg"></i> Copied';
             copyBtn.disabled = true;
             setTimeout(() => {
                copyBtn.innerHTML = '<i class="bi bi-clipboard"></i> Copy';
                copyBtn.disabled = false;
             }, 1500);
        }).catch(err => {
             console.error('Failed to copy code:', err);
        });
        e.stopPropagation();
    });

    collapseBtn.addEventListener('click', (e) => {
        const isCollapsed = wrapper.classList.toggle('collapsed');
        const icon = collapseBtn.querySelector('i');

        if (isCollapsed) {
            icon.className = 'bi bi-chevron-down';
            collapseBtn.title = 'Expand code';
            const lines = newCode.textContent.split('\n').length;
            const lineCount = newCode.textContent.endsWith('\n') ? lines - 1 : lines;
            collapseInfoSpan.textContent = `${lineCount} lines hidden`;
            collapseInfoSpan.style.display = 'inline-block';
             newPre.style.display = 'none';
        } else {
            icon.className = 'bi bi-chevron-up';
            collapseBtn.title = 'Collapse code';
            collapseInfoSpan.style.display = 'none';
            newPre.style.display = '';
        }
        e.stopPropagation();
    });


    return wrapper;
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

// --- buildContentHtml (REVISED: Removed internal highlighting call) ---
function buildContentHtml(targetContentDiv, messageText, isStreaming = false) {
    const textToParse = messageText || '';
    const thinkBlockTempId = 'streaming-think-block';
    const remainingContentTempId = 'streaming-remaining-content'; // ID for content after think block

    // --- Handle Think Block Messages ---
    if (textToParse.trim().startsWith('<think>')) {
        const { thinkContent, remainingText } = parseThinkContent(textToParse);
        let existingThinkBlock = null;
        let thinkBlockWasCollapsed = true; // Default

        if (isStreaming) {
            existingThinkBlock = targetContentDiv.querySelector(`.think-block[data-temp-id="${thinkBlockTempId}"]`);
            if (existingThinkBlock) {
                thinkBlockWasCollapsed = existingThinkBlock.classList.contains('collapsed');
            }
        }

        if (isStreaming && existingThinkBlock) {
            // --- Targeted Update (Think Block) ---
            const existingThinkContentDiv = existingThinkBlock.querySelector('.think-content');
            if (existingThinkContentDiv) {
                const newThinkHtml = marked.parse(thinkContent || '');
                 // Update only if different to avoid minor flicker
                 if (existingThinkContentDiv.innerHTML !== newThinkHtml) {
                     existingThinkContentDiv.innerHTML = newThinkHtml;
                     // No immediate highlight here
                 }
            } else {
                 console.warn("Could not find existing .think-content for targeted update.");
            }
            let remainingContentDiv = targetContentDiv.querySelector(`div[data-temp-id="${remainingContentTempId}"]`);
            if (remainingText) {
                const newRemainingHtml = renderMarkdown(remainingText);
                if (!remainingContentDiv) {
                    remainingContentDiv = document.createElement('div');
                    remainingContentDiv.dataset.tempId = remainingContentTempId;
                    targetContentDiv.appendChild(remainingContentDiv);
                }
                 // Update only if different
                 if (remainingContentDiv.innerHTML !== newRemainingHtml) {
                     remainingContentDiv.innerHTML = newRemainingHtml;
                     // No immediate highlight here
                 }
            } else if (remainingContentDiv) {
                remainingContentDiv.remove();
            }
            // --- End Targeted Update (Think Block) ---
        } else {
            // --- Full Redraw (Think Block - Not streaming, or first chunk) ---
            const fullRenderedHtml = renderMarkdown(textToParse, thinkBlockWasCollapsed, isStreaming ? thinkBlockTempId : null);
            targetContentDiv.innerHTML = fullRenderedHtml; // Clears old content implicitly
             if (remainingText && isStreaming) {
                 const thinkBlockElement = targetContentDiv.querySelector(`.think-block[data-temp-id="${thinkBlockTempId}"]`);
                 const nodesAfter = [];
                 let currentNode = thinkBlockElement?.nextSibling;
                 while(currentNode) {
                     nodesAfter.push(currentNode);
                     currentNode = currentNode.nextSibling;
                 }
                 if (nodesAfter.length > 0) {
                      const wrapper = document.createElement('div');
                      wrapper.dataset.tempId = remainingContentTempId;
                      nodesAfter.forEach(node => wrapper.appendChild(node));
                      targetContentDiv.appendChild(wrapper);
                 }
             }
             // No immediate highlight here
            // --- End Full Redraw (Think Block) ---
        }
    }
    // --- Handle Non-Think Block Messages ---
    else {
        // Logic remains the same, using full redraw based on marked + tool tags
        targetContentDiv.innerHTML = ''; // Clear content

        let lastIndex = 0;
        TOOL_TAG_REGEX.lastIndex = 0;
        let match;

        while ((match = TOOL_TAG_REGEX.exec(textToParse)) !== null) {
            const textBefore = textToParse.substring(lastIndex, match.index);
            if (textBefore) {
                // Use renderMarkdown which uses marked.parse internally
                const renderedHtml = renderMarkdown(textBefore);
                targetContentDiv.insertAdjacentHTML('beforeend', renderedHtml);
            }

            const fullTag = match[0];
            const toolCallTag = match[1];
            const toolResultTag = match[4];

            if (toolCallTag) {
                const toolName = match[2];
                const attrsString = match[3] || "";
                const toolArgs = parseAttributes(attrsString);
                renderToolCallPlaceholder(targetContentDiv, toolName, toolArgs);
            } else if (toolResultTag) {
                const toolName = match[5];
                let resultString = match[6] || "";
                resultString = resultString.replace(/"/g, '"');
                renderToolResult(targetContentDiv, resultString);
            }

            lastIndex = TOOL_TAG_REGEX.lastIndex;
        }

        const remainingText = textToParse.substring(lastIndex);
        if (remainingText) {
             // Use renderMarkdown which uses marked.parse internally
            const renderedHtml = renderMarkdown(remainingText);
            targetContentDiv.insertAdjacentHTML('beforeend', renderedHtml);
        }
         // REMOVED highlight call: targetContentDiv.querySelectorAll('pre code').forEach(block => highlightRenderedCode(block));
    }
}


// --- addMessage (MODIFIED) ---
// Uses the new buildContentHtml helper function
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

    // Standard Action Buttons (unchanged)
    const copyBtn = document.createElement('button');
    copyBtn.className = 'message-action-btn';
    copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>';
    copyBtn.title = 'Copy message text';
    copyBtn.addEventListener('click', () => copyMessageContent(contentDiv, copyBtn));
    actionsDiv.appendChild(copyBtn);

    const editBtn = document.createElement('button');
    editBtn.className = 'message-action-btn';
    editBtn.innerHTML = '<i class="bi bi-pencil"></i>';
    editBtn.title = 'Edit message';
    editBtn.addEventListener('click', () => startEditing(message.message_id));
    actionsDiv.appendChild(editBtn); // Hide later for tool messages if needed

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

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'message-action-btn delete-btn';
    deleteBtn.innerHTML = '<i class="bi bi-trash"></i>';
    deleteBtn.title = 'Delete message (and descendants)';
    deleteBtn.addEventListener('click', () => deleteMessage(message.message_id));
    actionsDiv.appendChild(deleteBtn);


    // --- Render Content based on Role ---
    if (role === 'user') {
        // Directly set text content for user messages, render as markdown
        contentDiv.innerHTML = renderMarkdown(message.message || '');
    } else if (role === 'assistant') {
        // Use the helper function to parse tool tags and render markdown segments
        buildContentHtml(contentDiv, message.message);
    } else if (role === 'tool') {
        // Tool messages are not expected directly with the placeholder approach
        // If they were saved separately, render them here.
        // Tool role messages contain the raw result text.
        contentDiv.textContent = `[Tool Result: ${message.message}]`; // Simple display
        editBtn.style.display = 'none'; // Cannot edit tool results this way
    }

    // Append the content div to the main message container
    messageDiv.appendChild(contentDiv);

    // Highlight code blocks *after* setting innerHTML and building content
    contentDiv.querySelectorAll('pre code').forEach(block => {
       highlightRenderedCode(block); // Pass the code block itself
    });

    // --- Attachments Display (Append to contentDiv) ---
    if (message.attachments && message.attachments.length > 0) {
        const attachmentsContainer = document.createElement('div');
        attachmentsContainer.className = 'attachments-container';
        message.attachments.forEach(attachment => {
             let rawContent = attachment.content;
             // Simplified attachment rendering logic (no change needed here)
             if (attachment.type === 'image') {
                 const imgWrapper = document.createElement('div');
                 imgWrapper.className = 'attachment-preview image-preview-wrapper';
                 imgWrapper.addEventListener('click', () => viewAttachmentPopup({...attachment, rawContent}));
                 const img = document.createElement('img');
                 img.src = `data:image/jpeg;base64,${attachment.content}`;
                 img.alt = attachment.name || 'Attached image';
                 imgWrapper.appendChild(img);
                 attachmentsContainer.appendChild(imgWrapper);
             } else if (attachment.type === 'file') {
                 const fileWrapper = document.createElement('div');
                 fileWrapper.className = 'attachment-preview file-preview-wrapper';
                 // Attempt to parse raw content from formatted string for popup viewing
                 const match = attachment.content.match(/^.*:\n```[^\n]*\n([\s\S]*)\n```$/);
                 if (match && match[1]) { rawContent = match[1]; }
                 fileWrapper.addEventListener('click', () => viewAttachmentPopup({...attachment, rawContent}));
                 const filename = attachment.name || 'Attached File';
                 fileWrapper.innerHTML = `<i class="bi bi-file-earmark-text"></i> <span>${filename}</span>`;
                 attachmentsContainer.appendChild(fileWrapper);
             }
        });
        contentDiv.appendChild(attachmentsContainer); // Append attachments *inside* contentDiv
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

// --- Edit/Delete Message (MODIFIED) ---
async function deleteMessage(messageId) {
    if (!state.currentChatId) return;

    const messageText = state.messages.find(m => m.message_id === messageId)?.message || `message ID ${messageId}`;
    if (!confirm(`Are you sure you want to delete this message and all its subsequent responses/branches?\n"${messageText.substring(0, 50)}..."`)) {
         return;
    }

    console.log(`Deleting message ${messageId} and descendants.`);

    try {
        const response = await fetch(`${API_BASE}/chat/${state.currentChatId}/delete_message/${messageId}`, {
            method: 'POST' // Changed to POST
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ detail: response.statusText }));
            throw new Error(`Failed to delete message: ${errorData.detail || response.statusText}`);
        }

        await loadChat(state.currentChatId);
        await fetchChats(); // Update sidebar as well

    } catch (error) {
        console.error('Error deleting message:', error);
        alert(`Failed to delete message: ${error.message}`);
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
    // Prevent editing tool result messages directly
    if (message.role === 'tool') {
         alert("Cannot edit tool result messages.");
         return;
    }

    const originalContentHTML = contentDiv.innerHTML;
    const originalActionsDisplay = actionsDiv ? actionsDiv.style.display : '';
    // Also hide any tool call blocks during edit
    const toolCallBlocks = messageRow.querySelectorAll('.tool-call-block, .tool-result-block'); // Hide both types

    contentDiv.classList.add('editing');
    if (actionsDiv) actionsDiv.style.display = 'none';
    toolCallBlocks.forEach(el => el.style.display = 'none');
    contentDiv.innerHTML = ''; // Clear current content

    const textarea = document.createElement('textarea');
    textarea.className = 'edit-textarea';
    textarea.value = message.message; // Use the raw text content
    textarea.rows = Math.min(20, Math.max(3, message.message.split('\n').length + 1));

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
        toolCallBlocks.forEach(el => el.style.display = ''); // Show tool calls/results again
    };

    buttonContainer.appendChild(saveButton);
    buttonContainer.appendChild(cancelButton);

    contentDiv.appendChild(textarea);
    contentDiv.appendChild(buttonContainer);

    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
}


async function saveEdit(messageId, newText, role) {
     const originalMessage = state.messages.find(m => m.message_id === messageId);
     if (!originalMessage) return;

    console.log(`Saving edit for message ${messageId}`);

    // Preserve original attachments when editing text
    const attachmentsForSave = (originalMessage.attachments || []).map(att => ({
        type: att.type,
        content: att.content,
        name: att.name
    }));
     // Preserve original tool calls if editing an assistant message that made them
     // NOTE: With the current frontend tool flow, `tool_calls` on the assistant message
     // might not be stored in the DB unless explicitly added. We preserve it if it exists.
     const toolCallsForSave = originalMessage.tool_calls || null;

    try {
        const response = await fetch(`${API_BASE}/chat/${state.currentChatId}/edit_message/${messageId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                 message: newText,
                 model_name: originalMessage.model_name,
                 attachments: attachmentsForSave,
                 tool_calls: toolCallsForSave // Include tool calls if they existed
            })
        });
        if (!response.ok) {
             const errorData = await response.json().catch(() => ({ detail: response.statusText }));
            throw new Error(`Failed to edit message: ${errorData.detail || response.statusText}`);
        }

        await loadChat(state.currentChatId);

    } catch (error) {
        console.error('Error editing message:', error);
        alert(`Failed to save changes: ${error.message}`);
    }
}

function copyMessageContent(contentDiv, buttonElement) {
    // Try to get raw text, fallback to textContent
    // Exclude tool calls/results from direct copy if possible, focus on text content
    let textToCopy = contentDiv.dataset.raw || '';
    if (!textToCopy) {
        // Fallback: try to reconstruct text from parts, excluding known tool blocks
        let tempText = '';
        contentDiv.childNodes.forEach(node => {
            if (node.nodeType === Node.TEXT_NODE) {
                tempText += node.textContent;
            } else if (node.nodeType === Node.ELEMENT_NODE
                       && !node.classList.contains('attachments-container')
                       && !node.classList.contains('tool-call-block') // Exclude tool call block
                       && !node.classList.contains('tool-result-block')) // Exclude tool result block
            {
                // Basic attempt to get text from non-attachment/tool elements
                tempText += node.textContent + '\n'; // Add newline for block elements maybe?
            }
        });
        textToCopy = tempText.trim();
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
        console.error('Failed to copy message content:', err);
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
    messagesWrapper.addEventListener('click', handleThinkBlockToggle); // Existing listener
    messagesWrapper.addEventListener('click', handleToolBlockToggle); // ADDED: Listener for tool blocks
    // Settings button now opens theme modal (API key settings removed)
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

function createScrollHandler() {
     let localUserScrolled = false;
     let localLastScrollTop = chatContainer.scrollTop;
     return () => {
         const currentScrollTop = chatContainer.scrollTop;
         const scrollHeight = chatContainer.scrollHeight;
         const clientHeight = chatContainer.clientHeight;
         const scrollDirection = currentScrollTop > localLastScrollTop ? 'down' : 'up';
         localLastScrollTop = currentScrollTop;
         if (scrollDirection === 'up' && currentScrollTop < scrollHeight - clientHeight - 100) {
             localUserScrolled = true;
             state.userHasScrolled = true;
             state.isAutoScrolling = false;
         }
     };
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


// Helper to format messages for different providers
function formatMessagesForProvider(messages, provider) {
    console.log(`Formatting ${messages.length} messages for provider: ${provider}`);
    const formatted = [];
    for (const msg of messages) {
        let role = msg.role; // user, llm, system, tool
        let contentParts = [];

        // Skip tool messages if provider doesn't support them directly
        // Note: This frontend approach manually adds tool results later anyway,
        // but good practice if using native tool calling.
        // if (role === 'tool' && provider !== 'google') { continue; } // Example

        // Normalize role names
        if (provider === 'google') {
            role = (role === 'llm') ? 'model' : (role === 'assistant' ? 'model' : role);
            // Google uses 'function' role for tool results, but we add manually here
        } else { // OpenAI / OpenRouter / Local
            role = (role === 'llm') ? 'assistant' : role;
            // OpenAI uses 'tool' role
        }


        // --- Content Handling (Text + Attachments) ---
        // Add text content first
        if (msg.message && msg.message.trim() !== "") {
            if (provider === 'google') {
                // Google expects alternating user/model roles for text/images
                contentParts.push({ text: msg.message }); // Wrap text in object
            } else {
                contentParts.push({ type: "text", text: msg.message });
            }
        }

        // Add attachments
        for (const attachment of msg.attachments || []) {
            if (attachment.type === 'image') {
                if (attachment.content) {
                    if (provider === 'google') {
                        contentParts.push({ inline_data: { mime_type: "image/jpeg", data: attachment.content } });
                    } else {
                        contentParts.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${attachment.content}` } });
                    }
                } else { console.warn("Skipping image attachment with missing content:", attachment.name); }
            } else if (attachment.type === 'file') {
                const fileContent = attachment.content; // Pre-formatted content
                if (fileContent) {
                    // Append file content to the last text part if possible
                    if (provider === 'google') {
                        const lastTextPart = contentParts.findLast(p => p.text !== undefined);
                        if (lastTextPart) { lastTextPart.text += `\n${fileContent}`; }
                        else { contentParts.push({ text: fileContent }); } // Add as new part if no prior text
                    } else { // OpenAI format
                        const lastTextPart = contentParts.findLast(p => p.type === 'text');
                        if (lastTextPart) { lastTextPart.text += `\n${fileContent}`; }
                        else { contentParts.push({ type: "text", text: fileContent }); }
                    }
                } else { console.warn("Skipping file attachment with missing content:", attachment.name); }
            }
        }
        // --- End Content Handling ---

        // --- Tool Call/Result Formatting (for native support, less relevant here) ---
        if (role === 'assistant' && msg.tool_calls && provider !== 'google') { // OpenAI format
            // Native tool calls are added directly to the assistant message
            formatted.push({ role: role, content: contentParts, tool_calls: msg.tool_calls });
        } else if (role === 'tool' && provider !== 'google') { // OpenAI format
             // Native tool results require content and tool_call_id
             formatted.push({ role: role, content: msg.message, tool_call_id: msg.tool_call_id });
        } else if (contentParts.length > 0) { // Standard message or Google
            if (provider === 'google') {
                // Google needs 'parts' array
                formatted.push({ role: role, parts: contentParts });
            } else {
                // Standard message without tool calls for OpenAI format
                formatted.push({ role: role, content: contentParts });
            }
        } else { console.log(`Skipping message with no content parts (Role: ${role}, Provider: ${provider})`); }
    }

     // Provider specific validation/cleaning (Example: remove consecutive messages)
     const cleaned = [];
     let lastRole = null;
     for (const msg of formatted) {
          // Allow consecutive tool messages for OpenAI native flow
          if (msg.role !== 'system' && msg.role === lastRole && provider !== 'google' && msg.role !== 'tool' && lastRole !== 'assistant' /* Allow tool after assistant */) {
              console.warn(`Skipping consecutive message with role ${msg.role} for ${provider}`); continue;
          }
          if (provider !== 'google' && msg.content && Array.isArray(msg.content) && msg.content.length === 0) {
               console.warn(`Skipping message with empty content array (Role: ${msg.role})`); continue;
          }
           if (provider === 'google' && Array.isArray(msg.parts) && msg.parts.length === 0) {
                console.warn(`Skipping message with empty parts array (Role: ${msg.role})`); continue;
           }
          cleaned.push(msg);
          lastRole = msg.role;
     }
      if (provider === 'google' && cleaned.length > 0 && cleaned[cleaned.length - 1].role === 'model') {
           console.warn("Last message is 'model' for Google, API might require 'user'.");
       }

    return cleaned;
}


// --- streamLLMResponse (MODIFIED: onChunk post-processing for early code block headers) ---
async function streamLLMResponse(provider, modelIdentifier, messages, genArgs, onChunk, onComplete, onError, onToolCallDetected) {
    console.log(`streamLLMResponse called for provider: ${provider}, model: ${modelIdentifier}`);
    const apiKey = getApiKey(provider);
    const lowerProvider = provider.toLowerCase();

    if (!apiKey && lowerProvider !== 'local') {
        onError(new Error(`API Key for ${provider} not configured.`));
        return;
    }

    let url = '';
    let headers = { 'Content-Type': 'application/json' };
    let body = {};
    const filteredGenArgs = {};
    for (const key in genArgs) {
        if (genArgs[key] !== null && genArgs[key] !== undefined) {
            filteredGenArgs[key] = genArgs[key];
        }
    }

    // Provider Specific Setup (Ensure OpenRouter body matches expectations)
     if (lowerProvider === 'openrouter') {
        url = `${PROVIDER_CONFIG.openrouter_base_url}/chat/completions`;
        headers['Authorization'] = `Bearer ${apiKey}`;
        headers['HTTP-Referer'] = window.location.origin; // Recommended
        headers['X-Title'] = "Zeryo Chat"; // Recommended
        body = {
             model: modelIdentifier,
             messages: formatMessagesForProvider(messages, lowerProvider),
             stream: true,
             ...filteredGenArgs
        };
    } else if (lowerProvider === 'google') {
        url = `https://generativelanguage.googleapis.com/v1beta/models/${modelIdentifier}:streamGenerateContent?key=${apiKey}&alt=sse`;
        const formattedMsgs = formatMessagesForProvider(messages, lowerProvider);
        const generationConfig = {};
        if (filteredGenArgs.temperature !== undefined) generationConfig.temperature = filteredGenArgs.temperature;
        if (filteredGenArgs.top_p !== undefined) generationConfig.topP = filteredGenArgs.top_p;
        if (filteredGenArgs.max_tokens !== undefined) generationConfig.maxOutputTokens = filteredGenArgs.max_tokens;
        body = { contents: formattedMsgs, generationConfig: generationConfig };
    } else if (lowerProvider === 'local') {
        url = `${PROVIDER_CONFIG.local_base_url.replace(/\/$/, '')}/v1/chat/completions`;
        if (state.apiKeys.local) { headers['Authorization'] = `Bearer ${state.apiKeys.local}`; }
        // Local models might support tool tags directly, but reasoning isn't standard
        body = {
            model: modelIdentifier,
            messages: formatMessagesForProvider(messages, lowerProvider),
            stream: true,
            ...filteredGenArgs
        };
    } else {
        onError(new Error(`Unsupported provider: ${provider}`));
        return;
    }

    if (!state.streamController) {
        state.streamController = new AbortController();
    }
    let accumulatedText = ''; // Buffer for regex checking (for tool calls)
    let isStreamingReasoning = false; // <<< NEW state for OpenRouter reasoning

    try {
        console.log("Making fetch request to:", url);
        const response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(body),
            signal: state.streamController.signal
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => `HTTP ${response.status}`);
            let errorDetail = errorText;
            try { const errorJson = JSON.parse(errorText); errorDetail = errorJson.error?.message || errorJson.detail || JSON.stringify(errorJson.error) || errorText; } catch {}
            throw new Error(`API Error (${response.status}): ${errorDetail}`);
        }

        if (!response.body) { throw new Error("Response body is missing."); }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // --- Stream Reading Loop (Modified for OpenRouter Reasoning) ---
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                console.log("LLM Stream finished reading.");
                // If we were streaming reasoning when the stream ended, close the tag
                if (isStreamingReasoning) {
                    console.log("Stream ended while reasoning, adding closing tag.");
                    onChunk("</think>\n", true); // Pass finalChunk=true
                    isStreamingReasoning = false; // Reset state
                }
                break;
            }
            if (state.streamController?.signal.aborted) { console.log("Frontend stream reading aborted by AbortController."); break; }

            buffer += decoder.decode(value, { stream: true });
            let newlineIndex;

            while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
                const line = buffer.substring(0, newlineIndex).trim();
                buffer = buffer.substring(newlineIndex + 1);

                if (line.startsWith('data:')) {
                    const data = line.substring(5).trim();
                    if (data === '[DONE]') {
                         console.log("Received [DONE] marker.");
                         // If we were streaming reasoning when DONE arrived, close the tag
                         if (isStreamingReasoning) {
                             console.log("[DONE] received while reasoning, adding closing tag.");
                             onChunk("</think>\n", true); // Pass finalChunk=true
                             isStreamingReasoning = false; // Reset state
                         }
                    } else if (data) {
                        try {
                            const json = JSON.parse(data);
                            let reasoningChunk = null;
                            let contentChunk = null;

                            if (lowerProvider === 'openrouter') {
                                // Check for reasoning specifically in OpenRouter's delta
                                reasoningChunk = json.choices?.[0]?.delta?.reasoning;
                                contentChunk = json.choices?.[0]?.delta?.content;
                                if (!reasoningChunk && !contentChunk && json.error) throw new Error(`OpenRouter API Error: ${json.error.message}`);

                            } else if (lowerProvider === 'google') {
                                contentChunk = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
                                if (!contentChunk && json.error) throw new Error(`Google API Error: ${json.error.message}`);
                                // Google doesn't have standard 'reasoning' field here

                            } else { // Local or other OpenAI-compatible
                                contentChunk = json.choices?.[0]?.delta?.content || '';
                                // Assume local models output <think> tags directly in content if they support it
                                if (!contentChunk && json.error) throw new Error(`API Error in stream: ${json.error.message || JSON.stringify(json.error)}`);
                            }


                            // --- Process Reasoning Chunk (OpenRouter specific) ---
                            if (reasoningChunk) {
                                if (!isStreamingReasoning) {
                                    // First reasoning chunk, start the block
                                    console.log("Starting think block");
                                    onChunk(`<think>${reasoningChunk}`, false); // Pass finalChunk=false
                                    isStreamingReasoning = true;
                                } else {
                                    // Subsequent reasoning chunk
                                    onChunk(reasoningChunk, false); // Pass finalChunk=false
                                }
                                // Accumulate reasoning for tool detection if needed? Unlikely.
                                // accumulatedText += reasoningChunk; // Probably not needed here
                            }

                            // --- Process Content Chunk ---
                            if (contentChunk) {
                                if (isStreamingReasoning) {
                                    // Content arrived *after* reasoning, close the think block first
                                    console.log("Closing think block before content");
                                    onChunk(`</think>\n${contentChunk}`, false); // Pass finalChunk=false
                                    isStreamingReasoning = false; // Reset state
                                } else {
                                    // Normal content chunk
                                    onChunk(contentChunk, false); // Pass finalChunk=false
                                }
                                accumulatedText += contentChunk; // Accumulate content for tool detection

                                // --- Tool Detection Logic (applied only to content) ---
                                if (state.toolsEnabled && !state.toolCallPending) {
                                    TOOL_CALL_REGEX.lastIndex = 0;
                                    const match = TOOL_CALL_REGEX.exec(accumulatedText);
                                    if (match) {
                                        console.log("Tool call pattern detected in content:", match[0]);
                                        const toolName = match[1];
                                        const argsString = match[2];
                                        const toolArgs = parseAttributes(argsString);
                                        const textBeforeTool = accumulatedText.substring(0, match.index);
                                        const matchedToolCallString = match[0];
                                        onToolCallDetected(textBeforeTool, { name: toolName, arguments: toolArgs }, matchedToolCallString);
                                        break; // Exit inner 'while' loop
                                    }
                                }
                                // --- End Tool Detection ---
                            }
                        } catch (e) { console.warn("Failed to parse/process SSE data chunk:", data, e); }
                    }
                }
                if (state.streamController?.signal.aborted) { break; }
            }
            if (state.streamController?.signal.aborted) { console.log("Frontend stream reading aborted by AbortController after buffer processing."); break; }
        }

        // Call onComplete ONLY if the stream finished normally (not aborted, not tool detected *and waiting*)
        if (!state.streamController?.signal.aborted && !state.toolCallPending) {
            onComplete();
        } else {
            console.log("Stream ended due to abort or pending tool detection, skipping onComplete.");
             // If aborted while reasoning, ensure tag is closed
             if (isStreamingReasoning && state.streamController?.signal.aborted) {
                  console.log("Aborted while reasoning, adding closing tag.");
                  onChunk("</think>\n", true); // Pass finalChunk=true // Try sending final tag before error handling takes over
                  isStreamingReasoning = false;
             }
        }

    } catch (error) {
        // Ensure reasoning state is reset on error too
        const wasStreamingReasoningOnError = isStreamingReasoning;
        isStreamingReasoning = false; // Reset state early

        if (error.name === 'AbortError' || error.message.includes('aborted')) {
            console.log("Stream fetch explicitly aborted.");
            if (state.abortingForToolCall) {
                console.log("Abort was triggered by tool detection logic.");
                state.abortingForToolCall = false;
            } else {
                console.log("Abort was likely user-initiated or unexpected. Calling onError handler.");
                // If we were aborted mid-reasoning by user, try to close the tag in the final content saved by onError
                onError(error, wasStreamingReasoningOnError); // Pass flag to onError
            }
        } else {
            console.error(`LLM Streaming Error (${provider}):`, error);
            onError(error, wasStreamingReasoningOnError); // Pass flag to onError
        }
    } finally {
        // Final check, though should be handled above
        isStreamingReasoning = false;
    }
}

// --- Main Generation Function (No changes needed for this specific branch UI fix) ---
// generateAssistantResponse remains the same as in the previous response.
// It handles placeholder creation, streaming, tool detection/execution, saving,
// and calling loadChat on completion/error.
async function generateAssistantResponse(
    userMessageId, // This is actually the parentId for the new assistant message
    isContinuation = false,
    continuationContext = null,
    targetContentDiv = null // Passed during tool continuation recursion
) {
    console.log(`%c[generateAssistantResponse ENTRY] parentId: ${userMessageId}, isContinuation: ${isContinuation}, targetContentDiv provided: ${!!targetContentDiv}`, "color: purple; font-weight: bold;", { currentChatId: state.currentChatId, streamController: !!state.streamController, toolCallPending: state.toolCallPending, abortingForToolCall: state.abortingForToolCall });

    // --- Initial Checks and Setup ---
    if (!state.currentChatId || (state.streamController && !isContinuation) || state.toolCallPending) {
        console.warn("generateAssistantResponse called while busy or no chat active. Aborting.", { currentChatId: state.currentChatId, streamController: !!state.streamController, toolCallPending: state.toolCallPending });
        if (state.streamController && !state.toolCallPending && !state.streamController.signal.aborted) { state.streamController.abort(); }
        cleanupAfterGeneration();
        return;
    }
    stopButton.style.display = 'flex';
    sendButton.disabled = true;
    sendButton.innerHTML = '<div class="spinner"></div>';
    // messageInput.disabled = true; // Input interaction is allowed
    state.isAutoScrolling = true;
    state.userHasScrolled = false;
    const localScrollHandler = createScrollHandler();
    chatContainer.addEventListener('scroll', localScrollHandler);

    let contentDiv = targetContentDiv;
    let placeholderRow = null;
    let accumulatedStreamText = ''; // Tracks ALL text for saving/redraw
    let parentId = userMessageId; // Explicitly use the passed ID as parent
    let initialText = '';
    let isEditingExistingMessage = false; // True ONLY during tool continuation recursion

    if (isContinuation) {
        // --- Continuation Setup (Tool Response) ---
        if (!contentDiv) {
             console.warn("[generateAssistantResponse] Continuation called without explicit targetContentDiv, trying state.currentAssistantMessageDiv.");
             contentDiv = state.currentAssistantMessageDiv;
        }
        if (contentDiv) {
            placeholderRow = contentDiv.closest('.message-row');
            if (!placeholderRow) { console.error("Continuation error: Could not find parent message row for target contentDiv."); addSystemMessage("Error continuing generation.", "error"); cleanupAfterGeneration(); return; }
            if (!state.toolContinuationContext) { console.error("Continuation error: toolContinuationContext is missing."); addSystemMessage("Error continuing generation state.", "error"); cleanupAfterGeneration(); return; }

            // Combine previous text + tool call + tool result for the initial display
            initialText = (state.toolContinuationContext.partialText || '') +
                          (state.toolContinuationContext.toolCallPlaceholder || '') +
                          (state.toolContinuationContext.toolResultPlaceholder || '');
            parentId = state.toolContinuationContext.parentId; // Get the correct original parent from context
            isEditingExistingMessage = true; // We are editing the message that was interrupted by the tool call

            console.log("[generateAssistantResponse] Continuing generation after tool. Initial text length:", initialText.length, "Original Parent:", parentId, "Editing Msg ID:", placeholderRow.dataset.messageId);
            buildContentHtml(contentDiv, initialText, true); // Initial render
            contentDiv.insertAdjacentHTML('beforeend', '<span class="pulsing-cursor">█</span>');
            contentDiv.classList.add('streaming');
            state.currentAssistantMessageDiv = contentDiv; // Track the div being updated
        } else {
            console.error("Continuation state is invalid: Could not determine target contentDiv.");
            addSystemMessage("Error continuing generation due to invalid state.", "error");
            cleanupAfterGeneration(); return;
        }
    } else {
        // --- New Generation Setup (User message, Regeneration, Branching) ---
         if (contentDiv) { // Should not happen for new generation
            console.error("[generateAssistantResponse] Non-continuation call received an unexpected targetContentDiv.");
            addSystemMessage("Internal error: Invalid state for new generation.", "error");
            cleanupAfterGeneration(); return;
        }
        const tempAssistantId = `temp_assistant_${Date.now()}`;
        // Create the placeholder row with the correct PARENT ID
        placeholderRow = createPlaceholderMessageRow(tempAssistantId, parentId);
        messagesWrapper.appendChild(placeholderRow); // Append to the container
        contentDiv = placeholderRow.querySelector('.message-content');
        if (!contentDiv) { console.error("Failed to find placeholder message div."); addSystemMessage("Internal error preparing response area.", "error"); cleanupAfterGeneration(); return; }

        contentDiv.innerHTML = '<span class="pulsing-cursor">█</span>'; // Initial render
        contentDiv.classList.add('streaming');
        state.currentAssistantMessageDiv = contentDiv; // Track the new div
        scrollToBottom(); // Scroll to show the placeholder
        initialText = ''; // No initial text for new generation
        isEditingExistingMessage = false; // Not editing an existing message
        console.log("[generateAssistantResponse] Starting new generation. Parent:", parentId, "Temp ID:", tempAssistantId);
    }

    // --- Context, Model, Variables ---
    const context = (isContinuation && state.toolContinuationContext && Array.isArray(state.toolContinuationContext.history))
                    ? state.toolContinuationContext.history // Use history prepared by onToolCallDetected
                    : getContextForGeneration(parentId, true); // Get history up to the parent

    const selectedOption = modelSelect.options[modelSelect.selectedIndex];
    const modelName = selectedOption.value;
    const modelIdentifier = selectedOption.dataset.modelIdentifier;
    const provider = selectedOption.dataset.provider;
    let finalFullText = initialText;
    let messageSaved = false;
    const currentContentDiv = contentDiv; // Capture the correct div for this scope

    try {
        await streamLLMResponse(
            provider, modelIdentifier, context, defaultGenArgs,
            // --- onChunk ---
            (chunk, isFinalChunk = false) => {
                if (!currentContentDiv || state.toolCallPending || messageSaved || (state.streamController?.signal.aborted && !isFinalChunk)) {
                    return; // Stop processing if aborted, tool pending, etc.
                }
                accumulatedStreamText += chunk;
                finalFullText = initialText + accumulatedStreamText;
                buildContentHtml(currentContentDiv, finalFullText, true); // isStreaming=true
                // Post-process NEW code blocks
                currentContentDiv.querySelectorAll('pre > code').forEach(codeElem => {
                    const preElem = codeElem.parentElement;
                    if (preElem && preElem.tagName === 'PRE' && !preElem.closest('.code-block-wrapper')) {
                        const langCls = Array.from(codeElem.classList).find(cls => cls.startsWith('language-'));
                        const lang = langCls ? langCls.substring(9) : '';
                        const codeTxt = codeElem.textContent;
                        const wrapper = createCodeBlockWithContent(codeTxt, lang);
                        wrapper.classList.add('streaming');
                        preElem.replaceWith(wrapper);
                    }
                });
                // Cursor management
                currentContentDiv.querySelector('.pulsing-cursor')?.remove();
                if (!isFinalChunk) {
                    currentContentDiv.insertAdjacentHTML('beforeend', '<span class="pulsing-cursor">█</span>');
                }
                // Auto-scroll
                if (!state.userHasScrolled && state.isAutoScrolling) {
                    scrollToBottom();
                }
           },
            // --- onComplete ---
            async () => {
                 if (state.toolCallPending || messageSaved || state.streamController?.signal.aborted) { console.log("onComplete skipped: Tool pending, message saved, or aborted."); return; }
                 console.log("Streaming completed normally.");
                 currentContentDiv?.classList.remove('streaming');
                 currentContentDiv?.querySelector('.pulsing-cursor')?.remove();
                 if (state.currentAssistantMessageDiv === currentContentDiv) { state.currentAssistantMessageDiv = null; }

                 finalFullText = initialText + accumulatedStreamText;
                 buildContentHtml(currentContentDiv, finalFullText, false); // Final render, isStreaming=false
                 finalizeStreamingCodeBlocks(currentContentDiv); // Finalize highlighting

                 try {
                     console.log(`Saving final message (Complete). isEditing: ${isEditingExistingMessage}, Length: ${finalFullText.length}`);
                     if (!finalFullText.trim()) {
                         console.warn("Generated message is empty, removing placeholder.");
                         currentContentDiv?.closest('.message-row')?.remove();
                     } else {
                         let saveResponse;
                         const finalRow = currentContentDiv?.closest('.message-row');
                         let messageIdToSave = null;

                         // Determine if editing or adding
                         if (isEditingExistingMessage && finalRow) { // True only for tool continuation
                             messageIdToSave = finalRow.dataset.messageId;
                             console.log(`[onComplete] Determined messageIdToSave (edit): ${messageIdToSave}`);
                             if (!messageIdToSave || messageIdToSave.startsWith('temp_')) { console.error(`[onComplete] Error: Trying to edit with invalid message ID: ${messageIdToSave}`); isEditingExistingMessage = false; messageIdToSave = null; addSystemMessage("Error saving continuation, attempting to add as new.", "warning"); }
                         } else if (!isEditingExistingMessage && finalRow && finalRow.dataset.messageId?.startsWith('temp_')) { // True for new message/regen/branch
                             console.log(`[onComplete] Determined messageIdToSave (new): null (will add)`);
                             messageIdToSave = null;
                         } else {
                             console.error(`[onComplete] Could not determine message ID or row state mismatch. isEditing: ${isEditingExistingMessage}`, finalRow?.dataset.messageId);
                             // Don't throw, try to add as a failsafe if possible
                             messageIdToSave = null;
                             isEditingExistingMessage = false;
                             addSystemMessage("Internal error determining message ID for saving. Attempting to add as new.", "warning");
                             // Ensure parentId is set correctly for adding
                             parentId = userMessageId; // Reset to the original parentId passed to the function
                             if (state.toolContinuationContext) parentId = state.toolContinuationContext.parentId; // Or use the one from context if continuing
                         }

                         // Prepare message data common fields
                         const messageData = { role: 'llm', message: finalFullText, attachments: [], model_name: modelName, tool_calls: null, tool_call_id: null };

                         if (isEditingExistingMessage && messageIdToSave) {
                             // Edit the message (used in tool continuation flow)
                             console.log(`[onComplete] Sending EDIT request for ${messageIdToSave}`);
                             saveResponse = await fetch(`${API_BASE}/chat/${state.currentChatId}/edit_message/${messageIdToSave}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(messageData) });
                         } else {
                             // Add a new message (user message reply, regen, branch)
                             messageData.parent_message_id = parentId; // Set the parent ID
                             console.log(`[onComplete] Sending ADD request (Parent: ${parentId})`);
                             saveResponse = await fetch(`${API_BASE}/chat/${state.currentChatId}/add_message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(messageData) });
                         }

                         if (!saveResponse.ok) {
                            const errorData = await saveResponse.json().catch(() => ({ detail: saveResponse.statusText }));
                            throw new Error(`Failed to save assistant message: ${errorData.detail || saveResponse.statusText}`);
                         }
                         messageSaved = true;
                         console.log(`Assistant message ${messageIdToSave ? 'edited' : 'saved'} successfully.`);
                         await loadChat(state.currentChatId); // Reload to get final state including correct IDs/branching
                     }
                 } catch (saveError) {
                     console.error("Error saving assistant message:", saveError);
                     addSystemMessage(`Error saving response: ${saveError.message}`, "error");
                     if (currentContentDiv) {
                         // Ensure final state is rendered even if save failed
                         buildContentHtml(currentContentDiv, finalFullText, false);
                         finalizeStreamingCodeBlocks(currentContentDiv);
                         currentContentDiv.insertAdjacentHTML('beforeend', `<br><span class="system-info-row error">Save Error</span>`);
                     }
                 } finally {
                      cleanupAfterGeneration();
                      chatContainer.removeEventListener('scroll', localScrollHandler);
                 }
            },
             // --- onError ---
            async (error, wasStreamingReasoning = false) => {
                 if (messageSaved) { console.log("onError skipped: Message already saved."); return; }
                 const finalContentDivOnError = currentContentDiv;
                 const finalRowOnError = finalContentDivOnError?.closest('.message-row');

                 finalFullText = initialText + accumulatedStreamText;
                 if (wasStreamingReasoning && finalFullText.trim().startsWith('<think') && !finalFullText.includes('</think>')) {
                     console.log("Appending closing </think> tag to partial message on abort/error.");
                     finalFullText += "</think>";
                 }
                 buildContentHtml(finalContentDivOnError, finalFullText, false); // Render final partial text
                 finalizeStreamingCodeBlocks(finalContentDivOnError); // Finalize highlighting

                 finalContentDivOnError?.classList.remove('streaming');
                 finalContentDivOnError?.querySelector('.pulsing-cursor')?.remove();
                 if (state.currentAssistantMessageDiv === finalContentDivOnError) { state.currentAssistantMessageDiv = null; }

                 if (error.name === 'AbortError' || error.message.includes('aborted')) {
                     console.log("onError: Handling user-initiated stop or tool-triggered abort.");
                     if (state.abortingForToolCall) {
                          console.log("Abort was due to tool detection. Tool handler will proceed.");
                          // Reset the flag, the tool handler takes over
                          state.abortingForToolCall = false;
                          // Do NOT save partial here, let the tool handler manage state.
                          // Do NOT cleanup here yet.
                     } else {
                          console.log("Abort was user-initiated or unexpected.");
                          // --- Save Partial Message (User Stop) ---
                          console.log(`Saving partial message after abort. isEditing: ${isEditingExistingMessage}, Length: ${finalFullText.length}`);
                          if (finalFullText.trim()) {
                               try {
                                   let saveResponse;
                                   let messageIdToSave = null;
                                   // Determine if editing or adding (same logic as onComplete)
                                   if (isEditingExistingMessage && finalRowOnError) {
                                       messageIdToSave = finalRowOnError.dataset.messageId;
                                       console.log(`[onError-Abort] Determined messageIdToSave (edit): ${messageIdToSave}`);
                                       if (!messageIdToSave || messageIdToSave.startsWith('temp_')) { console.error(`[onError-Abort] Error: Trying to edit partial with invalid message ID: ${messageIdToSave}`); isEditingExistingMessage = false; messageIdToSave = null; addSystemMessage("Error saving partial, attempting to add as new.", "warning"); }
                                   } else if (!isEditingExistingMessage && finalRowOnError && finalRowOnError.dataset.messageId?.startsWith('temp_')) {
                                       console.log(`[onError-Abort] Determined messageIdToSave (new): null (will add)`);
                                       messageIdToSave = null;
                                   } else {
                                        console.error(`[onError-Abort] Could not determine message ID or row state mismatch. isEditing: ${isEditingExistingMessage}`, finalRowOnError?.dataset.messageId);
                                        messageIdToSave = null; isEditingExistingMessage = false; addSystemMessage("Internal error: Could not determine message ID for saving partial. Attempting to add as new.", "error");
                                        parentId = userMessageId; // Reset to original parentId
                                        if (state.toolContinuationContext) parentId = state.toolContinuationContext.parentId;
                                   }
                                   const messageData = { role: 'llm', message: finalFullText, attachments: [], model_name: modelName + " (stopped)", tool_calls: null, tool_call_id: null };
                                   if (isEditingExistingMessage && messageIdToSave) {
                                       console.log(`[onError-Abort] Sending EDIT request for partial ${messageIdToSave}`);
                                       saveResponse = await fetch(`${API_BASE}/chat/${state.currentChatId}/edit_message/${messageIdToSave}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(messageData) });
                                   } else {
                                       messageData.parent_message_id = parentId;
                                       console.log(`[onError-Abort] Sending ADD request for partial (Parent: ${parentId})`);
                                       saveResponse = await fetch(`${API_BASE}/chat/${state.currentChatId}/add_message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(messageData) });
                                   }
                                   if (!saveResponse.ok) {
                                        const errorData = await saveResponse.json().catch(() => ({ detail: saveResponse.statusText }));
                                        throw new Error(`Failed to save partial message: ${errorData.detail || saveResponse.statusText}`);
                                   }
                                   messageSaved = true;
                                   console.log(`Partial assistant message ${messageIdToSave ? 'edited' : 'saved'} successfully after abort.`);
                                   await loadChat(state.currentChatId); // Reload state
                               } catch (saveError) {
                                   console.error("Error saving partial assistant message after abort:", saveError);
                                   addSystemMessage(`Error saving partial response: ${saveError.message}`, "error");
                                   finalContentDivOnError?.insertAdjacentHTML('beforeend', `<br><span class="system-info-row error">Save Error</span>`);
                               }
                          } else {
                               console.log("Aborted with no text generated, removing placeholder.");
                               finalRowOnError?.remove();
                          }
                          addSystemMessage("Generation stopped.", "info", 1500);
                          console.log("onError: Cleaning up UI state after user abort.");
                          cleanupAfterGeneration(); // Clean up UI *after* handling user stop
                          chatContainer.removeEventListener('scroll', localScrollHandler);
                     }
                 } else {
                     // --- Handle Non-Abort Errors ---
                     console.error("onError: Non-abort stream error occurred:", error);
                     finalRowOnError?.remove(); // Remove the placeholder/row on stream errors
                     addSystemMessage(`Generation Error: ${error.message}`, "error");
                     console.log("onError: Cleaning up UI state after stream error.");
                     cleanupAfterGeneration(); // Clean up UI
                     chatContainer.removeEventListener('scroll', localScrollHandler);
                 }
            },
            // --- onToolCallDetected ---
            async (textBeforeTool, toolCallData, matchedToolCallString) => {
                 const targetDiv = currentContentDiv; // The div being streamed into
                 if (!targetDiv) { console.error("[onToolCallDetected] targetDiv is missing!"); return; }
                 if (!state.toolsEnabled || state.toolCallPending || messageSaved) { console.warn("onToolCallDetected called unexpectedly.", { toolsEnabled: state.toolsEnabled, toolCallPending: state.toolCallPending, messageSaved: messageSaved }); return; }
                 console.log(`%c[onToolCallDetected] START - Tool: ${toolCallData.name}`, "color: blue; font-weight: bold;", toolCallData.arguments);

                 state.toolCallPending = true; // Block further actions
                 state.currentToolCallId = `tool_${Date.now()}`; // Generate an ID for this call
                 console.log("[onToolCallDetected] State updated: toolCallPending=true, currentToolCallId set.");

                 // Abort the current stream segment. The `onError` handler will catch this.
                 if (state.streamController && !state.streamController.signal.aborted) {
                     console.log("[onToolCallDetected] Aborting current stream segment for tool call...");
                     state.abortingForToolCall = true; // Signal the reason for abort
                     state.streamController.abort();
                     // IMPORTANT: Do not proceed further here. The onError handler will now run.
                     // It will check state.abortingForToolCall. If true, it skips saving partial
                     // and allows this handler (onToolCallDetected) to eventually resume control
                     // after the stream is fully stopped. We need to wait for the abort to process.
                     // Let's schedule the rest of the tool handling slightly later to ensure abort completes.
                     setTimeout(async () => {
                          console.log("[onToolCallDetected] Resuming after stream abort for tool call.");
                          // --- UI Update after abort ---
                          targetDiv.classList.remove('streaming');
                          targetDiv.querySelector('.pulsing-cursor')?.remove();
                          accumulatedStreamText = textBeforeTool; // Update accumulated text to before the tool
                          const currentFullTextBeforeTool = initialText + accumulatedStreamText;
                          buildContentHtml(targetDiv, currentFullTextBeforeTool, false); // Render final text before tool
                          finalizeStreamingCodeBlocks(targetDiv); // Finalize highlight before adding tool UI
                          renderToolCallPlaceholder(targetDiv, toolCallData.name, toolCallData.arguments); // Add placeholder UI
                          scrollToBottom();
                          console.log("[onToolCallDetected] UI updated with text and tool call placeholder.");
                           // --- Store Context & Execute Tool ---
                          state.toolContinuationContext = {
                              history: context, // The history sent to the LLM initially for this turn
                              partialText: currentFullTextBeforeTool, // Text generated *before* the tool call tag
                              toolCallPlaceholder: matchedToolCallString, // The actual matched <tool .../> tag
                              toolCallData: toolCallData, // Parsed {name, arguments}
                              parentId: parentId, // The parent of this assistant message
                              toolResultPlaceholder: '', // Will be filled after execution
                              toolResultData: null
                          };
                          console.log("[onToolCallDetected] Continuation context stored.");
                          try {
                              console.log(`%c[onToolCallDetected] Executing tool: ${toolCallData.name}...`, "color: green;");
                              addSystemMessage(`Calling tool: ${toolCallData.name}...`, 'info', 1500);
                              const toolResponse = await fetch(`${API_BASE}/tools/execute`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool_name: toolCallData.name, arguments: toolCallData.arguments }) });
                              if (!toolResponse.ok) { const errorData = await toolResponse.json().catch(() => ({ detail: toolResponse.statusText })); throw new Error(`Tool execution failed: ${errorData.detail || toolResponse.statusText}`); }
                              const toolResult = await toolResponse.json();
                              console.log("[onToolCallDetected] Tool execution successful, result:", toolResult);
                              const toolResultTag = `<tool_result tool_name="${toolCallData.name}" result="${toolResult.result.replace(/"/g, '"')}" />`; // Use quotes, JSON should handle escaping
                              renderToolResult(targetDiv, toolResult.result); // Render tool result UI
                              addSystemMessage(`Tool ${toolCallData.name} finished.`, 'info', 1500);
                              scrollToBottom();
                              // Update context with result info
                              state.toolContinuationContext.toolResultPlaceholder = toolResultTag;
                              state.toolContinuationContext.toolResultData = toolResult;
                              console.log("[onToolCallDetected] UI updated with result, context updated.");
                              // --- Prepare History for Next Call ---
                              // History = original context + this assistant's turn (partial + tool call) + tool result
                              const continuationHistoryPayload = [
                                  ...state.toolContinuationContext.history, // History sent to LLM for this turn
                                  { role: 'assistant', message: state.toolContinuationContext.partialText + state.toolContinuationContext.toolCallPlaceholder, attachments: [] },
                                  { role: 'tool', message: toolResult.result, tool_call_id: state.currentToolCallId } // Backend might ignore tool_call_id if not using native calls
                              ];
                              console.log("[onToolCallDetected] Prepared history for continuation:", continuationHistoryPayload.length, "messages");
                              // --- Reset State for Recursive Call ---
                              console.log("[onToolCallDetected] Resetting state before recursive call...");
                              state.toolCallPending = false;
                              state.streamController = null; // Ensure controller is null before next call
                              state.currentToolCallId = null;
                              // state.abortingForToolCall was reset by onError
                              console.log("[onToolCallDetected] State reset. Making recursive call to generateAssistantResponse...");
                              // --- Recursive Call to Continue Generation ---
                              // Pass parentId from context, set isContinuation=true, pass new history, pass the SAME targetContentDiv
                              await generateAssistantResponse(state.toolContinuationContext.parentId, true, continuationHistoryPayload, targetDiv);
                              console.log("[onToolCallDetected] Recursive call returned.");
                          } catch (toolError) {
                              console.error("[onToolCallDetected] Error during tool execution or continuation:", toolError);
                              addSystemMessage(`Error executing tool ${toolCallData.name}: ${toolError.message}`, "error");
                              renderToolResult(targetDiv, `[Error: ${toolError.message}]`); // Render tool error UI
                              // --- Attempt to Save Partial Before Tool Error ---
                              const textBeforeFailure = state.toolContinuationContext?.partialText + state.toolContinuationContext?.toolCallPlaceholder;
                              if (textBeforeFailure) {
                                  console.log("[onToolCallDetected] Attempting to save text before tool failure...");
                                  try {
                                      let saveResponse;
                                      const finalRowOnError = targetDiv?.closest('.message-row');
                                      let messageIdToSave = null;
                                      // Determine if editing or adding (similar logic to onComplete/onError)
                                       if (isEditingExistingMessage && finalRowOnError) { // True if original generation was interrupted
                                           messageIdToSave = finalRowOnError.dataset.messageId;
                                           if (!messageIdToSave || messageIdToSave.startsWith('temp_')) { console.error(`[onToolCallDetected][Error Path] Error: Trying to edit partial with invalid message ID: ${messageIdToSave}`); isEditingExistingMessage = false; messageIdToSave = null; addSystemMessage("Error saving partial after tool error, attempting to add as new.", "warning"); }
                                       } else if (!isEditingExistingMessage && finalRowOnError && finalRowOnError.dataset.messageId?.startsWith('temp_')) { // True if original generation was new
                                           messageIdToSave = null;
                                       } else {
                                            console.error(`[onToolCallDetected][Error Path] Could not determine message ID or row state mismatch. isEditing: ${isEditingExistingMessage}`, finalRowOnError?.dataset.messageId);
                                            messageIdToSave = null; isEditingExistingMessage = false; addSystemMessage("Internal error: Could not determine message ID for saving partial after tool error. Attempting to add as new.", "error");
                                            parentId = state.toolContinuationContext?.parentId; // Get parent from context
                                       }
                                      const messageData = { role: 'llm', message: textBeforeFailure + `\n[Tool Error: ${toolError.message}]`, attachments: [], model_name: modelName };
                                      if (isEditingExistingMessage && messageIdToSave) {
                                           saveResponse = await fetch(`${API_BASE}/chat/${state.currentChatId}/edit_message/${messageIdToSave}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(messageData) });
                                      } else {
                                           messageData.parent_message_id = parentId; // Use parent from context
                                           saveResponse = await fetch(`${API_BASE}/chat/${state.currentChatId}/add_message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(messageData) });
                                      }
                                      if (!saveResponse.ok) {
                                            const errorData = await saveResponse.json().catch(() => ({ detail: saveResponse.statusText }));
                                            throw new Error(`Failed to save message before tool failure: ${errorData.detail || saveResponse.statusText}`);
                                      }
                                      messageSaved = true;
                                      await loadChat(state.currentChatId); // Reload state
                                  } catch (saveErr) { console.error("Failed to save text before tool error:", saveErr); addSystemMessage(`Failed to save partial message after tool error: ${saveErr.message}`, "error"); }
                              }
                              // --- Final Cleanup After Tool Error ---
                              console.log("[onToolCallDetected] Resetting state after tool error...");
                              state.toolCallPending = false;
                              state.streamController = null;
                              state.currentToolCallId = null;
                              if (state.currentAssistantMessageDiv === targetDiv) { state.currentAssistantMessageDiv = null; }
                              // state.abortingForToolCall should already be false
                              console.log("[onToolCallDetected] Calling cleanupAfterGeneration after tool error.");
                              cleanupAfterGeneration();
                              chatContainer.removeEventListener('scroll', localScrollHandler);
                          }
                          console.log(`%c[onToolCallDetected] END - Tool: ${toolCallData.name}`, "color: blue; font-weight: bold;");
                     }, 10); // Small delay to allow abort signal to propagate in fetch

                 } else {
                     console.log("[onToolCallDetected] Stream controller not found or already aborted when tool detected.");
                     // If the stream was *already* stopped before tool detect finished processing,
                     // proceed with UI update and tool execution directly.
                     // This path might occur if the stream ends *exactly* on a tool tag.

                    // --- UI Update ---
                     targetDiv.classList.remove('streaming');
                     targetDiv.querySelector('.pulsing-cursor')?.remove();
                     accumulatedStreamText = textBeforeTool;
                     const currentFullTextBeforeTool = initialText + accumulatedStreamText;
                     buildContentHtml(targetDiv, currentFullTextBeforeTool, false);
                     finalizeStreamingCodeBlocks(targetDiv);
                     renderToolCallPlaceholder(targetDiv, toolCallData.name, toolCallData.arguments);
                     scrollToBottom();
                     console.log("[onToolCallDetected] UI updated (stream already stopped path).");

                    // --- Store Context & Execute Tool (same as above) ---
                     state.toolContinuationContext = { history: context, partialText: currentFullTextBeforeTool, toolCallPlaceholder: matchedToolCallString, toolCallData: toolCallData, parentId: parentId, toolResultPlaceholder: '', toolResultData: null };
                     console.log("[onToolCallDetected] Continuation context stored (stream already stopped path).");
                     try {
                        // ... (Identical tool execution and continuation logic as in the setTimeout above) ...
                        console.log(`%c[onToolCallDetected] Executing tool: ${toolCallData.name}... (stream already stopped path)`, "color: green;");
                        addSystemMessage(`Calling tool: ${toolCallData.name}...`, 'info', 1500);
                        const toolResponse = await fetch(`${API_BASE}/tools/execute`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool_name: toolCallData.name, arguments: toolCallData.arguments }) });
                        if (!toolResponse.ok) { const errorData = await toolResponse.json().catch(() => ({ detail: toolResponse.statusText })); throw new Error(`Tool execution failed: ${errorData.detail || toolResponse.statusText}`); }
                        const toolResult = await toolResponse.json();
                        const toolResultTag = `<tool_result tool_name="${toolCallData.name}" result="${toolResult.result.replace(/"/g, '"')}" />`;
                        renderToolResult(targetDiv, toolResult.result);
                        addSystemMessage(`Tool ${toolCallData.name} finished.`, 'info', 1500);
                        scrollToBottom();
                        state.toolContinuationContext.toolResultPlaceholder = toolResultTag;
                        state.toolContinuationContext.toolResultData = toolResult;
                        const continuationHistoryPayload = [ ...state.toolContinuationContext.history, { role: 'assistant', message: state.toolContinuationContext.partialText + state.toolContinuationContext.toolCallPlaceholder, attachments: [] }, { role: 'tool', message: toolResult.result, tool_call_id: state.currentToolCallId } ];
                        console.log("[onToolCallDetected] Resetting state before recursive call (stream already stopped path)...");
                        state.toolCallPending = false;
                        state.streamController = null;
                        state.currentToolCallId = null;
                        state.abortingForToolCall = false; // Ensure it's reset
                        console.log("[onToolCallDetected] State reset. Making recursive call (stream already stopped path)...");
                        await generateAssistantResponse(state.toolContinuationContext.parentId, true, continuationHistoryPayload, targetDiv);
                        console.log("[onToolCallDetected] Recursive call returned (stream already stopped path).");
                     } catch (toolError) {
                         // ... (Identical error handling and partial save logic as in the setTimeout above) ...
                          console.error("[onToolCallDetected] Error during tool execution or continuation (stream already stopped path):", toolError);
                          addSystemMessage(`Error executing tool ${toolCallData.name}: ${toolError.message}`, "error");
                          renderToolResult(targetDiv, `[Error: ${toolError.message}]`);
                          const textBeforeFailure = state.toolContinuationContext?.partialText + state.toolContinuationContext?.toolCallPlaceholder;
                          if (textBeforeFailure) { /* ... try saving ... */ }
                          console.log("[onToolCallDetected] Resetting state after tool error (stream already stopped path)...");
                          state.toolCallPending = false; state.streamController = null; state.currentToolCallId = null; state.currentAssistantMessageDiv = null; state.abortingForToolCall = false;
                          console.log("[onToolCallDetected] Calling cleanupAfterGeneration after tool error (stream already stopped path).");
                          cleanupAfterGeneration();
                          chatContainer.removeEventListener('scroll', localScrollHandler);
                     }
                 }
            } // End onToolCallDetected
        ); // End streamLLMResponse call
    } catch (error) {
         // Catch synchronous errors during setup (e.g., finding model, initial context prep)
         console.error("Error initiating generation stream:", error);
         addSystemMessage(`Error starting generation: ${error.message}`, "error");
         placeholderRow?.remove(); // Remove placeholder if setup failed
         cleanupAfterGeneration();
         chatContainer.removeEventListener('scroll', localScrollHandler);
    }
} // End generateAssistantResponse

// --- NEW Helper Function: Finalize Streaming Code Blocks ---
// Finds code blocks marked as streaming, removes the class, and highlights them.
function finalizeStreamingCodeBlocks(containerElement) {
    if (!containerElement) return;
    console.log("Finalizing streaming code blocks...");
    // Remove streaming class first
    containerElement.querySelectorAll('.code-block-wrapper.streaming').forEach(wrapper => {
         wrapper.classList.remove('streaming');
         // console.log(`Removed streaming class from: ${wrapper.dataset.streamId || '(no stream id)'}`);
         // wrapper.removeAttribute('data-stream-id'); // Optional: remove temp id
    });

    // Then highlight all code blocks within the container that need it
    containerElement.querySelectorAll('.code-block-wrapper code').forEach(codeElement => {
         try {
             // Only highlight if not already highlighted by hljs (which adds 'hljs' class)
             if (!codeElement.classList.contains('hljs')) {
                 hljs.highlightElement(codeElement);
                 // console.log(`Highlighted code block in wrapper.`);
             }
         } catch (e) {
             console.error(`Error highlighting finalized code block:`, e, codeElement.textContent.substring(0,50));
         }
    });
     // Also catch any pre>code that might not have been wrapped (e.g., if stream ended abruptly)
     containerElement.querySelectorAll('pre > code:not(.hljs)').forEach(codeElement => {
          if (!codeElement.closest('.code-block-wrapper')) { // Ensure it wasn't handled above
                console.warn("Found unwrapped code block during finalization, attempting highlight.");
                try {
                    hljs.highlightElement(codeElement);
                } catch(e) { console.error("Error highlighting unwrapped code block:", e); }
          }
     });
}


// --- Send Message Flow (Frontend Generation) (MODIFIED) ---

async function sendMessage() {
    const messageText = messageInput.value.trim();
    const attachments = [
        ...state.currentImages.map(img => ({ type: 'image', content: img.base64, name: img.name })),
        ...state.currentTextFiles.map(file => ({ type: 'file', content: file.content, name: file.name }))
    ];

    if (!messageText && attachments.length === 0) return;
    if (state.streamController || state.toolCallPending) {
        console.log("Already generating or tool call pending");
        return;
    }

    const selectedOption = modelSelect.options[modelSelect.selectedIndex];
    if (!selectedOption || selectedOption.disabled) {
         alert("Please select a valid model with an available API key."); return;
    }
    const provider = selectedOption?.dataset.provider;
    if (!provider || (!getApiKey(provider) && provider.toLowerCase() !== 'local')) {
        alert(`API Key for ${provider} is missing or model invalid. Please check Settings or model selection.`); return;
    }

    const currentInputText = messageInput.value;
    messageInput.value = '';
    state.currentImages = []; state.currentTextFiles = [];
    imagePreviewContainer.innerHTML = '';

    // --- Ensure input area moves to bottom ---
    document.body.classList.remove('welcome-active');
    welcomeContainer.style.display = 'none';
    adjustTextareaHeight(); // Adjust height and set correct bottom padding
    // --- End input area adjustment ---

    let currentChatId = state.currentChatId;
    let savedUserMessageId = null;

    sendButton.disabled = true; sendButton.innerHTML = '<div class="spinner"></div>';
    // messageInput.disabled = true; // REMOVED: Input is no longer disabled

    try {
        if (!currentChatId) {
            const response = await fetch(`${API_BASE}/chat/new_chat`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ character_id: state.currentCharacterId })
            });
            if (!response.ok) throw new Error(`Failed to create chat: ${await response.text()}`);
            const { chat_id } = await response.json();
            currentChatId = chat_id; state.currentChatId = chat_id;
            await fetchChats();
            localStorage.setItem('lastChatId', currentChatId);
            highlightCurrentChatInSidebar();
        }

        const parentId = findLastActiveMessageId(state.messages);
        const addUserResponse = await fetch(`${API_BASE}/chat/${currentChatId}/add_message`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                role: 'user', message: messageText || " ", attachments: attachments, parent_message_id: parentId
            })
        });
        if (!addUserResponse.ok) throw new Error(`Failed to save user message: ${await addUserResponse.text()}`);
        const { message_id } = await addUserResponse.json();
        savedUserMessageId = message_id;
        console.log(`User message saved with ID: ${savedUserMessageId}`);

        await loadChat(currentChatId); // Reload state to include user message & render it

        await generateAssistantResponse(savedUserMessageId); // Start generation

    } catch (error) {
        console.error('Error sending message or preparing generation:', error);
        addSystemMessage(`Error: ${error.message}`, "error");
        messageInput.value = currentInputText; // Restore input on error
        alert("Failed to send message. Please try again.");
        sendButton.disabled = false; sendButton.innerHTML = '<i class="bi bi-arrow-up"></i>';
        // messageInput.disabled = false; // REMOVED: Input is no longer disabled
        // If sending failed, check if we should revert to welcome state
        if (!state.messages || state.messages.length === 0 || state.messages.every(m => m.role === 'system')) {
            document.body.classList.add('welcome-active');
            welcomeContainer.style.display = 'flex';
            adjustTextareaHeight(); // Ensure padding is removed
        }
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


// Helper to clean up UI state after generation ends (success, error, abort)
function cleanupAfterGeneration() {
    console.log("Running cleanupAfterGeneration");
    sendButton.disabled = false;
    sendButton.innerHTML = '<i class="bi bi-arrow-up"></i>'; // Reset send button icon
    // messageInput.disabled = false; // REMOVED: Input is no longer disabled during generation
    stopButton.style.display = 'none';
    state.isAutoScrolling = false;
    // Ensure any lingering stream controllers are nullified and aborted
    if (state.streamController && !state.streamController.signal.aborted) {
        console.warn("Cleaning up potentially active stream controller.");
        state.streamController.abort();
    }
    state.streamController = null; // Nullify the controller reference
    state.toolCallPending = false; // Reset tool pending flag
    state.toolContinuationContext = null; // Clear context
    state.currentAssistantMessageDiv = null; // Clear reference to streaming div
    state.currentToolCallId = null; // Clear tool call ID
    state.abortingForToolCall = false; // Reset abort reason flag
    // Don't refocus input automatically as it might be disruptive
    // messageInput.focus();
}

// --- renderToolCallPlaceholder (MODIFIED: Added collapse functionality) ---
function renderToolCallPlaceholder(messageContentDiv, toolName, args) {
    if (!messageContentDiv) return;

    const toolCallBlock = document.createElement('div');
    // Start collapsed by default
    toolCallBlock.className = 'tool-call-block collapsed';
    toolCallBlock.dataset.toolName = toolName;

    const toolHeader = document.createElement('div');
    toolHeader.className = 'tool-header';

    const toolNameSpan = document.createElement('span');
    toolNameSpan.className = 'tool-header-name';
    const toolIcon = toolName === 'add' ? 'calculator' : 'tools'; // Example
    toolNameSpan.innerHTML = `<i class="bi bi-${toolIcon}"></i> Calling: ${toolName}`;

    // Create collapse button
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'tool-collapse-btn'; // Use specific class
    collapseBtn.innerHTML = '<i class="bi bi-chevron-down"></i>'; // Start collapsed icon
    collapseBtn.title = 'Expand tool call details';
    // Click handled by event delegation in setupEventListeners

    // Actions div to hold the button (similar to code blocks)
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'tool-header-actions'; // Reuse class? Or make specific?
    actionsDiv.appendChild(collapseBtn);

    toolHeader.appendChild(toolNameSpan);
    toolHeader.appendChild(actionsDiv); // Add actions (button) to header
    toolCallBlock.appendChild(toolHeader);

    const toolArgsDiv = document.createElement('div');
    toolArgsDiv.className = 'tool-arguments'; // Content to be collapsed
    try {
        toolArgsDiv.textContent = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
    } catch {
        toolArgsDiv.textContent = "[Invalid Arguments]";
    }
    // Content starts hidden due to .collapsed class on parent
    toolCallBlock.appendChild(toolArgsDiv);

    messageContentDiv.appendChild(toolCallBlock);
}

// --- renderToolResult (MODIFIED: Added collapse functionality) ---
function renderToolResult(messageContentDiv, resultText) {
    if (!messageContentDiv) return;

   const toolResultBlock = document.createElement('div');
   // Start collapsed by default
   toolResultBlock.className = 'tool-result-block collapsed';

   const toolHeader = document.createElement('div');
   toolHeader.className = 'tool-header';

   const toolNameSpan = document.createElement('span');
   toolNameSpan.className = 'tool-header-name';
   toolNameSpan.innerHTML = `<i class="bi bi-check-circle-fill"></i> Tool Result`;

   // Create collapse button
   const collapseBtn = document.createElement('button');
   collapseBtn.className = 'tool-collapse-btn'; // Use specific class
   collapseBtn.innerHTML = '<i class="bi bi-chevron-down"></i>'; // Start collapsed icon
   collapseBtn.title = 'Expand tool result';
   // Click handled by event delegation

   // Actions div
   const actionsDiv = document.createElement('div');
   actionsDiv.className = 'tool-header-actions';
   actionsDiv.appendChild(collapseBtn);

   toolHeader.appendChild(toolNameSpan);
   toolHeader.appendChild(actionsDiv); // Add actions to header
   toolResultBlock.appendChild(toolHeader);

   const toolResultContent = document.createElement('div');
   toolResultContent.className = 'tool-result-content'; // Content to be collapsed
   toolResultContent.textContent = resultText || '[Empty Result]';
   // Content starts hidden due to .collapsed class on parent
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

// Helper to create placeholder row visually
function createPlaceholderMessageRow(tempId, parentId) {
    const messageRow = document.createElement('div');
    messageRow.className = `message-row assistant-row placeholder`; // Add placeholder class
    messageRow.dataset.messageId = tempId; // Temporary ID
    if (parentId) messageRow.dataset.parentId = parentId; // Store parent ref if needed

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';

    // Placeholder for avatar/actions (can be minimal or match layout)
    const avatarActionsDiv = document.createElement('div');
    avatarActionsDiv.className = 'message-avatar-actions placeholder-actions';

    // Message Content placeholder (initially empty or with cursor)
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    // contentDiv.innerHTML = '<span class="pulsing-cursor">▍</span>'; // Cursor added by caller

    messageDiv.appendChild(contentDiv);
    messageDiv.appendChild(avatarActionsDiv); // Add actions below content
    messageRow.appendChild(messageDiv);
    return messageRow;
}


// --- Context Preparation ---
// Get message context for sending to LLM - UPDATED for Tools Prompt and Think Blocks
function getContextForGeneration(stopAtMessageId = null, includeStopMessage = false) {
    const context = [];
    const messageMap = new Map(state.messages.map(msg => [msg.message_id, { ...msg }]));
    const rootMessages = [];

    state.messages.forEach(msg => {
        if (msg.role === 'system') return; // Skip DB system messages
        const msgNode = messageMap.get(msg.message_id);
        if (!msgNode) return;
         if (msg.parent_message_id && messageMap.has(msg.parent_message_id)) {
              const parent = messageMap.get(msg.parent_message_id);
              if (!parent.children) parent.children = [];
              parent.children.push(msgNode);
              parent.children.sort((a, b) => a.timestamp - b.timestamp); // Ensure order
         } else if (!msg.parent_message_id) {
            rootMessages.push(msgNode);
        }
    });
    // Sort roots by timestamp
    rootMessages.sort((a, b) => a.timestamp - b.timestamp);

    // Add the effective system prompt first if available
    if (state.effectiveSystemPrompt) {
        context.push({ role: 'system', message: state.effectiveSystemPrompt, attachments: [] });
    }

    // Traverse active branch(es) from roots
    function traverse(messageId) {
        const messageNode = messageMap.get(messageId);
        if (!messageNode || messageNode.role === 'system') return false;

        const shouldAdd = !stopAtMessageId || (messageNode.message_id !== stopAtMessageId || includeStopMessage);
        let addedMessage = false; // Flag to track if a message was added for this node

        if (shouldAdd) {
            let roleForContext = messageNode.role; // llm, user, or tool
            let messageContentForContext = messageNode.message || '';
            let attachmentsForContext = (messageNode.attachments || []).map(att => ({
                type: att.type,
                content: att.content,
                name: att.name
            }));
            let toolCallsForContext = messageNode.tool_calls || null;
            let toolCallIdForContext = messageNode.tool_call_id || null;

            // --- Think Block Handling ---
            if (roleForContext === 'llm' && messageContentForContext.trim().startsWith('<think>')) {
                 console.log(`[getContext] Detected think block in message ${messageNode.message_id}. Excluding from context.`);
                 const endThinkTagIndex = messageContentForContext.indexOf('</think>');
                 if (endThinkTagIndex !== -1) {
                     // Extract content *after* the think block
                     messageContentForContext = messageContentForContext.substring(endThinkTagIndex + '</think>'.length).trim();
                 } else {
                     // No closing tag or entire message was think block
                     messageContentForContext = '';
                 }

                 // If there's no meaningful content left after the think block, skip adding this turn entirely.
                 if (!messageContentForContext && attachmentsForContext.length === 0) {
                     console.log(`[getContext] Skipping assistant turn ${messageNode.message_id} as it only contained a think block.`);
                     // Don't push anything to context for this turn.
                 } else {
                      // If there IS content after the think block, add it.
                     context.push({
                         role: roleForContext,
                         message: messageContentForContext, // Only content after think block
                         attachments: attachmentsForContext, // Keep attachments if any existed (unlikely but possible)
                         tool_calls: toolCallsForContext,
                         tool_call_id: toolCallIdForContext,
                     });
                     addedMessage = true;
                 }
            } else {
                 // --- Standard Message Handling (No leading think block) ---
                 context.push({
                     role: roleForContext,
                     message: messageContentForContext,
                     attachments: attachmentsForContext,
                     tool_calls: toolCallsForContext,
                     tool_call_id: toolCallIdForContext,
                 });
                 addedMessage = true;
            }
        }

        // Check if we should stop traversal
        if (stopAtMessageId && messageNode.message_id === stopAtMessageId) {
             console.log(`Context generation ${addedMessage ? 'added and ' : ''}reached stopAtMessageId: ${stopAtMessageId}`);
             return true; // Signal to stop
        }

        // Find active child ID
        const childrenIds = messageNode.child_message_ids || [];
        const childrenNodes = childrenIds.map(id => messageMap.get(id)).filter(Boolean);
        childrenNodes.sort((a, b) => a.timestamp - b.timestamp);

        if (childrenNodes.length > 0) {
            const activeIndex = messageNode.active_child_index ?? 0;
            const safeActiveIndex = Math.min(Math.max(0, activeIndex), childrenNodes.length - 1);
            const activeChildNode = childrenNodes[safeActiveIndex];
            if (activeChildNode) {
                 if (traverse(activeChildNode.message_id)) return true; // Propagate stop signal
            }
        }
        return false; // Continue traversal
    }

    // Start traversal from each root node
    for (const rootNode of rootMessages) {
        if (traverse(rootNode.message_id)) break;
    }

    console.log(`Context prepared (${context.length} messages) up to ${stopAtMessageId || 'end'}`);
    return context;
}

// --- NEW Helper Function ---
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

// --- Regeneration / Continuation (Frontend Orchestration) (MODIFIED for Branching UI) ---
async function regenerateMessage(messageId, newBranch = false) {
    if (!state.currentChatId || state.streamController || state.toolCallPending) {
        addSystemMessage("Cannot regenerate while a response is being generated or a tool call is pending.", "warning");
        return;
    }
    const messageToRegen = state.messages.find(m => m.message_id === messageId);
    if (!messageToRegen || messageToRegen.role !== 'llm') {
        addSystemMessage("Error: Can only regenerate assistant messages.", "error"); return;
    }
    const parentMessageId = messageToRegen.parent_message_id;
    if (!parentMessageId) {
        addSystemMessage("Error: Cannot regenerate message without a parent.", "error"); return;
    }

    console.log(`Regenerating message ${messageId} (new branch: ${newBranch})`);

    if (!newBranch) {
        // --- Replace Logic ---
        if (!confirm("Replacing this message will delete it and any subsequent messages in this branch. Proceed?")) {
            return;
        }
        try {
            console.log(`Deleting message ${messageId} and descendants before regeneration (replace).`);
            // Find parent ID *before* deleting, in case the message object is removed from state
            const parentOfDeleted = messageToRegen.parent_message_id;

            const deleteResponse = await fetch(`${API_BASE}/chat/${state.currentChatId}/delete_message/${messageId}`, { method: 'POST' }); // Use POST
            if (!deleteResponse.ok) {
                const errorData = await deleteResponse.json().catch(() => ({ detail: deleteResponse.statusText }));
                throw new Error(`Failed to delete message for regeneration: ${errorData.detail || deleteResponse.statusText}`);
            }

            // Reload state to reflect deletion before starting new generation
            await loadChat(state.currentChatId);

            // Now, start generation as if sending a new message after the parent
            if (parentOfDeleted) {
                 await generateAssistantResponse(parentOfDeleted);
            } else {
                 // This case should be rare if parentMessageId was found initially
                 console.error("Regeneration Error: Could not determine parent after deletion.");
                 addSystemMessage("Error: Could not determine context after deletion.", "error");
            }

        } catch (error) {
            console.error('Error during regeneration (replace - delete step):', error);
            addSystemMessage(`Error preparing regeneration: ${error.message}`, "error");
            cleanupAfterGeneration(); // Ensure UI is reset
        }
    } else {
        // --- New Branch Logic (MODIFIED UI Handling) ---
        try {
            // 1. Find the parent message object in the current state to get branch info
            const parentMessageNode = state.messages.find(m => m.message_id === parentMessageId);
            if (!parentMessageNode) {
                 // Fallback: Maybe the parent isn't in the local `state.messages` if history is truncated?
                 // This indicates a potential issue, but we can proceed assuming backend has the info.
                 // We won't be able to remove the old branch from the DOM proactively.
                 console.warn(`Could not find parent message ${parentMessageId} in local state. Proceeding with generation, UI might show old branch temporarily.`);
            } else {
                // 2. Find the *currently active* child ID based on the parent's state
                const childrenIds = parentMessageNode.child_message_ids || [];
                const activeIndex = parentMessageNode.active_child_index ?? 0;
                // Ensure activeIndex is valid for the children we know about
                const safeActiveIndex = Math.min(Math.max(0, activeIndex), childrenIds.length - 1);
                const activeChildId = childrenIds.length > 0 ? childrenIds[safeActiveIndex] : null;

                // 3. Find and remove the corresponding DOM elements for the *old* active branch
                if (activeChildId) {
                    console.log(`Branching: Attempting to remove current active branch starting with ${activeChildId} from DOM.`);
                    removeMessageAndDescendantsFromDOM(activeChildId); // Use the helper function
                } else {
                    console.log("Branching: Parent had no known active children to remove from DOM.");
                }
            }

            // 4. Start generation from the parent. Backend handles actual branch creation & activation.
            // generateAssistantResponse will append its placeholder to the messagesWrapper.
            await generateAssistantResponse(parentMessageId);
            // `loadChat` called by generateAssistantResponse's onComplete/onError will handle the final correct rendering based on the new state from the backend.

        } catch (error) {
             console.error('Error preparing new branch regeneration:', error);
             addSystemMessage(`Error preparing new branch: ${error.message}`, "error");
             cleanupAfterGeneration(); // Ensure UI is reset
        }
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

// Continuation is tricky. If the message ended mid-tool call, we can't easily continue.
// If it ended mid-text *after* a tool call, we need the context up to the tool result.
// Let's assume 'continue' means continue the text generation *after* the existing text.
// This might produce weird results if the original stream was interrupted by a tool.
async function continueMessage(messageId) {
    if (!state.currentChatId || state.streamController || state.toolCallPending) {
        addSystemMessage("Cannot continue while a response is being generated or a tool call is pending.", "warning");
        return;
    }
    const messageToContinue = state.messages.find(m => m.message_id === messageId);
     // Allow continuing assistant messages
    if (!messageToContinue || messageToContinue.role !== 'llm') {
        addSystemMessage("Error: Can only continue assistant messages.", "error"); return;
    }
    // Simple check: If the message *looks* like it ends with a tool call/result tag in the raw content
    const rawMessage = messageToContinue.message || '';
    TOOL_TAG_REGEX.lastIndex = 0; // Reset regex
    let endsWithToolTag = false;
    let match;
    let lastTagEnd = -1;
    while ((match = TOOL_TAG_REGEX.exec(rawMessage)) !== null) {
        lastTagEnd = match.index + match[0].length;
    }
    // Check if the last tag found ends exactly at the end of the string (ignoring trailing whitespace)
    if (lastTagEnd > 0 && lastTagEnd >= rawMessage.trimEnd().length) {
        endsWithToolTag = true;
    }

    if (endsWithToolTag) {
         addSystemMessage("Cannot continue a message that ends with a tool action. Please regenerate.", "warning");
         return;
    }


    console.log(`Continuing message ${messageId}`);

    // UI Loading state - reuse parts of generateAssistantResponse
    stopButton.style.display = 'flex';
    sendButton.disabled = true;
    sendButton.innerHTML = '<div class="spinner"></div>';
    messageInput.disabled = true;
    state.isAutoScrolling = true; state.userHasScrolled = false;
    const scrollHandler = createScrollHandler();
    chatContainer.addEventListener('scroll', scrollHandler);

    // Find the content div for the message to continue
    const targetMessageRow = messagesWrapper.querySelector(`.message-row[data-message-id="${messageId}"]`);
    const contentDiv = targetMessageRow?.querySelector('.message-content');
    if (!contentDiv) {
         console.error("Cannot find content div to continue message.");
         addSystemMessage("Error: Could not find message content area to continue.", "error");
         cleanupAfterGeneration();
         return;
    }

    // Prepare context *including* the message being continued
    const context = getContextForGeneration(messageId, true);

    let existingText = messageToContinue.message || '';
    let continuationText = '';
    contentDiv.classList.add('streaming');
    // Re-render existing content using buildContentHtml and append cursor
    buildContentHtml(contentDiv, existingText);
    contentDiv.insertAdjacentHTML('beforeend', '<span class="pulsing-cursor">▍</span>');
    highlightRenderedCode(contentDiv); // Re-highlight existing code
    state.currentAssistantMessageDiv = contentDiv; // Track for updates
    scrollToBottom();

    // Use original model if possible, fallback to current selection
    const originalModelName = messageToContinue.model_name || modelSelect.value;
    const modelInfo = state.models.find(m => m.name === originalModelName) || state.models.find(m => m.name === modelSelect.value);
    if (!modelInfo || !modelInfo.provider) {
        addSystemMessage("Error: Could not determine model information for continuation.", "error");
        cleanupAfterGeneration();
        if (contentDiv) contentDiv.classList.remove('streaming');
        state.currentAssistantMessageDiv = null;
        return;
    }
    const modelIdentifier = modelInfo.model_identifier;
    const provider = modelInfo.provider;


    try {
        // Use streamLLMResponse, but handle completion/error differently (edit instead of add)
        await streamLLMResponse(
            provider, modelIdentifier, context, defaultGenArgs,
            // onChunk
            (chunk) => {
                 if (state.toolCallPending) return; // Should not happen in simple continuation
                 continuationText += chunk;
                 const fullText = existingText + continuationText;
                 // Re-render full content with cursor
                 buildContentHtml(contentDiv, fullText);
                 contentDiv.insertAdjacentHTML('beforeend', '<span class="pulsing-cursor">▍</span>');
                 highlightRenderedCode(contentDiv);
                 if (!state.userHasScrolled && state.isAutoScrolling) scrollToBottom();
            },
            // onComplete
            async () => {
                 if (state.toolCallPending) return;
                 console.log("Continuation streaming completed.");
                 contentDiv.classList.remove('streaming');
                 const finalCursor = contentDiv.querySelector('.pulsing-cursor');
                 if (finalCursor) finalCursor.remove();
                 state.currentAssistantMessageDiv = null;
                 const finalFullText = existingText + continuationText;

                 try {
                      // Edit the existing message with the continued content
                      const attachmentsForSave = (messageToContinue.attachments || []).map(att => ({ type: att.type, content: att.content, name: att.name }));
                      const toolCallsForSave = messageToContinue.tool_calls || null; // Preserve original tool calls if they existed

                      const saveResponse = await fetch(`${API_BASE}/chat/${state.currentChatId}/edit_message/${messageId}`, {
                          method: 'POST', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                              message: finalFullText, attachments: attachmentsForSave,
                              model_name: originalModelName, // Keep original model name
                              tool_calls: toolCallsForSave // Preserve if existed
                          })
                      });
                       if (!saveResponse.ok) throw new Error(`Failed to save continued message: ${await saveResponse.text()}`);
                      console.log(`Continued message ${messageId} saved successfully.`);
                      await loadChat(state.currentChatId); // Reload state

                 } catch (saveError) {
                      console.error("Error saving continued message:", saveError);
                      addSystemMessage(`Error saving response: ${saveError.message}`, "error");
                      // Show error in UI but keep the generated text
                      buildContentHtml(contentDiv, finalFullText); // Re-render final text
                      contentDiv.insertAdjacentHTML('beforeend', `<br><span class="system-info-row error">Save Error</span>`);
                 } finally {
                      cleanupAfterGeneration();
                 }
            },
            // onError
            async (error) => {
                 if (state.toolCallPending) return;
                 console.error("Continuation streaming error:", error);
                 contentDiv.classList.remove('streaming');
                 const finalCursor = contentDiv.querySelector('.pulsing-cursor');
                 if (finalCursor) finalCursor.remove();
                 state.currentAssistantMessageDiv = null;
                 const finalPartialText = existingText + continuationText;

                 if (error.name === 'AbortError' || error.message.includes('aborted')) { // Check name property for AbortError
                     console.log("Handling aborted continuation. Saving partial text:", finalPartialText);
                     if (continuationText.trim()) { // Only save if something new was added
                          try {
                               const attachmentsForSave = (messageToContinue.attachments || []).map(att => ({ type: att.type, content: att.content, name: att.name }));
                               const toolCallsForSave = messageToContinue.tool_calls || null;

                               const saveResponse = await fetch(`${API_BASE}/chat/${state.currentChatId}/edit_message/${messageId}`, {
                                   method: 'POST', headers: { 'Content-Type': 'application/json' },
                                   body: JSON.stringify({
                                       message: finalPartialText, attachments: attachmentsForSave,
                                       model_name: originalModelName + " (incomplete)",
                                       tool_calls: toolCallsForSave
                                   })
                               });
                              if (!saveResponse.ok) throw new Error(`Failed to save partial continuation: ${await saveResponse.text()}`);
                              await loadChat(state.currentChatId);
                          } catch (saveError) {
                               console.error("Error saving partial continuation:", saveError);
                               addSystemMessage(`Error saving partial response: ${saveError.message}`, "error");
                               buildContentHtml(contentDiv, finalPartialText); // Re-render partial text
                               contentDiv.insertAdjacentHTML('beforeend', `<br><span class="system-info-row error">Save Error</span>`);
                          }
                     } else {
                          console.log("Aborted continuation with no new text, reverting.");
                          // Revert UI to original text
                          buildContentHtml(contentDiv, existingText);
                          highlightRenderedCode(contentDiv);
                     }
                     addSystemMessage("Continuation stopped by user.", "info");
                 } else { // Other errors
                     buildContentHtml(contentDiv, finalPartialText); // Show partial text before error
                     contentDiv.insertAdjacentHTML('beforeend', `<br><span class="system-info-row error">Error: ${error.message}</span>`);
                 }
                 cleanupAfterGeneration();
            },
            // onToolCallDetected - Handle tool call detection during continuation
             async (textBeforeTool, toolCallData, matchedToolCallString) => {
                  if (!state.toolsEnabled) return;
                  console.warn("Tool call detected during message continuation. Handling...");
                  state.toolCallPending = true;
                  state.currentToolCallId = `tool_${Date.now()}`;
                  if (state.streamController && !state.streamController.signal.aborted) {
                       state.abortingForToolCall = true; // Set flag
                       state.streamController.abort(); // Abort the continuation stream
                  }

                  contentDiv.classList.remove('streaming');
                  const finalCursor = contentDiv.querySelector('.pulsing-cursor');
                  if (finalCursor) finalCursor.remove();
                  // Show combined text before tool
                  const combinedTextBefore = existingText + textBeforeTool;
                  buildContentHtml(contentDiv, combinedTextBefore); // Render text before tool
                  renderToolCallPlaceholder(contentDiv, toolCallData.name, toolCallData.arguments); // Render tool call visual
                  highlightRenderedCode(contentDiv);
                  scrollToBottom();

                  // Prepare context for the *next* stream (if tool succeeds)
                  // This context starts from the beginning up to the message being continued
                  const baseContinuationContext = getContextForGeneration(messageId, true);

                  // Execute tool (similar to generateAssistantResponse)
                   try {
                       addSystemMessage(`Calling tool: ${toolCallData.name}...`, 'info');
                       const toolResponse = await fetch(`${API_BASE}/tools/execute`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                tool_name: toolCallData.name,
                                arguments: toolCallData.arguments
                            })
                       });
                       if (!toolResponse.ok) {
                            const errorData = await toolResponse.json().catch(() => ({ detail: toolResponse.statusText }));
                            throw new Error(`Tool execution failed: ${errorData.detail || toolResponse.statusText}`);
                        }
                       const toolResult = await toolResponse.json();
                       const toolResultTag = `<tool_result tool_name="${toolCallData.name}" result="${toolResult.result.replace(/"/g, '&quot;')}" />`;
                       renderToolResult(contentDiv, toolResult.result); // Render result visual
                       addSystemMessage(`Tool ${toolCallData.name} finished.`, 'info');
                       scrollToBottom();

                       // Prepare history for the *next* stream continuation
                       const nextContinuationHistory = [
                            ...baseContinuationContext, // History up to and including original message
                            // Add the assistant's partial response *including* text generated during initial continue + the tool call tag
                            { role: 'assistant', message: combinedTextBefore + matchedToolCallString, attachments: [] },
                            // Add tool result
                            { role: 'tool', message: toolResult.result, tool_call_id: state.currentToolCallId }
                       ];

                       // Store context for the *next* step (this is slightly different from generateAssistantResponse)
                       // We are still technically "editing" the original message (messageId)
                       state.toolContinuationContext = {
                           history: baseContinuationContext, // History *before* the assistant turn containing the tool call
                           partialText: combinedTextBefore, // Text before the tool call
                           toolCallPlaceholder: matchedToolCallString, // The <tool .../> tag
                           toolResultPlaceholder: toolResultTag, // The <tool_result .../> tag
                           toolCallData: toolCallData,
                           toolResultData: toolResult,
                           parentId: messageToContinue.parent_message_id // Parent of the message being continued
                       };

                       state.toolCallPending = false;
                       state.streamController = null;
                       state.currentToolCallId = null;
                       // state.abortingForToolCall reset by onError handler

                       // Start the *next* continuation, still technically editing the original message
                       console.log("Starting continuation stream after tool call during initial continue...");
                       // Pass the new history; isContinuation remains true
                       // Pass the targetContentDiv so it continues updating the same block
                       await generateAssistantResponse(messageToContinue.parent_message_id, true, nextContinuationHistory, contentDiv);


                   } catch (toolError) {
                        console.error("Error during tool execution triggered by continuation:", toolError);
                        addSystemMessage(`Error executing tool ${toolCallData.name}: ${toolError.message}`, "error");
                        renderToolResult(contentDiv, `[Error: ${toolError.message}]`); // Render error visual
                        state.toolCallPending = false;
                        state.streamController = null;
                        state.currentToolCallId = null;
                        state.currentAssistantMessageDiv = null;
                        state.abortingForToolCall = false; // Reset flag

                        // Attempt to save partial content up to failure
                        const textBeforeFailure = combinedTextBefore + matchedToolCallString;
                        try {
                            const attachmentsForSave = (messageToContinue.attachments || []).map(att => ({ type: att.type, content: att.content, name: att.name }));
                            const toolCallsForSave = messageToContinue.tool_calls || null;
                            const saveResponse = await fetch(`${API_BASE}/chat/${state.currentChatId}/edit_message/${messageId}`, {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    message: textBeforeFailure + `\n[Tool Error: ${toolError.message}]`,
                                    attachments: attachmentsForSave,
                                    model_name: originalModelName + " (incomplete)",
                                    tool_calls: toolCallsForSave
                                })
                            });
                           if (!saveResponse.ok) throw new Error(`Failed to save partial on tool error: ${await saveResponse.text()}`);
                           await loadChat(state.currentChatId);
                        } catch (saveErr) { console.error("Failed to save partial after tool error in continuation:", saveErr); }

                        cleanupAfterGeneration();
                   }
             }
        );
    } catch (error) { // Catch synchronous setup errors for continuation
         console.error("Error initiating continuation stream:", error);
         addSystemMessage(`Error starting continuation: ${error.message}`, "error");
         cleanupAfterGeneration();
         if (contentDiv) contentDiv.classList.remove('streaming');
         state.currentAssistantMessageDiv = null;
    } finally {
         if (!state.toolCallPending) { // Only remove if no tool call pending
              chatContainer.removeEventListener('scroll', scrollHandler);
         }
    }
}


// Stop Streaming (Frontend Abort) - MODIFIED
function stopStreaming() {
    if (state.streamController && !state.streamController.signal.aborted) {
        console.log("User requested stop. Aborting frontend fetch...");
        // Set a flag *before* aborting if a tool call is pending,
        // although the primary logic now resides in streamLLMResponse's onError.
        // This flag is less critical now but can be kept for potential debugging.
        if (state.toolCallPending) {
            console.log("Stop requested during pending tool call flow.");
            // state.userStoppedDuringToolFlow = true; // Optional flag
        }
        // The onError handler in streamLLMResponse will now catch this abort
        // and handle saving partial state appropriately based on whether
        // state.abortingForToolCall was set (meaning tool detected) or not (meaning user stop).
        state.streamController.abort();

        // DO NOT clean up UI state here. Let the onError handler do it after saving.
        // cleanupAfterGeneration(); // Moved to onError

    } else {
        console.log("No active frontend stream to stop or already aborted.");
        // If stop is clicked when no stream is active but tool state is somehow stuck, reset it.
        if (state.toolCallPending) {
            console.warn("Stop clicked with toolCallPending=true but no active stream. Resetting tool state.");
            addSystemMessage("Resetting potentially stuck tool state.", "warning");
            state.toolCallPending = false;
            state.toolContinuationContext = null;
            state.currentToolCallId = null;
            state.abortingForToolCall = false;
            // Force cleanup if UI might be stuck
            cleanupAfterGeneration();
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

// Helper function to update character action button states
function updateCharacterActionButtons() {
     const select = document.getElementById('character-select');
     const selectedId = select.value;
     document.getElementById('character-edit-btn').disabled = !selectedId;
     document.getElementById('character-delete-btn').disabled = !selectedId;
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
            '--bg-secondary': '#f7f6f4', 
            '--bg-tertiary': '#FDFCFA',
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

// --- addSystemMessage (MODIFIED) ---
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