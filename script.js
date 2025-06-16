// API Configuration (Backend Data API)
// const API_BASE = 'http://localhost:8000';
// API Configuration (Backend Data API)
const API_BASE = 'http://192.168.1.5:8000'; // Use relative paths

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
const toggleAutoscrollBtn = document.getElementById('toggle-autoscroll-btn');

const settingsBtn = document.getElementById('settings-btn'); // Main gear icon
const mainSettingsPopup = document.getElementById('main-settings-popup');
const closeSettingsPopupBtn = document.getElementById('close-settings-popup-btn');
const appearanceSettingsBtn = document.getElementById('appearance-settings-btn'); // Button in new popup
const themeModal = document.getElementById('theme-modal');
const closeThemeModalBtn = document.getElementById('close-theme-modal-btn');

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
    activeBranchInfo: {}, // { parentMessageId: { activeIndex: number, totalBranches: number } } -> Derived from messages during render
    apiKeys: { // Store keys fetched from backend /config endpoint
        openrouter: null,
        google: null,
        local: null,
    },
    toolsEnabled: false, // Flag to control tool usage
    toolCallPending: false,
    toolContinuationContext: null,
    currentToolCallId: null, // Track the ID of the current tool call being processed
    abortingForToolCall: false,
    scrollDebounceTimer: null,
    codeBlocksDefaultCollapsed: false,
    autoscrollEnabled: false, // Default to false
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

// Regex for detecting simple tool calls
const TOOL_CALL_REGEX = /<tool\s+name="(\w+)"((?:\s+\w+="[^"]*")+)\s*\/>/g;
// Regex for detecting tool result tags
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

/**
 * Renders markdown text, handling think blocks, code blocks, and LaTeX.
 * It does NOT handle the special <tool> or <tool_result> tags itself.
 * Code block enhancement respects the global state.codeBlocksDefaultCollapsed.
 *
 * @param {string} text The raw text segment to render (can include <think> block).
 * @param {boolean} [initialCollapsedState=true] Initial collapsed state for think blocks (if any).
 * @param {string|null} [temporaryId=null] Optional temporary ID for the think block wrapper (used during streaming).
 * @returns {string} The rendered HTML string.
 */
function renderMarkdown(text, initialCollapsedState = true, temporaryId = null) {
    let processedText = text || '';
    let html = '';
    let thinkContent = '';
    let remainingTextAfterThink = '';
    let isThinkBlockSegment = processedText.trim().startsWith('<think>');

    if (isThinkBlockSegment) {
        const parseResult = parseThinkContent(processedText);
        thinkContent = parseResult.thinkContent;
        remainingTextAfterThink = parseResult.remainingText;

        const thinkBlockWrapper = document.createElement('div');
        thinkBlockWrapper.className = `think-block ${initialCollapsedState ? 'collapsed' : ''}`;
        if (temporaryId) {
            thinkBlockWrapper.dataset.tempId = temporaryId;
        }

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

        const thinkContentDiv = document.createElement('div');
        thinkContentDiv.className = 'think-content';
        thinkContentDiv.innerHTML = marked.parse(thinkContent || '');
        thinkContentDiv.querySelectorAll('pre').forEach(pre => enhanceCodeBlock(pre));
        thinkBlockWrapper.appendChild(thinkContentDiv);

        html += thinkBlockWrapper.outerHTML;
        processedText = remainingTextAfterThink;
    }

    if (processedText) {
        let remainingHtml = marked.parse(processedText);
        const tempContainer = document.createElement('div');
        tempContainer.innerHTML = remainingHtml;
        tempContainer.querySelectorAll('pre').forEach(preElement => {
            enhanceCodeBlock(preElement);
        });

        let finalHtml = tempContainer.innerHTML;
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

        if (isThinkBlockSegment && temporaryId) {
            const remainingContentTempId = 'streaming-remaining-content';
            html += `<div data-temp-id="${remainingContentTempId}">${finalHtml}</div>`;
        } else {
            html += finalHtml;
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
        copyBtn.innerHTML = '<i class="bi bi-check-lg"></i> Copied';
        copyBtn.disabled = true;
        setTimeout(() => {
            copyBtn.innerHTML = '<i class="bi bi-clipboard"></i> Copy';
            copyBtn.disabled = false;
        }, 1500);
    }).catch(err => {
        console.error('Failed to copy code:', err);
        copyBtn.innerHTML = 'Error';
         setTimeout(() => {
             copyBtn.innerHTML = '<i class="bi bi-clipboard"></i> Copy';
         }, 1500);
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
}

function handleThinkBlockToggle(e) {
    const toggleBtn = e.target.closest('.think-block-toggle');
    if (toggleBtn) {
        const block = toggleBtn.closest('.think-block');
        if (block) {
            const isCollapsed = block.classList.toggle('collapsed');
            const icon = toggleBtn.querySelector('i');
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

function updateEffectiveSystemPrompt() {
    let basePrompt = state.activeSystemPrompt || "";
    let toolsPrompt = "";
    if (state.toolsEnabled && TOOLS_SYSTEM_PROMPT) {
        toolsPrompt = `\n\n${TOOLS_SYSTEM_PROMPT}`;
    }
    state.effectiveSystemPrompt = (basePrompt + toolsPrompt).trim() || null;
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
    await fetchProviderConfig();
    await fetchToolsSystemPrompt();
    await loadGenArgs();
    await fetchChats();

    await populateCharacterSelect();
    setupCharacterEvents();
    setupEventListeners();
    setupScrollListener();
    setupAutoscrollToggle();
    adjustTextareaHeight();
    setupDropZone();
    setupThemeSwitch();
    setupGenerationSettings();
    setupToolToggle();
    setupCodeblockToggle();

    startNewChat();
    applySidebarState();
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

        console.log("Fetched provider config and populated API keys.");
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
    } catch (error) {
        console.error('Error fetching tools system prompt:', error);
        TOOLS_SYSTEM_PROMPT = "";
        addSystemMessage("Failed to fetch tool descriptions from backend.", "warning");
    }
    updateEffectiveSystemPrompt();
}

async function loadGenArgs() {
    const savedGenArgs = localStorage.getItem('genArgs');
    if (savedGenArgs) {
        try { Object.assign(defaultGenArgs, JSON.parse(savedGenArgs)); }
        catch { /* ignore parse error for corrupted local storage */ }
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
    } catch (error) {
        console.error('Error fetching models:', error);
        state.models = [];
    }
    populateModelSelect();
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

            const apiKeyAvailable = !!getApiKey(model.provider);
            option.textContent = `${model.displayName}${apiKeyAvailable ? '' : ' (Key Missing)'}`;
            option.disabled = !apiKeyAvailable;
            modelSelect.appendChild(option);
        });

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

async function fetchChats() {
    try {
        const response = await fetch(`${API_BASE}/chat/get_chats?limit=100`);
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
        document.getElementById('character-select').value = '';
        updateCharacterActionButtons();
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
        messagesWrapper.querySelectorAll('.assistant-row .message').forEach(messageDiv => {
            messageDiv.style.minHeight = ''; // Target .message
        });
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

    function renderBranch(messageNode) {
        if (!messageNode || messageNode.role === 'system') return;
        addMessage(messageNode);
        const children = messageNode.children;
        if (children && children.length > 0) {
            const activeIndex = messageNode.active_child_index ?? 0;
            const safeActiveIndex = Math.min(Math.max(0, activeIndex), children.length - 1);
            const activeChildNode = children[safeActiveIndex];
            if (activeChildNode) { renderBranch(activeChildNode); }
            else { console.warn(`Could not find active child at index ${safeActiveIndex}.`); }
        }
    }
    rootMessages.forEach(rootNode => renderBranch(rootNode));

    const allRows = Array.from(messagesWrapper.querySelectorAll('.message-row'));
    const rowsToRemove = new Set();
    let currentMergeTargetRow = null;
    let accumulatedContentHTML = '';

    for (let i = 0; i < allRows.length; i++) {
        const currentRow = allRows[i];
        const isAssistant = currentRow.classList.contains('assistant-row');
        const isTool = currentRow.classList.contains('tool-row');
        const isUser = currentRow.classList.contains('user-row');

        if (isAssistant || isTool) {
            if (!currentMergeTargetRow) {
                if (isAssistant) {
                   currentMergeTargetRow = currentRow;
                   accumulatedContentHTML = '';
                }
            } else {
                const contentDiv = currentRow.querySelector('.message-content');
                if (contentDiv) {
                     accumulatedContentHTML += contentDiv.innerHTML;
                }
                rowsToRemove.add(currentRow);
            }
        }

        if ((isUser || i === allRows.length - 1) && currentMergeTargetRow) {
            if (accumulatedContentHTML) {
                const targetContentDiv = currentMergeTargetRow.querySelector('.message-content');
                if (targetContentDiv) {
                    targetContentDiv.insertAdjacentHTML('beforeend', accumulatedContentHTML);
                }
            }
            currentMergeTargetRow = null;
            accumulatedContentHTML = '';
        }

        if (isUser) {
            currentMergeTargetRow = null;
            accumulatedContentHTML = '';
        }
    }

    rowsToRemove.forEach(row => row.remove());

    requestAnimationFrame(() => {
         messagesWrapper.querySelectorAll('.message-content pre code').forEach(block => {
            highlightRenderedCode(block.closest('pre'));
         });
    });

    messagesWrapper.querySelectorAll('.assistant-row .message').forEach(messageDiv => {
        messageDiv.style.minHeight = ''; // Target .message and reset
    });

    const lastMessageRow = messagesWrapper.lastElementChild;
    if (lastMessageRow && lastMessageRow.classList.contains('assistant-row') && !lastMessageRow.classList.contains('placeholder')) {
        const lastAssistantMessageDiv = lastMessageRow.querySelector('.message'); // Target .message
        if (lastAssistantMessageDiv) {
            // The pulsing cursor is inside .message-content, which is a child of .message.
            // So checking for it in lastMessageRow (which contains .message) is still valid.
            if (!lastMessageRow.querySelector('.pulsing-cursor')) {
                 lastAssistantMessageDiv.style.minHeight = 'calc(-384px + 100dvh)';
            }
        }
    }
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
    const button = document.getElementById('toggle-codeblocks-btn');
    if (!button) {
        console.error("Global code block toggle button not found!");
        return;
    }

    button.addEventListener('click', () => {
        state.codeBlocksDefaultCollapsed = !state.codeBlocksDefaultCollapsed;
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
    copyBtn.innerHTML = '<i class="bi bi-clipboard"></i> Copy';
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

    targetContentDiv.innerHTML = '';

    if (textToParse.trim().startsWith('<think>')) {
        const fullRenderedHtml = renderMarkdown(textToParse, true, thinkBlockTempId);
        targetContentDiv.innerHTML = fullRenderedHtml;
         const thinkBlock = targetContentDiv.querySelector('.think-block');
         if (thinkBlock && !thinkBlock.dataset.tempId) {
             thinkBlock.dataset.tempId = thinkBlockTempId;
         }
         const potentialRemainingDiv = thinkBlock?.nextElementSibling;
         const { remainingText } = parseThinkContent(textToParse);
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
            const toolResultTag = match[4];

            if (toolCallTag) {
                const toolName = match[2];
                const attrsString = match[3] || "";
                segments.push({ type: 'tool', data: { name: toolName, args: parseAttributes(attrsString) } });
            } else if (toolResultTag) {
                let resultString = match[6] || "";
                resultString = resultString.replace(/&quot;/g, '"'); // Decode &quot; entities
                segments.push({ type: 'result', data: resultString });
            }
            lastIndex = TOOL_TAG_REGEX.lastIndex;
        }

        const remainingTextAfterTags = textToParse.substring(lastIndex);
        if (remainingTextAfterTags) {
            segments.push({ type: 'text', data: remainingTextAfterTags });
        }

        segments.forEach(segment => {
            if (segment.type === 'text') {
                targetContentDiv.insertAdjacentHTML('beforeend', renderMarkdown(segment.data));
            } else if (segment.type === 'tool') {
                renderToolCallPlaceholder(targetContentDiv, segment.data.name, segment.data.args);
            } else if (segment.type === 'result') {
                renderToolResult(targetContentDiv, segment.data);
            }
        });
    }
    applyCodeBlockDefaults(targetContentDiv);
}

function applyCodeBlockDefaults(containerElement) {
    if (!containerElement) return;
    const codeBlocks = containerElement.querySelectorAll('.code-block-wrapper');
    codeBlocks.forEach(block => {
        setCodeBlockCollapsedState(block, state.codeBlocksDefaultCollapsed);
    });
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

    const avatarActionsDiv = document.createElement('div');
    avatarActionsDiv.className = 'message-avatar-actions';
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'message-actions';

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

    } else if (role === 'assistant') {
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

        const continueBtn = document.createElement('button');
        continueBtn.className = 'message-action-btn';
        continueBtn.innerHTML = '<i class="bi bi-arrow-bar-right"></i>';
        continueBtn.title = 'Continue generating this response';
        continueBtn.addEventListener('click', () => continueMessage(message.message_id));

        orderedButtons = [genInfoBtn, copyBtn, editBtn, regenerateBtn, branchBtn, continueBtn, deleteBtn];

    } else if (role === 'tool') {
        orderedButtons = [copyBtn, deleteBtn];
    }

    orderedButtons.forEach(btn => actionsDiv.appendChild(btn));

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

    avatarActionsDiv.appendChild(actionsDiv);
    messageDiv.appendChild(avatarActionsDiv);
    messageRow.appendChild(messageDiv);
    messagesWrapper.appendChild(messageRow);
    return contentDiv;
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
         await loadChat(state.currentChatId);
     } catch (error) {
         console.error('Error setting active branch:', error);
         addSystemMessage(`Failed to switch branch: ${error.message}`, "error");
     }
}

async function deleteMessage(messageId) {
    if (!state.currentChatId) return;

    const messageToDelete = state.messages.find(m => m.message_id === messageId);
    if (!messageToDelete) {
        console.warn(`Message ${messageId} not found in state for deletion.`);
        return;
    }
    console.log(`Deleting message ${messageId} and descendants.`);

    try {
        const response = await fetch(`${API_BASE}/chat/${state.currentChatId}/delete_message/${messageId}`, {
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
    let textToCopy = '';
    let accumulatedText = '';

    contentDiv.childNodes.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
            accumulatedText += node.textContent;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (accumulatedText.trim()) {
                textToCopy += accumulatedText + '\n';
                accumulatedText = '';
            }
            if (node.classList.contains('tool-call-block')) {
                const toolName = node.dataset.toolName || 'unknown_tool';
                const argsElement = node.querySelector('.tool-arguments');
                const argsText = argsElement ? argsElement.textContent.trim() : '{}';
                textToCopy += `\n[Tool Call: ${toolName}]\nArguments:\n${argsText}\n\n`;
            } else if (node.classList.contains('tool-result-block')) {
                const resultElement = node.querySelector('.tool-result-content');
                const resultText = resultElement ? resultElement.innerText.trim() : '[No Result Content]';
                 textToCopy += `[Tool Result]\n${resultText}\n\n`;
            } else if (!node.classList.contains('attachments-container') && !node.classList.contains('message-avatar-actions') && !node.closest('.tool-header')) {
                accumulatedText += node.innerText || node.textContent;
            }
        }
    });

    if (accumulatedText.trim()) {
        textToCopy += accumulatedText;
    }
    textToCopy = textToCopy.trim().replace(/\n{3,}/g, '\n\n');

    if (!textToCopy) {
        console.warn("Structured copy resulted in empty string, falling back to dataset.raw or textContent");
        textToCopy = contentDiv.dataset.raw || contentDiv.textContent || '';
        textToCopy = textToCopy.trim();
    }

    if (!textToCopy) {
        addSystemMessage("Nothing to copy.", "info");
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
    sidebarToggle.addEventListener('click', toggleSidebar);
    modelSelect.addEventListener('change', handleModelChange);
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
            sidebarElement.classList.toggle('show');
            sidebarOverlay.classList.toggle('show');
        });
        sidebarOverlay.addEventListener('click', () => {
            sidebarElement.classList.remove('show');
            sidebarOverlay.classList.remove('show');
        });
        document.addEventListener('click', (e) => {
            if (window.innerWidth <= 768 &&
                sidebarElement.classList.contains('show') &&
                !sidebarElement.contains(e.target) &&
                !mobileMenuBtn.contains(e.target)) {
                sidebarElement.classList.remove('show');
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

    if (appearanceSettingsBtn && themeModal && mainSettingsPopup) {
        appearanceSettingsBtn.addEventListener('click', () => {
            themeModal.style.display = 'flex';
            mainSettingsPopup.style.display = 'none';
        });
    }
    if (closeThemeModalBtn && themeModal) {
        closeThemeModalBtn.addEventListener('click', () => {
            themeModal.style.display = 'none';
        });
    }
    if (themeModal) {
        themeModal.addEventListener('click', (e) => {
            if (e.target === themeModal) {
                themeModal.style.display = 'none';
            }
        });
    }
    document.querySelectorAll('.theme-option[data-theme]').forEach(button => {
        button.addEventListener('click', () => {
            applyTheme(button.dataset.theme);
        });
    });

    document.addEventListener('click', (e) => {
        if (mainSettingsPopup && mainSettingsPopup.style.display === 'block' &&
            !mainSettingsPopup.contains(e.target) && !settingsBtn.contains(e.target)) {
            mainSettingsPopup.style.display = 'none';
        }
    });
}

function setupToolToggle() {
    const savedToolState = localStorage.getItem('toolsEnabled') === 'true';
    state.toolsEnabled = savedToolState;
    toggleToolsBtn.classList.toggle('active', state.toolsEnabled);
    updateEffectiveSystemPrompt();

    toggleToolsBtn.addEventListener('click', () => {
        state.toolsEnabled = !state.toolsEnabled;
        toggleToolsBtn.classList.toggle('active', state.toolsEnabled);
        localStorage.setItem('toolsEnabled', state.toolsEnabled);
        console.log("Tools enabled:", state.toolsEnabled);
        updateEffectiveSystemPrompt();
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

    if (isCollapsed && window.innerWidth > 768) {
         sidebar.classList.add('sidebar-collapsed');
         if(icon) icon.className = `bi bi-chevron-right`;
         textElements.forEach(el => { el.style.display = 'none'; });
         document.documentElement.style.setProperty('--sidebar-width', '0px');
    } else if (window.innerWidth > 768) {
         sidebar.classList.remove('sidebar-collapsed');
         if(icon) icon.className = `bi bi-chevron-left`;
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
    const selectedOption = modelSelect.options[modelSelect.selectedIndex];
    const supportsImages = selectedOption ? selectedOption.dataset.supportsImages === 'true' : false;

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
    if (!supportsImages) return;

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
    console.log(`%c[generateAssistantResponse RUN - Backend Mode] parentId: ${parentId}, toolsEnabled: ${toolsEnabled}, isEditing: ${isEditing}, targetContentDiv provided: ${!!targetContentDiv}`, "color: purple; font-weight: bold;", { currentChatId: state.currentChatId });

    if (!state.currentChatId) { console.error("generateAssistantResponse: No current chat ID."); cleanupAfterGeneration(); return; }
    if (!targetContentDiv) { console.error("generateAssistantResponse: No target content div provided."); cleanupAfterGeneration(); return; }
    if (targetContentDiv.classList.contains('streaming')) {
         console.warn("generateAssistantResponse: Generation already in progress for this element.");
         return;
    }

    setGenerationInProgressUI(true);
    state.currentAssistantMessageDiv = targetContentDiv; // Keep track of the div we are streaming into
    targetContentDiv.classList.add('streaming');
    const messageDivForStream = targetContentDiv.closest('.message');
    if (messageDivForStream) {
        messageDivForStream.style.minHeight = '';
    }

    buildContentHtml(targetContentDiv, initialText); // Initial render (e.g. for "continue")
    targetContentDiv.querySelector('.generation-stopped-indicator')?.remove();
    targetContentDiv.insertAdjacentHTML('beforeend', '<span class="pulsing-cursor">█</span>');

    let fullRenderedContent = initialText; // This will accumulate chunks

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
            modelName,
            generationArgs,
            toolsEnabled,
            // --- onChunk Callback ---
            (textChunk) => {
                if (!targetContentDiv || state.streamController?.signal.aborted || state.currentAssistantMessageDiv !== targetContentDiv) return;
                fullRenderedContent += textChunk;
                // ... (rest of onChunk rendering logic as before, it updates targetContentDiv live)
                const thinkBlockTempId = 'streaming-think-block';
                const remainingContentTempId = 'streaming-remaining-content';
                let existingThinkBlockInTarget = targetContentDiv.querySelector(`.think-block[data-temp-id="${thinkBlockTempId}"]`);

                if (fullRenderedContent.trim().startsWith('<think>')) {
                    const { thinkContent, remainingText } = parseThinkContent(fullRenderedContent);
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
                if (state.autoscrollEnabled) scrollToBottom('smooth');
            },
            // --- onToolStart Callback ---
            (name, args) => {
                 if (!targetContentDiv || state.streamController?.signal.aborted || state.currentAssistantMessageDiv !== targetContentDiv) return;
                console.log(`Tool Start received: ${name}`, args);
                buildContentHtml(targetContentDiv, fullRenderedContent); // Render accumulated content before tool
                targetContentDiv.querySelector('.pulsing-cursor')?.remove();
                 if (!state.streamController?.signal.aborted) {
                    targetContentDiv.insertAdjacentHTML('beforeend', '<span class="pulsing-cursor">█</span>');
                 }
                finalizeStreamingCodeBlocks(targetContentDiv);
                updateStreamingMinHeight();
                if (state.autoscrollEnabled) scrollToBottom('smooth');
            },
            // --- onToolEnd Callback ---
            (name, result, error) => {
                 if (!targetContentDiv || state.streamController?.signal.aborted || state.currentAssistantMessageDiv !== targetContentDiv) return;
                 console.log(`Tool End received: ${name}`, error ? `Error: ${error}` : `Result: ${result}`);
                 buildContentHtml(targetContentDiv, fullRenderedContent); // Render accumulated content before tool result
                 targetContentDiv.querySelector('.pulsing-cursor')?.remove();
                 if (!state.streamController?.signal.aborted) {
                    targetContentDiv.insertAdjacentHTML('beforeend', '<span class="pulsing-cursor">█</span>');
                 }
                 finalizeStreamingCodeBlocks(targetContentDiv);
                 updateStreamingMinHeight();
                if (state.autoscrollEnabled) scrollToBottom('smooth');
            },
            // --- onComplete Callback ---
            async () => {
                // ... (onComplete logic remains largely the same, it implies successful completion)
                if (state.currentAssistantMessageDiv !== targetContentDiv) {
                     console.warn("onComplete: Target div no longer the active streaming div. Skipping final updates.");
                     if (stopButton.style.display !== 'none' || sendButton.disabled) {
                          setGenerationInProgressUI(false);
                     }
                     return;
                }
                console.log("Backend generation completed successfully.");
                if (targetContentDiv) {
                    targetContentDiv.classList.remove('streaming');
                    targetContentDiv.querySelector('.pulsing-cursor')?.remove();
                    buildContentHtml(targetContentDiv, fullRenderedContent); 
                    finalizeStreamingCodeBlocks(targetContentDiv);
                }

                if (state.autoscrollEnabled) scrollToBottom('smooth');
                else requestAnimationFrame(updateScrollButtonVisibility);

                try {
                    console.log("Reloading chat state after successful backend generation.");
                    if (state.currentChatId && targetContentDiv?.closest('.message-row')) {
                        await loadChat(state.currentChatId);
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
            // --- onError Callback (MODIFIED) ---
            async (error, isAbort) => {
                console.warn(`>>> onError called: isAbort=${isAbort}, message: ${error.message}`);
                console.log("State of fullRenderedContent at start of onError:", JSON.stringify(fullRenderedContent));

                const rowBeingStreamedTo = targetContentDiv ? targetContentDiv.closest('.message-row') : null;
                const isPlaceholderRow = rowBeingStreamedTo ? rowBeingStreamedTo.classList.contains('placeholder') : false;

                // 1. Clean up visual streaming indicators from the current target div.
                //    The actual content will be rendered by loadChat.
                if (targetContentDiv) {
                    targetContentDiv.classList.remove('streaming');
                    targetContentDiv.querySelector('.pulsing-cursor')?.remove();
                    targetContentDiv.querySelector('.generation-stopped-indicator')?.remove();
                    console.log("Cleaned streaming UI from targetContentDiv in onError.");
                } else if (state.currentAssistantMessageDiv) { // Fallback
                    state.currentAssistantMessageDiv.classList.remove('streaming');
                    state.currentAssistantMessageDiv.querySelector('.pulsing-cursor')?.remove();
                    state.currentAssistantMessageDiv.querySelector('.generation-stopped-indicator')?.remove();
                    console.log("Cleaned streaming UI from state.currentAssistantMessageDiv (fallback) in onError.");
                }

                // 2. Reset global generation UI state. This also nulls state.streamController.
                setGenerationInProgressUI(false);
                state.currentAssistantMessageDiv = null; // Ensure this is cleared

                // 3. Handle specific logic for abort vs. other errors.
                if (isAbort) {
                    addSystemMessage("Generation stopped by user.", "info", 2000);

                    if (state.currentChatId) {
                        try {
                            console.log("User abort: Reloading chat state. Delaying for backend save completion.");
                            // Increased delay: gives backend more time to save the aborted message
                            // before loadChat attempts to fetch it.
                            await new Promise(resolve => setTimeout(resolve, 750)); // Adjust as needed

                            await loadChat(state.currentChatId);
                            console.log("Chat reloaded after user abort.");
                            // scrollToBottom might be useful here if autoscroll is off but user expects to see the new message
                             if (state.autoscrollEnabled) scrollToBottom('smooth');
                             else requestAnimationFrame(updateScrollButtonVisibility);

                        } catch (loadError) {
                            console.error("User abort: Error reloading chat even after delay.", loadError);
                            addSystemMessage("Error refreshing chat after stop. Please try manually.", "error");
                            // Fallback UI adjustments if loadChat fails post-abort
                            if (rowBeingStreamedTo && isPlaceholderRow) {
                                console.warn("User abort & loadChat fail: Removing placeholder row.");
                                rowBeingStreamedTo.remove();
                            }
                        }
                    } else {
                        console.warn("User abort: No current chat ID. Cannot reload chat state.");
                        if (rowBeingStreamedTo && isPlaceholderRow) {
                            rowBeingStreamedTo.remove(); // Clean up placeholder if no chat context
                        }
                    }
                } else { // Non-abort error
                    addSystemMessage(`Generation Error: ${error.message}`, "error");
                    // For non-aborts, render what we have plus an error message.
                    if (targetContentDiv) {
                        buildContentHtml(targetContentDiv, fullRenderedContent);
                        finalizeStreamingCodeBlocks(targetContentDiv);
                        targetContentDiv.insertAdjacentHTML('beforeend', `<br><span class="system-info-row error">Error: ${error.message}</span>`);
                    }
                    if (rowBeingStreamedTo && isPlaceholderRow) {
                        // If it was an error on a brand new placeholder, remove it.
                        rowBeingStreamedTo.remove();
                    }
                }
                // Ensure min-height is correctly set for the new last message, if any
                const lastMessageRowElement = messagesWrapper.lastElementChild;
                if (lastMessageRowElement && lastMessageRowElement.classList.contains('assistant-row') && !lastMessageRowElement.classList.contains('placeholder')) {
                    const lastAssistantMessageDivElement = lastMessageRowElement.querySelector('.message');
                    if (lastAssistantMessageDivElement && !lastAssistantMessageDivElement.querySelector('.pulsing-cursor')) {
                        lastAssistantMessageDivElement.style.minHeight = 'calc(-384px + 100dvh)';
                    }
                }
                requestAnimationFrame(updateScrollButtonVisibility);
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
    console.log(`>>> setGenerationInProgressUI called with inProgress = ${inProgress}`);
    if (inProgress) {
        stopButton.style.display = 'flex';
        sendButton.disabled = true;
        sendButton.innerHTML = '<div class="spinner"></div>';
    } else {
        stopButton.style.display = 'none';
        sendButton.disabled = false;
        sendButton.innerHTML = '<i class="bi bi-arrow-up"></i>';
        console.log(">>> Send button state reset in setGenerationInProgressUI");
        requestAnimationFrame(updateScrollButtonVisibility);

        // Ensure the controller is aborted and nulled if we are truly done.
        if (state.streamController) {
            if (!state.streamController.signal.aborted) {
                 console.warn(">>> Controller not aborted when setGenerationInProgressUI(false) called. Aborting now.");
                 state.streamController.abort();
            }
            state.streamController = null;
            console.log(">>> Cleared streamController reference");
        } else {
             console.log(">>> No streamController reference to clear or already cleared");
        }
        // Resetting tool state flags, assuming this is a general "generation ended" state.
        state.toolCallPending = false;
        state.toolContinuationContext = null;
        state.currentToolCallId = null;
        state.abortingForToolCall = false;
        console.log(">>> Reset tool state flags");
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

    const selectedOption = modelSelect.options[modelSelect.selectedIndex];
    if (!selectedOption) {
         addSystemMessage("Please select a model.", "error"); return;
    }
    const modelName = selectedOption.value;

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
    console.log("Running cleanupAfterGeneration");

    // Abort stream and reset UI buttons (send/stop)
    setGenerationInProgressUI(false); // This also aborts and nulls state.streamController if active

    // Explicitly clear and clean the currentAssistantMessageDiv if it's still set
    if (state.currentAssistantMessageDiv) {
        state.currentAssistantMessageDiv.classList.remove('streaming');
        state.currentAssistantMessageDiv.querySelector('.pulsing-cursor')?.remove();
        state.currentAssistantMessageDiv.querySelector('.generation-stopped-indicator')?.remove();
        // Also reset its minHeight if it was potentially set for streaming the last message
        const messageDiv = state.currentAssistantMessageDiv.closest('.message');
        if (messageDiv) messageDiv.style.minHeight = '';

        state.currentAssistantMessageDiv = null;
        console.log("Cleared and cleaned state.currentAssistantMessageDiv in cleanupAfterGeneration.");
    }

    // Reset tool-related state flags as a general precaution
    state.toolCallPending = false;
    state.toolContinuationContext = null;
    state.currentToolCallId = null;
    state.abortingForToolCall = false;
    console.log("Reset tool state flags in cleanupAfterGeneration.");
}

function renderToolCallPlaceholder(messageContentDiv, toolName, args) {
    if (!messageContentDiv) return;

    const toolCallBlock = document.createElement('div');
    toolCallBlock.className = 'tool-call-block collapsed';
    toolCallBlock.dataset.toolName = toolName;

    const toolHeader = document.createElement('div');
    toolHeader.className = 'tool-header';

    const toolNameSpan = document.createElement('span');
    toolNameSpan.className = 'tool-header-name';
    const toolIcon = toolName === 'add' ? 'calculator' : (toolName === 'search' ? 'search' : 'tools');
    toolNameSpan.innerHTML = `<i class="bi bi-${toolIcon}"></i> Calling: ${toolName}`;

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
        const argsString = typeof args === 'object' && args !== null
            ? JSON.stringify(args, null, 2)
            : String(args);
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        const lang = (typeof args === 'object' && args !== null) ? 'json' : 'plaintext';
        code.className = `language-${lang}`;
        code.textContent = argsString;
        try { hljs.highlightElement(code); }
        catch(e) { console.warn("Error highlighting tool args:", e); }
        pre.appendChild(code);
        toolArgsDiv.appendChild(pre);
    } catch {
        toolArgsDiv.textContent = "[Invalid Arguments]";
    }
    toolCallBlock.appendChild(toolArgsDiv);
    messageContentDiv.appendChild(toolCallBlock);
}

function renderToolResult(messageContentDiv, resultText) {
    if (!messageContentDiv) return;

    const toolResultBlock = document.createElement('div');
    toolResultBlock.className = 'tool-result-block collapsed';

    const toolHeader = document.createElement('div');
    toolHeader.className = 'tool-header';

    const toolNameSpan = document.createElement('span');
    toolNameSpan.className = 'tool-header-name';
    const isError = typeof resultText === 'string' &&
                    (resultText.toLowerCase().startsWith('[error:') ||
                     resultText.toLowerCase().startsWith('error:'));
    const iconClass = isError ? 'exclamation-circle-fill text-danger' : 'check-circle-fill';
    const titleText = isError ? 'Tool Error' : 'Tool Result';
    toolNameSpan.innerHTML = `<i class="bi bi-${iconClass}"></i> ${titleText}`;

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
    toolResultContent.innerHTML = renderMarkdown(resultText || '[Empty Result]');

    toolResultBlock.appendChild(toolResultContent);
    messageContentDiv.appendChild(toolResultBlock);
}

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
    const startRow = messagesWrapper.querySelector(`.message-row[data-message-id="${startMessageId}"]`);
    if (!startRow) {
        console.warn(`removeMessageAndDescendantsFromDOM: Start row ${startMessageId} not found.`);
        return;
    }
    const removedIds = new Set();
    function removeRecursively(rowElement) {
        if (!rowElement) return;
        const messageId = rowElement.dataset.messageId;
        if (!messageId || removedIds.has(messageId)) return;
        const childRows = messagesWrapper.querySelectorAll(`.message-row[data-parent-id="${messageId}"]`);
        childRows.forEach(child => removeRecursively(child));
        console.log(`Removing DOM row for message ${messageId}`);
        rowElement.remove();
        removedIds.add(messageId);
    }
    removeRecursively(startRow);
    console.log("Finished removing branch from DOM, removed IDs:", Array.from(removedIds));
}

async function deleteMessageFromBackend(chatId, messageId) {
    try {
        const response = await fetch(`${API_BASE}/chat/${chatId}/delete_message/${messageId}`, { method: 'POST' });
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

    const messageToRegen = state.messages.find(m => m.message_id === messageIdToRegen);
    const parentMessage = messageToRegen?.parent_message_id
        ? state.messages.find(m => m.message_id === messageToRegen.parent_message_id)
        : null;

    if (!messageToRegen || messageToRegen.role !== 'llm' || !parentMessage) {
        addSystemMessage("Can only regenerate assistant responses that have a parent.", "error");
        return;
    }
    const parentMessageId = parentMessage.message_id;
    const modelNameToUse = modelSelect.value;
    if (!modelNameToUse) {
        addSystemMessage("Please select a model before regenerating.", "error");
        return;
    }

    console.log(`Regenerating from parent ${parentMessageId} (targeting llm message ${messageIdToRegen}, new branch: ${newBranch}) using model ${modelNameToUse}`);
    let assistantPlaceholderRow = null;
    const generationParentId = parentMessageId;

    try {
        const parentRow = messagesWrapper.querySelector(`.message-row[data-message-id="${parentMessageId}"]`);
        if (!parentRow) {
             console.error(`Parent row ${parentMessageId} not found in DOM. Cannot place placeholder correctly.`);
             addSystemMessage("Error: Parent message UI not found. Aborting regeneration.", "error");
             await loadChat(currentChatId);
             cleanupAfterGeneration();
             return;
        }

        if (!newBranch) {
            console.log(`Replacing: Deleting message branch starting with ${messageIdToRegen}.`);
            removeMessageAndDescendantsFromDOM(messageIdToRegen);
            const deleteSuccess = await deleteMessageFromBackend(currentChatId, messageIdToRegen);
            if (!deleteSuccess) {
                addSystemMessage("Failed to delete old message from backend. Reloading chat.", "error");
                await loadChat(currentChatId);
                cleanupAfterGeneration();
                return;
            }
            const descendantIds = new Set();
            const queue = [messageIdToRegen];
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
            if (parentNodeInState && parentNodeInState.child_message_ids && parentNodeInState.child_message_ids.length > 0) {
                const activeChildIndex = parentNodeInState.active_child_index ?? 0;
                const safeActiveIndex = Math.min(Math.max(0, activeChildIndex), parentNodeInState.child_message_ids.length - 1);
                const activeChildIdToClear = parentNodeInState.child_message_ids[safeActiveIndex];
                if (activeChildIdToClear) {
                    console.log(`Branching: Visually removing current active branch starting with ${activeChildIdToClear} from DOM.`);
                    removeMessageAndDescendantsFromDOM(activeChildIdToClear);
                } else {
                    console.log("Branching: Parent had no known active children in state to remove from DOM, or index out of bounds.");
                }
            } else {
                console.warn(`Branching: Parent ${parentMessageId} has no children in state, or child_message_ids is empty. No DOM branch to clear visually.`);
            }
        }

        assistantPlaceholderRow = createPlaceholderMessageRow(`temp_assistant_${Date.now()}`, generationParentId);
        parentRow.insertAdjacentElement('afterend', assistantPlaceholderRow);
        const assistantContentDiv = assistantPlaceholderRow.querySelector('.message-content');
        if (!assistantContentDiv) {
             assistantPlaceholderRow?.remove();
             throw new Error("Failed to create assistant response placeholder element.");
        }

        // The initial scroll to the placeholder will be handled by generateAssistantResponse.

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

function scrollToBottom(behavior = 'auto') {
    if (!state.autoscrollEnabled && behavior === 'smooth') {
        requestAnimationFrame(updateScrollButtonVisibility);
        return;
    }
    requestAnimationFrame(() => {
        if (chatContainer) {
            chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: behavior });
        }
        updateScrollButtonVisibility();
    });
}

async function continueMessage(messageIdToContinue) {
    if (!state.currentChatId || document.getElementById('send-button').disabled) {
        addSystemMessage("Cannot continue while busy.", "warning");
        return;
    }
    const messageToContinue = state.messages.find(m => m.message_id === messageIdToContinue);
    if (!messageToContinue || messageToContinue.role !== 'llm') {
        addSystemMessage("Can only continue assistant messages.", "error"); return;
    }

    const modelNameToUse = modelSelect.value;
    if (!modelNameToUse) {
        addSystemMessage("Please select a model before continuing.", "error");
        return;
    }
    const parentId = messageToContinue.parent_message_id;
    const rawMessage = messageToContinue.message || '';
    TOOL_TAG_REGEX.lastIndex = 0;
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
    const targetMessageRow = messagesWrapper.querySelector(`.message-row[data-message-id="${messageIdToContinue}"]`);
    const targetContentDiv = targetMessageRow?.querySelector('.message-content');
    if (!targetContentDiv) {
        addSystemMessage("Error: Could not find message content area.", "error"); return;
    }

    await generateAssistantResponse(
        parentId,
        targetContentDiv,
        modelNameToUse,
        defaultGenArgs,
        state.toolsEnabled,
        true,
        messageToContinue.message || ''
    );
}

async function stopStreaming() {
    if (state.streamController && !state.streamController.signal.aborted) {
        console.log("User requested stop. Signaling backend and then aborting frontend fetch.");

        // Step 1: Signal backend to abort and save. Await its acknowledgement.
        if (state.currentChatId) {
            console.log(`Signaling backend to abort generation for chat ${state.currentChatId} and awaiting acknowledgement...`);
            try {
                // Ensure the backend endpoint only returns success after the message is saved.
                const abortResponse = await fetch(`${API_BASE}/chat/${state.currentChatId}/abort_generation`, { method: 'POST' });
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


async function fetchCharacters() {
    try {
        const response = await fetch(`${API_BASE}/chat/list_characters`);
        if (!response.ok) throw new Error(`Failed to fetch characters: ${response.statusText}`);
        return await response.json();
    } catch (error) {
        console.error('Error fetching characters:', error);
        return [];
    }
}

async function populateCharacterSelect() {
    const characters = await fetchCharacters();
    const select = document.getElementById('character-select');
    const currentVal = select.value;
    select.innerHTML = '<option value="">No Character</option>';

    if (characters.length > 0) {
        characters.forEach(char => {
            const option = document.createElement('option');
            option.value = char.character_id;
            option.textContent = char.character_name;
            select.appendChild(option);
        });
        if (characters.some(c => c.character_id === currentVal)) {
             select.value = currentVal;
        } else if (state.currentCharacterId && characters.some(c => c.character_id === state.currentCharacterId)) {
             select.value = state.currentCharacterId;
        }
    }
    updateCharacterActionButtons();
}

function displayActiveSystemPrompt(characterName, promptText) {
    const promptContainer = document.getElementById('active-prompt-container');
    if (!promptContainer) return;

    const nameToDisplay = characterName || (state.toolsEnabled ? 'Tools Enabled' : '');
    if (!nameToDisplay && !promptText) {
        promptContainer.innerHTML = '';
        promptContainer.onclick = null;
        promptContainer.style.cursor = 'default';
        promptContainer.style.visibility = 'hidden';
        return;
    }

    promptContainer.style.visibility = 'visible';
    promptContainer.innerHTML = `
        <i class="bi ${characterName ? 'bi-person-check-fill' : (state.toolsEnabled ? 'bi-tools' : '')}"></i>
        ${nameToDisplay ? `<span class="active-prompt-name">${nameToDisplay}</span>` : ''}
    `;

    if (promptText) {
        promptContainer.onclick = () => viewSystemPromptPopup(promptText, characterName || "Effective System Prompt");
        promptContainer.style.cursor = 'pointer';
        promptContainer.title = 'View effective system prompt';
    } else {
        promptContainer.onclick = null;
        promptContainer.style.cursor = 'default';
        promptContainer.title = '';
    }
}

function viewSystemPromptPopup(promptText, characterName = "System Prompt") {
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
    closeBtn.title = `Close ${characterName} Prompt`;
    closeBtn.addEventListener('click', () => popup.remove());

    const contentElement = document.createElement('pre');
    contentElement.textContent = promptText;
    contentElement.className = 'system-prompt-popup-text';

    const titleElement = document.createElement('h4');
    titleElement.textContent = characterName;
    titleElement.style.color = "var(--text-primary)";
    titleElement.style.marginTop = "10px";
    titleElement.style.textAlign = "center";

    container.appendChild(closeBtn);
    container.appendChild(titleElement);
    container.appendChild(contentElement);
    popup.appendChild(container);
    document.body.appendChild(popup);
}

function openCharacterModal(mode, character = null) {
    const modal = document.getElementById('character-modal');
    const form = document.getElementById('character-form');
    const titleSpan = document.getElementById('modal-title');
    const submitBtn = document.getElementById('submit-btn');
    const characterIdInput = document.getElementById('character-id');
    const nameInput = document.getElementById('character-name');
    const syspromptInput = document.getElementById('character-sysprompt');

    form.reset();
    form.dataset.mode = mode;

    if (mode === 'create') {
        titleSpan.textContent = 'Create New Character';
        submitBtn.textContent = 'Create';
        characterIdInput.value = '';
    } else if (mode === 'edit' && character) {
        titleSpan.textContent = 'Edit Character';
        submitBtn.textContent = 'Save Changes';
        characterIdInput.value = character.character_id;
        nameInput.value = character.character_name;
        syspromptInput.value = character.sysprompt;
    } else {
         console.error("Invalid call to openCharacterModal");
         return;
    }
    modal.style.display = 'flex';
    nameInput.focus();
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
        updateCharacterActionButtons();

         let selectedChar = null;
         if (selectedCharacterId) {
              try {
                  const characters = await fetchCharacters();
                  selectedChar = characters.find(c => c.character_id === selectedCharacterId);
              } catch (e) { console.error("Failed to fetch selected character details", e); }
         }
         state.currentCharacterId = selectedCharacterId;
         state.activeSystemPrompt = selectedChar?.sysprompt || null;
         updateEffectiveSystemPrompt();

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
                addSystemMessage(`Failed to set active character: ${error.message}`, "error");
            }
        }
        characterPopup.style.display = 'none';
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
             addSystemMessage(`Failed to load character details: ${error.message}`, "error");
        }
        characterPopup.style.display = 'none';
    });

    characterDeleteBtn.addEventListener('click', async () => {
        const characterId = characterSelect.value;
        if (!characterId) return;
        // Confirmation removed
        try {
            const response = await fetch(`${API_BASE}/chat/delete_character/${characterId}`, {
                method: 'DELETE'
            });
            if (!response.ok) throw new Error(`Failed to delete character: ${await response.text()}`);
            console.log(`Character ${characterId} deleted.`);

             if (state.currentCharacterId === characterId) {
                 state.currentCharacterId = null;
                 state.activeSystemPrompt = null;
                 localStorage.removeItem('lastCharacterId');
                  updateEffectiveSystemPrompt();
                  if (state.currentChatId) {
                      await fetch(`${API_BASE}/chat/${state.currentChatId}/set_active_character`, {
                           method: 'POST', headers: { 'Content-Type': 'application/json' },
                           body: JSON.stringify({ character_id: null })
                      });
                  }
             }
             await populateCharacterSelect();
        } catch (error) {
            console.error('Error deleting character:', error);
            addSystemMessage(`Failed to delete character: ${error.message}`, "error");
        }
        characterPopup.style.display = 'none';
    });

    document.addEventListener('click', (e) => {
        if (characterPopup.style.display === 'block' && !characterBtn.contains(e.target) && !characterPopup.contains(e.target)) {
            characterPopup.style.display = 'none';
        }
    });

    characterForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const mode = e.target.dataset.mode;
        const name = document.getElementById('character-name').value.trim();
        const sysprompt = document.getElementById('character-sysprompt').value.trim();
        const characterId = document.getElementById('character-id').value;

        if (!name || !sysprompt) {
            addSystemMessage('Character Name and System Prompt are required.', "warning");
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
             await populateCharacterSelect();

             if (outcomeCharacterId) {
                 characterSelect.value = outcomeCharacterId;
                 characterSelect.dispatchEvent(new Event('change', { bubbles: true }));
             }
        } catch (error) {
             console.error(`Error saving character (mode: ${mode}):`, error);
             addSystemMessage(`Failed to save character: ${error.message}`, "error");
        }
    });

    cancelCreateBtn.addEventListener('click', () => {
        characterModal.style.display = 'none';
    });
    characterModal.addEventListener('click', (e) => {
        if (e.target === characterModal) {
            characterModal.style.display = 'none';
        }
    });
}

function updateCharacterActionButtons() {
    const select = document.getElementById('character-select');
    const selectedId = select.value;
    const hasSelection = !!selectedId;

    document.getElementById('character-edit-btn').disabled = !hasSelection;
    document.getElementById('character-delete-btn').disabled = !hasSelection;
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
    highlightCurrentChatInSidebar();

    const selectedCharacterId = document.getElementById('character-select').value || null;
    state.currentCharacterId = selectedCharacterId;
    if (selectedCharacterId) {
         fetchCharacters().then(characters => {
             const selectedChar = characters.find(c => c.character_id === selectedCharacterId);
             state.activeSystemPrompt = selectedChar?.sysprompt || null;
             updateEffectiveSystemPrompt();
         });
     } else {
         state.activeSystemPrompt = null;
         updateEffectiveSystemPrompt();
     }
    state.currentImages = []; state.currentTextFiles = [];
    imagePreviewContainer.innerHTML = '';
    adjustTextareaHeight();
    state.toolCallPending = false;
    state.toolContinuationContext = null;
    state.currentToolCallId = null;
    state.abortingForToolCall = false;
    state.codeBlocksDefaultCollapsed = false;
    updateCodeblockToggleButton();

    // Set autoscroll to OFF by default for new chats
    state.autoscrollEnabled = false;
    localStorage.setItem('autoscrollEnabled', 'false');
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
        const response = await fetch(`${API_BASE}/chat/${state.currentChatId}`, { method: 'DELETE' });
        if (!response.ok) { throw new Error(`Failed to delete chat: ${await response.text()}`); }
        console.log(`Chat ${state.currentChatId} deleted successfully.`);
        const deletedChatId = state.currentChatId;
        startNewChat();
        state.chats = state.chats.filter(c => c.chat_id !== deletedChatId);
        renderChatList();
    } catch (error) { console.error('Error deleting chat:', error); addSystemMessage(`Failed to delete chat: ${error.message}`, "error"); }
}

function setupThemeSwitch() {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    applyTheme(savedTheme);
}

function applyTheme(themeName) {
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
           '--text-primary': '#657b83', '--text-secondary': '#839496', '--accent-color': '#2aa198',
           '--accent-hover': '#217d77', '--accent-color-highlight': 'rgba(42, 161, 152, 0.3)', '--error-color': '#dc322f', '--error-hover': '#b52a27',
           '--message-user': '#eee8d5', '--scrollbar-bg': '#eee8d5',
           '--scrollbar-thumb': '#93a1a1', '--border-color': '#d9cfb3',
           '--tool-call-bg': 'rgba(42, 161, 152, 0.08)', '--tool-call-border': '#2aa198',
           '--tool-result-bg': 'rgba(147, 161, 161, 0.08)', '--tool-result-border': '#93a1a1',
       },
       dark: {
           '--bg-primary': '#0a0a10', '--bg-secondary': '#0f0f15', '--bg-tertiary': '#16161e',
           '--text-primary': '#e0e0e8', '--text-secondary': '#a0a0b0', '--accent-color': '#b86a38',
           '--accent-hover': '#d07c46', '--accent-color-highlight': 'rgba(184, 106, 56, 0.3)', '--error-color': '#e53e3e', '--error-hover': '#ff6666',
           '--message-user': '#141419', '--scrollbar-bg': '#1a1a24',
           '--scrollbar-thumb': '#38383f', '--border-color': '#2a2a38',
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
           '--accent-color-highlight': 'rgba(233,124,93,0.3)',
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
        '--accent-color': '#e97c5d',
        '--accent-hover': '#D97757',
        '--accent-color-highlight': 'rgba(233,124,93,0.3)',
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
    }
   };
    const theme = themes[themeName] || themes.dark;

    Object.entries(theme).forEach(([prop, value]) => {
        document.documentElement.style.setProperty(prop, value);
    });

    const highlightThemeLink = document.getElementById('highlight-theme');
    if (themeName === 'white' || themeName === 'claude_white' || themeName === 'solarized') {
        highlightThemeLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css';
        if (themeName === 'solarized') {
            highlightThemeLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/base16/solarized-light.min.css';
        }
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

function parseThinkContent(text) {
    let thinkContent = '';
    let remainingText = '';
    const thinkStartIndex = text.indexOf('<think>');
    if (thinkStartIndex === -1) {
        return { thinkContent: null, remainingText: text };
    }
    let thinkEndIndex = text.indexOf('</think>');
    if (thinkEndIndex === -1) {
        thinkContent = text.substring(thinkStartIndex + '<think>'.length);
        remainingText = '';
    } else {
        thinkContent = text.substring(thinkStartIndex + '<think>'.length, thinkEndIndex);
        remainingText = text.substring(thinkEndIndex + '</think>'.length);
    }
    return { thinkContent: thinkContent.trim(), remainingText: remainingText.trim() };
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

    const effectiveTimeout = (timeout && typeof timeout === 'number' && timeout > 0) ? timeout : (type === 'error' || type === 'warning' ? 5000 : 3000); // Longer default for errors/warnings


    setTimeout(() => {
        messageRow.style.opacity = '0';
        messageRow.style.transform = 'translateY(-20px) scale(0.95)';
        setTimeout(() => {
            messageRow.remove();
            // if (toastContainer.children.length === 0) {
            //     toastContainer.remove(); // Optionally remove if you prefer
            // }
        }, 300); // Must match CSS transition duration
    }, effectiveTimeout);
}

function setupAutoscrollToggle() {
    if (!toggleAutoscrollBtn) {
        console.error("Autoscroll toggle button not found!");
        return;
    }
    const savedAutoscrollState = localStorage.getItem('autoscrollEnabled');
    // Default to false if not found in localStorage or if state is freshly initialized
    state.autoscrollEnabled = savedAutoscrollState !== null ? savedAutoscrollState === 'true' : false;
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