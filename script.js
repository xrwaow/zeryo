// API Configuration (Backend Data API)
const API_BASE = 'http://localhost:8000';

// Global Config (Fetched from backend)
let PROVIDER_CONFIG = {
    openrouter_base_url: "https://openrouter.ai/api/v1",
    local_base_url: "http://127.0.0.1:8080",
    // Keys are now ONLY stored in state.apiKeys, populated by fetchProviderConfig
};

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
const clearChatBtn = document.getElementById('clear-chat-btn'); // Delete chat button
const newChatBtn = document.getElementById('new-chat-btn');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebar = document.getElementById('sidebar');
const imagePreviewContainer = document.getElementById('image-preview-container');
const chatHistoryContainer = document.querySelector('.chat-history');

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
    activeSystemPrompt: null, // Store the actual prompt text
    userHasScrolled: false,
    lastScrollTop: 0,
    isAutoScrolling: true,
    activeBranchInfo: {}, // { parentMessageId: { activeIndex: number, totalBranches: number } } -> Derived from messages during render
    apiKeys: { // Store keys fetched from backend /config endpoint
        openrouter: null,
        google: null,
        local: null, // For local servers that might need a key (populated from local_api_key in backend config)
    }
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

// Render markdown with think block handling and LaTeX rendering
function renderMarkdown(text) {
    // Handle <think> tags only when the entire text starts with <think>
    const thinkPlaceholder = '___THINK_BLOCK___';
    let processedText = text;
    let isThinkBlock = false;

    if (processedText && processedText.trim().startsWith('<think>')) {
        const thinkBlocks = [];
        processedText = processedText.replace(/<think>([\s\S]*?)<\/think>/g, (match, content) => {
            thinkBlocks.push(content);
            return thinkPlaceholder;
        });
        isThinkBlock = true;
        // Restore <think> blocks
        thinkBlocks.forEach((content) => {
             // Ensure proper spacing around the inserted block
             processedText = processedText.replace(thinkPlaceholder, `\n<div class="think-block"><button class="think-block-toggle"><i class="bi bi-eye"></i></button><div class="think-content">${marked.parse(content)}</div>`);
        });
    }

    // Escape HTML tags outside of code blocks and think blocks
    const parts = [];
    let lastIndex = 0;
    // Match code blocks (```...```) or our specific think block structure
    const blockRegex = /(```[\s\S]*?```|<div class="think-block">[\s\S]*?<\/div>)/g;
    let match;

    while ((match = blockRegex.exec(processedText)) !== null) {
        const beforeBlock = processedText.slice(lastIndex, match.index);
        // Escape HTML in the text before the block
        parts.push(beforeBlock.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
        // Add the block itself (unescaped)
        parts.push(match[0]);
        lastIndex = blockRegex.lastIndex;
    }
    const remaining = processedText.slice(lastIndex);
    parts.push(remaining.replace(/</g, '&lt;').replace(/>/g, '&gt;'));

    processedText = parts.join('');

    // Render Markdown (now that HTML is escaped)
    let html = marked.parse(processedText);

    // Process block LaTeX ($$...$$) - Needs to run *after* markdown parsing
    // Use a regex that captures content reliably
    html = html.replace(/\$\$([\s\S]+?)\$\$/g, (match, latex) => {
        try {
            // Decode HTML entities that might have been introduced by Marked
            const decodedLatex = latex.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
            return katex.renderToString(decodedLatex.trim(), { displayMode: true, throwOnError: false });
        } catch (e) {
            console.error('KaTeX block rendering error:', e, "Input:", latex);
            return `<span class="katex-error">[Block LaTeX Error]</span>`;
        }
    });

    // Process inline LaTeX ($...$) - Careful not to match block delimiters
    // Match $ followed by non-$ characters, followed by $ not preceded by $
     html = html.replace(/(?<!\$)\$([^$\n]+?)\$(?!\$)/g, (match, latex) => {
        try {
             const decodedLatex = latex.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
            return katex.renderToString(decodedLatex.trim(), { displayMode: false, throwOnError: false });
        } catch (e) {
            console.error('KaTeX inline rendering error:', e, "Input:", latex);
            return `<span class="katex-error">[Inline LaTeX Error]</span>`;
        }
    });

    return html;
}

// handleThinkBlockToggle
function handleThinkBlockToggle(e) {
    const toggleBtn = e.target.closest('.think-block-toggle');
    if (toggleBtn) {
        const block = toggleBtn.closest('.think-block');
        const content = block.querySelector('.think-content');
        const icon = toggleBtn.querySelector('i');
        const isHidden = content.style.display === 'none';
        content.style.display = isHidden ? '' : 'none';
        icon.className = isHidden ? 'bi bi-eye' : 'bi bi-eye-slash';
    }
}

async function init() {
    // No longer load keys from storage here
    await fetchProviderConfig(); // Fetch config AND API keys
    await loadGenArgs();
    // fetchModels is now called within fetchProviderConfig after keys are set
    // await fetchModels();
    await fetchChats();
    await populateCharacterSelect();
    setupCharacterEvents();
    setupEventListeners();
    adjustTextareaHeight();
    setupDropZone();
    setupThemeSwitch();
    setupGenerationSettings();
    // No longer need setupApiKeySettings

    // Load last chat or first chat
    const lastChatId = localStorage.getItem('lastChatId');
    if (lastChatId && state.chats.some(c => c.chat_id === lastChatId)) {
        await loadChat(lastChatId);
    } else if (state.chats.length > 0 && !state.currentChatId) {
        await loadChat(state.chats[0].chat_id);
    } else {
        welcomeContainer.style.display = 'flex';
        messagesWrapper.innerHTML = '';
        state.currentChatId = null;
        highlightCurrentChatInSidebar();
        displayActiveSystemPrompt(null, null);
    }

     // Load last used character if no chat is loaded initially
     if (!state.currentChatId) {
        const savedCharacterId = localStorage.getItem('lastCharacterId');
        if (savedCharacterId) {
            document.getElementById('character-select').value = savedCharacterId;
            const characters = await fetchCharacters();
            const selectedChar = characters.find(c => c.character_id === savedCharacterId);
            displayActiveSystemPrompt(selectedChar?.character_name, selectedChar?.sysprompt);
            state.currentCharacterId = savedCharacterId;
            state.activeSystemPrompt = selectedChar?.sysprompt;
        }
     }
     applySidebarState();
}


// --- Config & Model Fetching (MODIFIED) ---

async function fetchProviderConfig() {
    try {
        const response = await fetch(`${API_BASE}/config`);
        if (!response.ok) throw new Error(`Failed to fetch config: ${response.statusText}`);
        const backendConfig = await response.json();

        // Update base URLs
        PROVIDER_CONFIG.openrouter_base_url = backendConfig.openrouter_base_url || PROVIDER_CONFIG.openrouter_base_url;
        PROVIDER_CONFIG.local_base_url = backendConfig.local_base_url || PROVIDER_CONFIG.local_base_url;

        // *** NEW: Populate state.apiKeys directly from backend config ***
        state.apiKeys.openrouter = backendConfig.openrouter || null;
        state.apiKeys.google = backendConfig.google || null;
        state.apiKeys.local = backendConfig.local_api_key || null; // Match backend key name 'local_api_key'

        console.log("Fetched provider config and populated API keys (values hidden).");

        // Re-populate model select now that keys are confirmed
        // This needs to happen *after* keys are loaded
        await fetchModels(); // Refetch models to update based on key availability

    } catch (error) {
        console.error('Error fetching provider config:', error);
        addSystemMessage("Failed to fetch API configuration from backend. Models requiring keys may be disabled.", "error");
        // Ensure model select reflects potential missing keys even on error
        populateModelSelect(); // Call even on error to show 'no models' or disable options
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

    try {
        const response = await fetch(`${API_BASE}/chat/${chatId}`);
        if (!response.ok) {
             if (response.status === 404) {
                 console.error(`Chat not found: ${chatId}. Removing.`);
                 state.chats = state.chats.filter(c => c.chat_id !== chatId);
                 renderChatList(); localStorage.removeItem('lastChatId');
                 if (state.chats.length > 0) await loadChat(state.chats[0].chat_id); else startNewChat();
             } else { throw new Error(`Failed to load chat ${chatId}: ${response.statusText}`); }
             return;
        }
        const chat = await response.json();

        state.currentChatId = chatId;
        state.messages = chat.messages || []; // *** Store fresh messages from backend ***
        state.currentCharacterId = chat.character_id;
        state.activeSystemPrompt = null;

        localStorage.setItem('lastChatId', chatId);
        document.getElementById('character-select').value = state.currentCharacterId || '';

        if (state.currentCharacterId) {
             try {
                  const charResponse = await fetch(`${API_BASE}/chat/get_character/${state.currentCharacterId}`);
                  if (charResponse.ok) {
                       const activeChar = await charResponse.json();
                       state.activeSystemPrompt = activeChar?.sysprompt || null;
                       displayActiveSystemPrompt(activeChar?.character_name, state.activeSystemPrompt);
                  } else {
                      console.warn(`Failed to fetch character ${state.currentCharacterId} details for prompt.`);
                      displayActiveSystemPrompt(null, null);
                  }
             } catch (charError) {
                 console.error("Error fetching character details:", charError);
                 displayActiveSystemPrompt(null, null);
             }
        } else {
            displayActiveSystemPrompt(null, null);
        }

        messagesWrapper.innerHTML = ''; welcomeContainer.style.display = 'none';
        renderActiveMessages(); // Render based on the freshly loaded state.messages
        highlightCurrentChatInSidebar();

    } catch (error) {
        console.error('Error loading chat:', error);
        messagesWrapper.innerHTML = `<div class="system-message error">Failed to load chat: ${error.message}</div>`;
        welcomeContainer.style.display = 'none'; state.currentChatId = null;
        highlightCurrentChatInSidebar();
    } finally {
        setTimeout(() => {
             // Autoscroll only if user hasn't interfered during load/render
             if (!state.userHasScrolled && chatContainer.scrollHeight > chatContainer.clientHeight) {
                chatContainer.scrollTop = chatContainer.scrollHeight;
             }
             state.isAutoScrolling = false; // Disable after initial scroll attempt
        }, 100); // Small delay for rendering
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
        if (msg.role === 'system') return;

        const msgNode = messageMap.get(msg.message_id);
        if (!msgNode) return;

        if (msg.parent_message_id && messageMap.has(msg.parent_message_id)) {
            messageMap.get(msg.parent_message_id).children.push(msgNode);
        } else if (!msg.parent_message_id) {
            rootMessages.push(msgNode);
        }
        // Derive branch info from backend data
         if (msg.child_message_ids && msg.child_message_ids.length > 1) {
              state.activeBranchInfo[msg.message_id] = {
                  activeIndex: msg.active_child_index ?? 0,
                  totalBranches: msg.child_message_ids.length
              };
         }
    });

     messageMap.forEach(node => {
         if (node.children.length > 0) {
             node.children.sort((a, b) => a.timestamp - b.timestamp);
              if (node.child_message_ids && node.child_message_ids.length > 1) {
                  // Update totalBranches based on actual children found in map, respecting sort
                  const mappedChildrenIds = node.children.map(c => c.message_id);
                  state.activeBranchInfo[node.message_id] = {
                      activeIndex: node.active_child_index ?? 0,
                      totalBranches: mappedChildrenIds.length // Use count of children actually present
                  };
              }
         }
     });

    rootMessages.sort((a, b) => a.timestamp - b.timestamp);

    function renderBranch(messageNode) {
        if (!messageNode || messageNode.role === 'system') return;

        addMessage(messageNode); // Render the node itself

        const children = messageNode.children.filter(c => c.role !== 'system');
        if (children && children.length > 0) {
            const activeIndex = messageNode.active_child_index ?? 0;
            const activeChildNode = children[activeIndex < children.length ? activeIndex : 0];
            if (activeChildNode) {
                renderBranch(activeChildNode);
            } else {
                 console.warn(`Active child index ${activeIndex} out of bounds for message ${messageNode.message_id} children:`, children.map(c=>c.message_id));
            }
        }
    }

    rootMessages.forEach(rootNode => renderBranch(rootNode));

    requestAnimationFrame(() => {
         messagesWrapper.querySelectorAll('pre code').forEach(block => {
            try {
                const preElement = block.parentElement;
                if (preElement && preElement.tagName === 'PRE' && !preElement.closest('.code-block-wrapper')) {
                     const codeText = block.textContent;
                     const langClass = block.className.split(' ').find(cls => cls.startsWith('language-'));
                     const lang = langClass ? langClass.substring(9) : '';
                     const wrapper = createCodeBlockWithContent(codeText, lang);
                     preElement.replaceWith(wrapper);
                } else if (preElement && preElement.closest('.code-block-wrapper')) {
                    hljs.highlightElement(block);
                }
            } catch (e) {
                 console.error("Error highlighting or wrapping code block:", e);
            }
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

// addMessage (renders single node based on provided data)
function addMessage(message) {
    if (message.role === 'system') return null;
    const role = message.role === 'llm' ? 'assistant' : message.role;
    const messageRow = document.createElement('div');
    messageRow.className = `message-row ${role}-row`;
    messageRow.dataset.messageId = message.message_id;

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';

    const avatarActionsDiv = document.createElement('div');
    avatarActionsDiv.className = 'message-avatar-actions';

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'message-actions';

    // Branch Navigation Controls (reads from state.activeBranchInfo derived in renderActiveMessages)
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

    // Standard Action Buttons
    const copyBtn = document.createElement('button');
    copyBtn.className = 'message-action-btn';
    copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>';
    copyBtn.title = 'Copy message text';
    actionsDiv.appendChild(copyBtn);

    const editBtn = document.createElement('button');
    editBtn.className = 'message-action-btn';
    editBtn.innerHTML = '<i class="bi bi-pencil"></i>';
    editBtn.title = 'Edit message';
    editBtn.addEventListener('click', () => startEditing(message.message_id));
    actionsDiv.appendChild(editBtn);

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

    // Message Content
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.dataset.raw = message.message;

    copyBtn.addEventListener('click', () => copyMessageContent(contentDiv, copyBtn));

    if (role === 'user') {
        contentDiv.textContent = message.message;
        contentDiv.style.whiteSpace = 'pre-wrap';
    } else {
        contentDiv.innerHTML = renderMarkdown(message.message);
         contentDiv.querySelectorAll('pre code').forEach(block => {
            const preElement = block.parentElement;
            if (preElement && preElement.tagName === 'PRE' && !preElement.closest('.code-block-wrapper')) {
                 const codeText = block.textContent;
                 const langClass = block.className.split(' ').find(cls => cls.startsWith('language-'));
                 const lang = langClass ? langClass.substring(9) : '';
                 const wrapper = createCodeBlockWithContent(codeText, lang);
                 preElement.replaceWith(wrapper);
            }
         });
    }

    // Attachments Display
    if (message.attachments && message.attachments.length > 0) {
        const attachmentsContainer = document.createElement('div');
        attachmentsContainer.className = 'attachments-container';

        message.attachments.forEach(attachment => {
            let rawContent = attachment.content;
            if (attachment.type === 'file') {
                 const match = attachment.content.match(/^.*:\n```[^\n]*\n([\s\S]*)\n```$/);
                 if (match && match[1]) { rawContent = match[1]; }
                 else { console.warn("Could not parse raw content from formatted file attachment:", attachment.name); }
            }

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
                fileWrapper.addEventListener('click', () => viewAttachmentPopup({...attachment, rawContent}));
                const filename = attachment.name || 'Attached File';
                fileWrapper.innerHTML = `<i class="bi bi-file-earmark-text"></i> <span>${filename}</span>`;
                attachmentsContainer.appendChild(fileWrapper);
            }
        });
        contentDiv.appendChild(attachmentsContainer);
    }

    messageDiv.appendChild(contentDiv);
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

        // *** Reload chat state from backend after successful delete ***
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

    const originalContentHTML = contentDiv.innerHTML;
    const originalActionsDisplay = actionsDiv ? actionsDiv.style.display : '';

    contentDiv.classList.add('editing');
    if (actionsDiv) actionsDiv.style.display = 'none';
    contentDiv.innerHTML = '';

    const textarea = document.createElement('textarea');
    textarea.className = 'edit-textarea';
    textarea.value = message.message;
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
        contentDiv.innerHTML = originalContentHTML;
        if (actionsDiv) actionsDiv.style.display = originalActionsDisplay;
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

    try {
        const response = await fetch(`${API_BASE}/chat/${state.currentChatId}/edit_message/${messageId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                 message: newText,
                 model_name: originalMessage.model_name, // Preserve original model
                 attachments: attachmentsForSave // Send original attachments
            })
        });
        if (!response.ok) {
             const errorData = await response.json().catch(() => ({ detail: response.statusText }));
            throw new Error(`Failed to edit message: ${errorData.detail || response.statusText}`);
        }

        // *** Reload the chat to reflect the changes accurately ***
        await loadChat(state.currentChatId);

    } catch (error) {
        console.error('Error editing message:', error);
        alert(`Failed to save changes: ${error.message}`);
    }
}

function copyMessageContent(contentDiv, buttonElement) {
    const rawText = contentDiv.dataset.raw || contentDiv.textContent;
    if (!rawText) return;

    navigator.clipboard.writeText(rawText).then(() => {
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
    messagesWrapper.addEventListener('click', handleThinkBlockToggle);
    // Settings button now opens theme modal (API key settings removed)
    document.getElementById('settings-btn').addEventListener('click', () => {
        document.getElementById('theme-modal').style.display = 'flex';
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
    messageInput.style.height = 'auto';
    let newScrollHeight = messageInput.scrollHeight;
    let newHeight = Math.max(initialTextareaHeight, newScrollHeight);
    newHeight = Math.min(newHeight, maxHeight);
    messageInput.style.height = `${newHeight}px`;
    const basePaddingBottom = 100;
    const extraPadding = Math.max(0, newHeight - initialTextareaHeight);
    chatContainer.style.paddingBottom = `${basePaddingBottom + extraPadding}px`;
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

// --- NEW: Frontend Generation Logic (MODIFIED) ---

// Helper to get API key for a provider (uses state populated by backend)
function getApiKey(provider) {
    const lowerProvider = provider.toLowerCase();
    const key = state.apiKeys[lowerProvider];
    // Allow local without key explicitly set
    if (!key && lowerProvider !== 'local') {
        console.warn(`API Key for ${provider} is missing in state.`);
        return null; // Return null if key is missing
    }
    // console.log(`Using API Key for ${provider}: ${key ? 'Present' : 'Absent (Local OK)'}`); // Debug log
    return key;
}


// Helper to format messages for different providers
function formatMessagesForProvider(messages, provider) {
    console.log(`Formatting ${messages.length} messages for provider: ${provider}`);
    const formatted = [];
    for (const msg of messages) {
        let role = msg.role; // user, llm, system
        let contentParts = [];

        // Normalize role names
        if (provider === 'google') {
            role = (role === 'llm') ? 'model' : (role === 'assistant' ? 'model' : role);
        } else {
            role = (role === 'llm') ? 'assistant' : role;
        }

        // Add text content first
        if (msg.message && msg.message.trim() !== "") {
            if (provider === 'google') {
                contentParts.push(msg.message);
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
                    if (provider === 'google') {
                        if (contentParts.length > 0 && typeof contentParts[contentParts.length - 1] === 'string') {
                            contentParts[contentParts.length - 1] += `\n${fileContent}`;
                        } else { contentParts.push(fileContent); }
                    } else {
                        const lastTextPart = contentParts.findLast(p => p.type === 'text');
                        if (lastTextPart) { lastTextPart.text += `\n${fileContent}`; }
                        else { contentParts.push({ type: "text", text: fileContent }); }
                    }
                } else { console.warn("Skipping file attachment with missing content:", attachment.name); }
            }
        }

        // Construct final message object
        if (contentParts.length > 0) {
            if (provider === 'google') {
                const finalParts = []; let currentText = "";
                contentParts.forEach(part => {
                    if (typeof part === 'string') currentText += part;
                    else if (typeof part === 'object' && part !== null) {
                        if (currentText) finalParts.push(currentText); currentText = "";
                        finalParts.push(part);
                    }
                });
                if (currentText) finalParts.push(currentText);
                if (finalParts.length > 0) { formatted.push({ role: role, parts: finalParts }); }
            } else {
                if (role === 'user' && contentParts.every(p => p.type === 'image_url') && !contentParts.some(p => p.type === 'text')) {
                    contentParts.unshift({ type: 'text', text: '[Image(s)]' });
                }
                formatted.push({ role: role, content: contentParts });
            }
        } else if (role === 'user' && msg.attachments?.length > 0) {
             if (provider === 'google') { console.warn("Skipping user message with only attachments for Google (needs text)."); }
             else {
                 contentParts.push({ type: 'text', text: '[Attachment(s)]' });
                 formatted.push({ role: role, content: contentParts });
             }
        } else { console.log(`Skipping message with no content parts (Role: ${role})`); }
    }

     // Provider specific validation/cleaning
     const cleaned = [];
     let lastRole = null;
     for (const msg of formatted) {
          if (msg.role !== 'system' && msg.role === lastRole && provider !== 'google' && msg.role !== 'model') {
              console.warn(`Skipping consecutive message with role ${msg.role} for ${provider}`); continue;
          }
          if (provider !== 'google' && Array.isArray(msg.content) && msg.content.length === 0) {
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


// Core function to handle streaming fetch to LLM providers
async function streamLLMResponse(provider, modelIdentifier, messages, genArgs, onChunk, onComplete, onError) {
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

    // --- Provider Specific Setup ---
    if (lowerProvider === 'openrouter') {
        url = `${PROVIDER_CONFIG.openrouter_base_url}/chat/completions`;
        headers['Authorization'] = `Bearer ${apiKey}`;
        headers['HTTP-Referer'] = window.location.origin; // Recommended
        headers['X-Title'] = "Zeryo Chat"; // Recommended
        body = {
            model: modelIdentifier,
            messages: formatMessagesForProvider(messages, lowerProvider),
            stream: true,
            ...filteredGenArgs // Spread filtered genArgs
        };
    } else if (lowerProvider === 'google') {
        url = `https://generativelanguage.googleapis.com/v1beta/models/${modelIdentifier}:streamGenerateContent?key=${apiKey}&alt=sse`; // Use SSE endpoint
        const formattedMsgs = formatMessagesForProvider(messages, lowerProvider);
        const generationConfig = {};
        if (filteredGenArgs.temperature !== undefined) generationConfig.temperature = filteredGenArgs.temperature;
        if (filteredGenArgs.top_p !== undefined) generationConfig.topP = filteredGenArgs.top_p;
        if (filteredGenArgs.max_tokens !== undefined) generationConfig.maxOutputTokens = filteredGenArgs.max_tokens;

        body = {
            contents: formattedMsgs,
            generationConfig: generationConfig,
            // safetySettings: [] // Add safety settings if needed
        };
    } else if (lowerProvider === 'local') {
        url = `${PROVIDER_CONFIG.local_base_url.replace(/\/$/, '')}/v1/chat/completions`;
        if (state.apiKeys.local) { // Use local key if provided
             headers['Authorization'] = `Bearer ${state.apiKeys.local}`;
        }
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
    // --- (End Provider Setup) ---


    // --- Perform Fetch ---
    state.streamController = new AbortController();
    try {
        console.log("Making fetch request to:", url);
        // console.log("Request body:", JSON.stringify(body, null, 2)); // DEBUG: Be careful logging potentially large bodies
        const response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(body),
            signal: state.streamController.signal
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => `HTTP ${response.status}`);
             let errorDetail = errorText;
             try {
                const errorJson = JSON.parse(errorText);
                errorDetail = errorJson.error?.message || errorJson.detail || JSON.stringify(errorJson.error) || errorText;
             } catch {}
            throw new Error(`API Error (${response.status}): ${errorDetail}`);
        }

        if (!response.body) {
            throw new Error("Response body is missing.");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                console.log("LLM Stream finished reading.");
                break;
            }
            if (state.streamController?.signal.aborted) {
                 console.log("Frontend stream reading aborted by AbortController.");
                 throw new Error("Aborted"); // Trigger catch block for abort handling
             }

            buffer += decoder.decode(value, { stream: true });

            // Process buffer line by line based on SSE format
            let newlineIndex;
            while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
                 const line = buffer.substring(0, newlineIndex).trim();
                 buffer = buffer.substring(newlineIndex + 1);

                 if (line.startsWith('data:')) {
                     const data = line.substring(5).trim();
                      if (data === '[DONE]') {
                           console.log("Received [DONE] marker from SSE stream.");
                      } else if (data) {
                           try {
                                const json = JSON.parse(data);
                                let content = '';
                                // --- Extract content based on provider format ---
                                if (lowerProvider === 'google') {
                                     // Google SSE format
                                     content = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
                                      if (!content && json.error) {
                                           throw new Error(`Google API Error: ${json.error.message}`);
                                      }
                                } else {
                                     // OpenAI / OpenRouter / Local format
                                     content = json.choices?.[0]?.delta?.content || '';
                                      if (!content && json.error) {
                                           throw new Error(`API Error in stream: ${json.error.message || JSON.stringify(json.error)}`);
                                      }
                                }
                                // --- ---

                                if (content) {
                                    onChunk(content);
                                }
                           } catch (e) {
                                console.warn("Failed to parse SSE data chunk:", data, e);
                           }
                      }
                 }
            }
        }
        onComplete(); // Signal normal completion

    } catch (error) {
        if (error.message === 'Aborted') {
             console.log("Stream fetch aborted.");
        } else {
             console.error(`LLM Streaming Error (${provider}):`, error);
        }
        onError(error); // Pass error (abort or other)
    } finally {
        state.streamController = null;
    }
}


// --- Send Message Flow (Frontend Generation) (MODIFIED) ---

async function sendMessage() {
    const messageText = messageInput.value.trim();
    const attachments = [
        ...state.currentImages.map(img => ({ type: 'image', content: img.base64, name: img.name })),
        ...state.currentTextFiles.map(file => ({ type: 'file', content: file.content, name: file.name })) // rawContent not needed for backend save
    ];

    if (!messageText && attachments.length === 0) return;
    if (state.streamController) { console.log("Already generating"); return; }

    const selectedOption = modelSelect.options[modelSelect.selectedIndex];
    if (!selectedOption || selectedOption.disabled) {
         alert("Please select a valid model with an available API key."); return;
    }
    const provider = selectedOption?.dataset.provider;
    if (!provider || (!getApiKey(provider) && provider.toLowerCase() !== 'local')) {
        alert(`API Key for ${provider} is missing or model invalid. Please check Settings or model selection.`); return;
    }

    // Clear input area immediately
    const currentInputText = messageInput.value; // Save in case of error
    messageInput.value = '';
    state.currentImages = []; state.currentTextFiles = [];
    imagePreviewContainer.innerHTML = ''; adjustTextareaHeight();
    welcomeContainer.style.display = 'none';

    let currentChatId = state.currentChatId;
    let savedUserMessageId = null;

    // Set loading state *before* API calls
    sendButton.disabled = true; sendButton.innerHTML = '<div class="spinner"></div>';
    messageInput.disabled = true;

    try {
        // 1. Ensure chat exists
        if (!currentChatId) {
            const response = await fetch(`${API_BASE}/chat/new_chat`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ character_id: state.currentCharacterId })
            });
            if (!response.ok) throw new Error(`Failed to create chat: ${await response.text()}`);
            const { chat_id } = await response.json();
            currentChatId = chat_id; state.currentChatId = chat_id;
            await fetchChats(); // Refresh sidebar with new chat
            localStorage.setItem('lastChatId', currentChatId);
            highlightCurrentChatInSidebar();
        }

        // 2. Save the user message
        const parentId = findLastActiveMessageId(state.messages); // Find parent from *current* local state
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

        // *** 3. Reload chat state to include the saved user message ***
        await loadChat(currentChatId); // This updates state.messages and re-renders

        // 4. Prepare for assistant generation (now using the reloaded state)
        await generateAssistantResponse(savedUserMessageId); // Pass the ID of the saved user message

    } catch (error) {
        console.error('Error sending message or preparing generation:', error);
        addSystemMessage(`Error: ${error.message}`, "error");
        // Restore input if save failed
        messageInput.value = currentInputText;
        alert("Failed to send message. Please try again.");
        // Reset UI loading state on error
        sendButton.disabled = false; sendButton.innerHTML = '<i class="bi bi-send-fill"></i>';
        messageInput.disabled = false;
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
             messageMap.get(msg.parent_message_id).children.push(msgNode);
         } else if (!msg.parent_message_id) { rootMessages.push(msgNode); }
     });
     messageMap.forEach(node => node.children.sort((a, b) => a.timestamp - b.timestamp));
     rootMessages.sort((a, b) => a.timestamp - b.timestamp);

     let lastActiveId = null;
     // Find the latest root message based on timestamp to start traversal
     let activeRoot = rootMessages.length > 0 ? rootMessages.reduce((latest, current) => (current.timestamp > latest.timestamp ? current : latest), rootMessages[0]) : null;

     function traverse(node) {
         if (!node) return;
         lastActiveId = node.message_id;
         const children = node.children; // Use the children linked in the map
         if (children && children.length > 0) {
             const activeIndex = node.active_child_index ?? 0;
             const activeChild = children[activeIndex < children.length ? activeIndex : 0];
             traverse(activeChild);
         }
     }
     traverse(activeRoot);
     // console.log("Found last active message ID:", lastActiveId); // Debug
     return lastActiveId;
}


// Function to generate the assistant's response (MODIFIED)
async function generateAssistantResponse(userMessageId) {
    if (!state.currentChatId || state.streamController) return;

    // UI Loading state (stop button, spinner already set in sendMessage)
    stopButton.style.display = 'flex';
    state.isAutoScrolling = true;
    state.userHasScrolled = false;
    const scrollHandler = createScrollHandler();
    chatContainer.addEventListener('scroll', scrollHandler);

    // Add placeholder for the assistant message visually (but not to state.messages yet)
    const tempAssistantId = `temp_assistant_${Date.now()}`;
    const placeholderRow = createPlaceholderMessageRow(tempAssistantId, userMessageId);
    messagesWrapper.appendChild(placeholderRow);
    const contentDiv = placeholderRow.querySelector('.message-content');
    if (!contentDiv) {
         console.error("Failed to find placeholder message div after rendering.");
         addSystemMessage("Internal error: Could not create message placeholder.", "error");
         // Reset UI
          sendButton.disabled = false; sendButton.innerHTML = '<i class="bi bi-send-fill"></i>';
          messageInput.disabled = false; stopButton.style.display = 'none';
          chatContainer.removeEventListener('scroll', scrollHandler);
         return;
    }

    contentDiv.classList.add('streaming');
    state.currentAssistantMessageDiv = contentDiv; // Track for UI updates
    scrollToBottom();

    // Prepare context for LLM (uses the state loaded after user message was saved)
    const context = getContextForGeneration(userMessageId, true);
    const selectedOption = modelSelect.options[modelSelect.selectedIndex];
    const modelName = selectedOption.value;
    const modelIdentifier = selectedOption.dataset.modelIdentifier;
    const provider = selectedOption.dataset.provider;

    let fullText = ''; // Accumulate response
    let savedAssistantMessageId = null; // ID from backend after saving

    try {
        await streamLLMResponse(
            provider, modelIdentifier, context, defaultGenArgs,
            // onChunk callback
            (chunk) => {
                fullText += chunk;
                contentDiv.innerHTML = renderMarkdown(fullText);
                contentDiv.dataset.raw = fullText;
                // Re-run code block wrapping/highlighting within the streaming div
                contentDiv.querySelectorAll('pre code').forEach(block => {
                    const preElement = block.parentElement;
                    if (preElement && preElement.tagName === 'PRE' && !preElement.closest('.code-block-wrapper')) {
                         const codeText = block.textContent;
                         const langClass = block.className.split(' ').find(cls => cls.startsWith('language-'));
                         const lang = langClass ? langClass.substring(9) : '';
                         const wrapper = createCodeBlockWithContent(codeText, lang);
                         preElement.replaceWith(wrapper);
                    } else if (preElement && preElement.closest('.code-block-wrapper code') && !block.classList.contains('hljs')) {
                        try { hljs.highlightElement(block); } catch(e) { console.error("Error highlighting mid-stream:", e); }
                    }
                 });

                if (!state.userHasScrolled && state.isAutoScrolling) scrollToBottom();
            },
            // onComplete callback (MODIFIED - reload state)
            async () => {
                console.log("Streaming completed. Saving assistant message.");
                contentDiv.classList.remove('streaming');
                state.currentAssistantMessageDiv = null;

                try {
                    const saveResponse = await fetch(`${API_BASE}/chat/${state.currentChatId}/add_message`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            role: 'llm', message: fullText, attachments: [],
                            parent_message_id: userMessageId, model_name: modelName
                        })
                    });
                    if (!saveResponse.ok) throw new Error(`Failed to save assistant message: ${await saveResponse.text()}`);
                    const { message_id } = await saveResponse.json();
                    savedAssistantMessageId = message_id;
                    console.log(`Assistant message saved with ID: ${savedAssistantMessageId}`);

                    // *** Reload chat state FROM BACKEND to get the final correct state ***
                    await loadChat(state.currentChatId);

                } catch (saveError) {
                    console.error("Error saving assistant message:", saveError);
                    addSystemMessage(`Error saving response: ${saveError.message}`, "error");
                    // Remove placeholder on save error
                    placeholderRow.remove();
                } finally {
                    // Final UI cleanup after successful save OR save error
                    sendButton.disabled = false; sendButton.innerHTML = '<i class="bi bi-send-fill"></i>';
                    messageInput.disabled = false; messageInput.focus();
                    stopButton.style.display = 'none'; state.isAutoScrolling = false;
                }
            },
            // onError callback (MODIFIED - check error.name)
            async (error) => {
                if (contentDiv) contentDiv.classList.remove('streaming');
                state.currentAssistantMessageDiv = null;
                console.error("Streaming error:", error); // Log the full error object

                // *** Check for AbortError ***
                if (error.name === 'AbortError') {
                    console.log("Handling aborted generation. Saving partial text:", fullText);
                    if (fullText.trim()) {
                        try {
                            const saveResponse = await fetch(`${API_BASE}/chat/${state.currentChatId}/add_message`, {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    role: 'llm', message: fullText, attachments: [],
                                    parent_message_id: userMessageId, model_name: modelName + " (incomplete)"
                                })
                             });
                             if (!saveResponse.ok) throw new Error(`Failed to save partial message: ${await saveResponse.text()}`);
                             const { message_id } = await saveResponse.json();
                             console.log(`Partial assistant message saved with ID: ${message_id}`);

                            // *** Reload chat state FROM BACKEND after partial save ***
                            await loadChat(state.currentChatId);

                        } catch (saveError) {
                             console.error("Error saving partial assistant message:", saveError);
                             addSystemMessage(`Error saving partial response: ${saveError.message}`, "error");
                             // Remove placeholder on save error
                             placeholderRow.remove();
                        }
                    } else {
                         console.log("Aborted with no text, removing placeholder.");
                         placeholderRow.remove(); // Remove empty placeholder
                    }
                    // Add a system message indicating the stop, but not as an error
                    addSystemMessage("Generation stopped by user.", "info");
                } else {
                    // Other errors (API error, network error)
                    placeholderRow.remove(); // Remove placeholder on failure
                    addSystemMessage(`Generation Error: ${error.message}`, "error"); // Show the actual error message
                }

               // Final UI cleanup after error/abort
               sendButton.disabled = false; sendButton.innerHTML = '<i class="bi bi-send-fill"></i>';
               messageInput.disabled = false; messageInput.focus();
               stopButton.style.display = 'none'; state.isAutoScrolling = false;
           }
        );
    } catch (error) { // Catch synchronous stream setup errors
         console.error("Error initiating generation stream:", error);
         addSystemMessage(`Error starting generation: ${error.message}`, "error");
         // Clean up placeholder and UI state
          placeholderRow.remove();
          sendButton.disabled = false; sendButton.innerHTML = '<i class="bi bi-send-fill"></i>';
          messageInput.disabled = false; stopButton.style.display = 'none';
          state.streamController = null; state.isAutoScrolling = false;
    } finally {
         chatContainer.removeEventListener('scroll', scrollHandler);
    }
}

// Helper to create placeholder row visually
function createPlaceholderMessageRow(tempId, parentId) {
    const messageRow = document.createElement('div');
    messageRow.className = `message-row assistant-row placeholder`; // Add placeholder class
    messageRow.dataset.messageId = tempId; // Temporary ID
    messageRow.dataset.parentId = parentId; // Store parent ref if needed

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';

    const avatarActionsDiv = document.createElement('div');
    avatarActionsDiv.className = 'message-avatar-actions'; // Container for avatar and actions

    // Placeholder for actions (can be hidden or minimal)
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'message-actions placeholder-actions'; // Specific class
    // actionsDiv.innerHTML = '<span>...</span>'; // Or leave empty

    // Message Content placeholder
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.innerHTML = '<span class="pulsing-cursor">▍</span>'; // Simple pulsing cursor

    messageDiv.appendChild(contentDiv);
    avatarActionsDiv.appendChild(actionsDiv);
    messageDiv.appendChild(avatarActionsDiv);
    messageRow.appendChild(messageDiv);
    return messageRow;
}


// --- Context Preparation ---
// Get message context for sending to LLM
function getContextForGeneration(stopAtMessageId = null, includeStopMessage = false) {
    const context = [];
    const messageMap = new Map(state.messages.map(msg => [msg.message_id, { ...msg }])); // No need for children array here
    const rootMessages = [];

    // Build tree structure and find roots
    state.messages.forEach(msg => {
        if (msg.role === 'system') return; // Skip DB system messages
        const msgNode = messageMap.get(msg.message_id);
        if (!msgNode) return;
         // Link children to parent (though not strictly needed for traversal)
         if (msg.parent_message_id && messageMap.has(msg.parent_message_id)) {
              const parent = messageMap.get(msg.parent_message_id);
              if (!parent.children) parent.children = []; // Initialize if missing
              parent.children.push(msgNode);
              parent.children.sort((a, b) => a.timestamp - b.timestamp); // Ensure order
         } else if (!msg.parent_message_id) {
            rootMessages.push(msgNode);
        }
    });
    rootMessages.sort((a, b) => a.timestamp - b.timestamp);

    // Add system prompt first if available
    if (state.activeSystemPrompt) {
        context.push({ role: 'system', message: state.activeSystemPrompt, attachments: [] });
    }

    // Traverse active branch(es) from roots
    function traverse(messageId) {
        const messageNode = messageMap.get(messageId);
        if (!messageNode || messageNode.role === 'system') return false; // Stop if null or system

        // Add current message to context if conditions met
         const shouldAdd = !stopAtMessageId || (messageNode.message_id !== stopAtMessageId || includeStopMessage);
         if (shouldAdd) {
              context.push({
                  role: messageNode.role, // llm or user
                  message: messageNode.message,
                  // Map attachments to simpler format for LLM formatting function
                  attachments: (messageNode.attachments || []).map(att => ({
                      type: att.type,
                      content: att.content, // Base64 for image, formatted text for file
                      name: att.name
                  }))
              });
         }

        // Check if we should stop traversal
        if (stopAtMessageId && messageNode.message_id === stopAtMessageId) {
             console.log("Reached stopAtMessageId:", stopAtMessageId);
             return true; // Signal to stop
        }

        // Find active child ID from the message's children_ids (fetched from backend)
        const childrenIds = messageNode.child_message_ids || [];
         // Find actual children nodes based on IDs to ensure correct timestamp sorting
         const childrenNodes = childrenIds.map(id => messageMap.get(id)).filter(Boolean);
         childrenNodes.sort((a, b) => a.timestamp - b.timestamp); // Sort nodes by timestamp

        if (childrenNodes.length > 0) {
            const activeIndex = messageNode.active_child_index ?? 0;
            const activeChildNode = childrenNodes[activeIndex < childrenNodes.length ? activeIndex : 0];
            if (activeChildNode) {
                 if (traverse(activeChildNode.message_id)) return true; // Propagate stop signal
            }
        }
        return false; // Continue traversal if not stopped
    }

    // Start traversal from each root
    for (const rootNode of rootMessages) {
        if (traverse(rootNode.message_id)) break; // Stop if signal received
    }

    // Remove leading system message if it's empty (rare case)
    if (context.length > 0 && context[0].role === 'system' && !context[0].message) {
        context.shift();
    }

    console.log(`Context prepared (${context.length} messages) up to ${stopAtMessageId || 'end'}`);
    // console.log("Context:", JSON.stringify(context, null, 2)); // DEBUG: Careful logging large context
    return context;
}


// --- Regeneration / Continuation (Frontend Orchestration) (MODIFIED) ---

async function regenerateMessage(messageId, newBranch = false) {
    if (!state.currentChatId || state.streamController) return;
    const messageToRegen = state.messages.find(m => m.message_id === messageId);
    if (!messageToRegen || messageToRegen.role !== 'llm') {
        addSystemMessage("Error: Can only regenerate assistant messages.", "error"); return;
    }
    const parentMessageId = messageToRegen.parent_message_id;
    if (!parentMessageId) {
        addSystemMessage("Error: Cannot regenerate message without a parent.", "error"); return;
    }

    console.log(`Regenerating message ${messageId} (new branch: ${newBranch})`);

    // UI Loading state
    sendButton.disabled = true; sendButton.innerHTML = '<div class="spinner"></div>';
    messageInput.disabled = true; stopButton.style.display = 'flex';
    state.isAutoScrolling = true; state.userHasScrolled = false;
    const scrollHandler = createScrollHandler();
    chatContainer.addEventListener('scroll', scrollHandler);

    const context = getContextForGeneration(parentMessageId, true); // Context up to parent

    const targetMessageRow = messagesWrapper.querySelector(`.message-row[data-message-id="${messageId}"]`);
    let contentDiv = null; // Div to update if replacing
    let tempIndicator = null; // UI indicator for branching

    if (!newBranch) { // Replacing
        contentDiv = targetMessageRow?.querySelector('.message-content');
        if (!contentDiv) {
            console.error("Cannot find content div to replace for regeneration.");
            addSystemMessage("Error: Could not find message to replace.", "error");
            // Reset UI state
            sendButton.disabled = false; sendButton.innerHTML = '<i class="bi bi-send-fill"></i>';
            messageInput.disabled = false; stopButton.style.display = 'none';
            chatContainer.removeEventListener('scroll', scrollHandler);
            return;
        }
        contentDiv.innerHTML = '<span class="pulsing-cursor">▍</span>'; // Clear and show cursor
        contentDiv.dataset.raw = ''; contentDiv.classList.add('streaming');
        state.currentAssistantMessageDiv = contentDiv;
    } else { // Branching
         tempIndicator = document.createElement('div');
         tempIndicator.className = 'system-info-row info'; tempIndicator.textContent = `Generating new branch...`;
         targetMessageRow?.insertAdjacentElement('afterend', tempIndicator);
         state.currentAssistantMessageDiv = null; // Not streaming into existing div
    }
    scrollToBottom();

    const selectedOption = modelSelect.options[modelSelect.selectedIndex];
     if (!selectedOption || selectedOption.disabled) {
          addSystemMessage("Error: Please select a valid model with an API key.", "error");
          if (tempIndicator) tempIndicator.remove();
           // Reset UI state
          sendButton.disabled = false; sendButton.innerHTML = '<i class="bi bi-send-fill"></i>';
          messageInput.disabled = false; stopButton.style.display = 'none';
          chatContainer.removeEventListener('scroll', scrollHandler);
          return;
     }
    const modelName = selectedOption.value;
    const modelIdentifier = selectedOption.dataset.modelIdentifier;
    const provider = selectedOption.dataset.provider;

    let fullText = '';

    try {
        await streamLLMResponse(
            provider, modelIdentifier, context, defaultGenArgs,
            // onChunk
            (chunk) => {
                fullText += chunk;
                if (!newBranch && contentDiv) { // Only update UI if replacing
                     contentDiv.innerHTML = renderMarkdown(fullText);
                     contentDiv.dataset.raw = fullText;
                      contentDiv.querySelectorAll('pre code').forEach(block => {
                           const preElement = block.parentElement;
                           if (preElement && preElement.tagName === 'PRE' && !preElement.closest('.code-block-wrapper')) {
                                const codeText = block.textContent;
                                const langClass = block.className.split(' ').find(cls => cls.startsWith('language-'));
                                const lang = langClass ? langClass.substring(9) : '';
                                const wrapper = createCodeBlockWithContent(codeText, lang);
                                preElement.replaceWith(wrapper);
                           } else if (preElement && preElement.closest('.code-block-wrapper code') && !block.classList.contains('hljs')) {
                                try { hljs.highlightElement(block); } catch(e) { console.error("Error highlighting mid-stream:", e); }
                           }
                       });
                     if (!state.userHasScrolled && state.isAutoScrolling) scrollToBottom();
                }
            },
            // onComplete (MODIFIED - reload state)
            async () => {
                 console.log("Regeneration streaming completed.");
                 if (!newBranch && contentDiv) contentDiv.classList.remove('streaming');
                 state.currentAssistantMessageDiv = null;
                 if (tempIndicator) tempIndicator.remove();

                 try {
                     let saveResponse;
                     if (newBranch) { // Add new message
                          saveResponse = await fetch(`${API_BASE}/chat/${state.currentChatId}/add_message`, {
                              method: 'POST', headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                  role: 'llm', message: fullText, attachments: [],
                                  parent_message_id: parentMessageId, model_name: modelName
                              })
                          });
                     } else { // Edit existing message
                          const attachmentsForSave = messageToRegen.attachments.map(({ rawContent, ...rest }) => rest);
                          saveResponse = await fetch(`${API_BASE}/chat/${state.currentChatId}/edit_message/${messageId}`, {
                              method: 'POST', headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                  message: fullText, attachments: attachmentsForSave,
                                  model_name: modelName // Update model name
                              })
                          });
                     }
                     if (!saveResponse.ok) throw new Error(`Failed to save ${newBranch ? 'new branch' : 'edited message'}: ${await saveResponse.text()}`);
                     console.log(`Regeneration ${newBranch ? 'branched' : 'edited'} and saved successfully.`);

                     // *** Reload chat state FROM BACKEND ***
                     await loadChat(state.currentChatId);

                 } catch (saveError) {
                      console.error("Error saving regeneration result:", saveError);
                      addSystemMessage(`Error saving response: ${saveError.message}`, "error");
                      // Optionally restore original content if replacing failed?
                      if (!newBranch && contentDiv) {
                          contentDiv.innerHTML = renderMarkdown(messageToRegen.message); // Restore
                          contentDiv.dataset.raw = messageToRegen.message;
                      }
                 } finally {
                      // Final UI cleanup
                      sendButton.disabled = false; sendButton.innerHTML = '<i class="bi bi-send-fill"></i>';
                      messageInput.disabled = false; messageInput.focus();
                      stopButton.style.display = 'none'; state.isAutoScrolling = false;
                 }
            },
            // onError (MODIFIED - check error.name)
            async (error) => {
                 if (!newBranch && contentDiv) contentDiv.classList.remove('streaming');
                 state.currentAssistantMessageDiv = null;
                 if (tempIndicator) tempIndicator.remove();
                 console.error("Regeneration streaming error:", error); // Log full error

                 // *** Check for AbortError ***
                 if (error.name === 'AbortError') {
                     console.log("Handling aborted regeneration. Saving partial text:", fullText);
                     if (fullText.trim()) {
                          try {
                              let saveResponse;
                              const attachmentsForSave = messageToRegen.attachments.map(({ rawContent, ...rest }) => rest);
                              if (newBranch) {
                                   saveResponse = await fetch(`${API_BASE}/chat/${state.currentChatId}/add_message`, {
                                       method: 'POST', headers: { 'Content-Type': 'application/json' },
                                       body: JSON.stringify({
                                           role: 'llm', message: fullText, attachments: [],
                                           parent_message_id: parentMessageId, model_name: modelName + " (incomplete)"
                                       })
                                   });
                              } else {
                                   saveResponse = await fetch(`${API_BASE}/chat/${state.currentChatId}/edit_message/${messageId}`, {
                                       method: 'POST', headers: { 'Content-Type': 'application/json' },
                                       body: JSON.stringify({
                                           message: fullText, attachments: attachmentsForSave,
                                           model_name: modelName + " (incomplete)"
                                       })
                                   });
                              }

                               if (!saveResponse.ok) throw new Error(`Failed to save partial: ${await saveResponse.text()}`);
                               console.log("Partial regeneration saved.");

                               // *** Reload chat state FROM BACKEND after partial save ***
                               await loadChat(state.currentChatId);

                          } catch (saveError) {
                               console.error("Error saving partial regeneration:", saveError);
                               addSystemMessage(`Error saving partial response: ${saveError.message}`, "error");
                                if (!newBranch && contentDiv) { // Restore original if save failed
                                    contentDiv.innerHTML = renderMarkdown(messageToRegen.message);
                                    contentDiv.dataset.raw = messageToRegen.message;
                                }
                          }
                     } else { // Aborted with no text
                          if (!newBranch && contentDiv) { // Restore original if replacing
                               contentDiv.innerHTML = renderMarkdown(messageToRegen.message);
                               contentDiv.dataset.raw = messageToRegen.message;
                          }
                     }
                     addSystemMessage("Regeneration stopped by user.", "info");
                 } else { // Other errors
                      if (!newBranch && contentDiv) {
                           contentDiv.innerHTML = renderMarkdown(`*Error: ${error.message}*`); // Show actual error
                           contentDiv.dataset.raw = `*Error: ${error.message}*`;
                      } else {
                           addSystemMessage(`Regeneration Error: ${error.message}`, "error");
                      }
                 }
                 // Final UI cleanup after error/abort
                 sendButton.disabled = false; sendButton.innerHTML = '<i class="bi bi-send-fill"></i>';
                 messageInput.disabled = false; messageInput.focus();
                 stopButton.style.display = 'none'; state.isAutoScrolling = false;
            }
        );
    } catch (error) { // Catch synchronous setup errors
         console.error("Error initiating regeneration stream:", error);
         addSystemMessage(`Error starting regeneration: ${error.message}`, "error");
         if (tempIndicator) tempIndicator.remove(); // Remove indicator
         // Clean up UI
         sendButton.disabled = false; sendButton.innerHTML = '<i class="bi bi-send-fill"></i>';
         messageInput.disabled = false; stopButton.style.display = 'none';
         state.streamController = null; state.isAutoScrolling = false;
          if (!newBranch && contentDiv) { // Restore original content if replacing
              contentDiv.innerHTML = renderMarkdown(messageToRegen.message);
              contentDiv.dataset.raw = messageToRegen.message;
              contentDiv.classList.remove('streaming');
          }
    } finally {
         chatContainer.removeEventListener('scroll', scrollHandler);
    }
}

async function continueMessage(messageId) {
    if (!state.currentChatId || state.streamController) return;
    const messageToContinue = state.messages.find(m => m.message_id === messageId);
    if (!messageToContinue || messageToContinue.role !== 'llm') {
        addSystemMessage("Error: Can only continue assistant messages.", "error"); return;
    }
    const parentMessageId = messageToContinue.parent_message_id;
    if (!parentMessageId) {
        addSystemMessage("Error: Cannot continue message without a parent.", "error"); return;
    }

    console.log(`Continuing message ${messageId}`);

    // UI Loading state
    sendButton.disabled = true; sendButton.innerHTML = '<div class="spinner"></div>';
    messageInput.disabled = true; stopButton.style.display = 'flex';
    state.isAutoScrolling = true; state.userHasScrolled = false;
    const scrollHandler = createScrollHandler();
    chatContainer.addEventListener('scroll', scrollHandler);

    const context = getContextForGeneration(messageId, true); // Include message itself

    const targetMessageRow = messagesWrapper.querySelector(`.message-row[data-message-id="${messageId}"]`);
    const contentDiv = targetMessageRow?.querySelector('.message-content');
    if (!contentDiv) {
         console.error("Cannot find content div to continue message.");
         addSystemMessage("Error: Could not find message to continue.", "error");
         // Reset UI
         sendButton.disabled = false; sendButton.innerHTML = '<i class="bi bi-send-fill"></i>';
         messageInput.disabled = false; stopButton.style.display = 'none';
         chatContainer.removeEventListener('scroll', scrollHandler);
         return;
    }

    let existingText = messageToContinue.message;
    let continuationText = '';
    contentDiv.classList.add('streaming');
    state.currentAssistantMessageDiv = contentDiv;
    scrollToBottom();

    const originalModelName = messageToContinue.model_name || modelSelect.value;
    const modelInfo = state.models.find(m => m.name === originalModelName) || state.models.find(m => m.name === modelSelect.value);
    if (!modelInfo || !modelInfo.provider) {
        addSystemMessage("Error: Could not determine model information for continuation.", "error");
         // Reset UI
        sendButton.disabled = false; sendButton.innerHTML = '<i class="bi bi-send-fill"></i>';
        messageInput.disabled = false; stopButton.style.display = 'none';
        chatContainer.removeEventListener('scroll', scrollHandler);
         if (contentDiv) contentDiv.classList.remove('streaming');
         state.currentAssistantMessageDiv = null;
        return;
    }
    const modelIdentifier = modelInfo.model_identifier;
    const provider = modelInfo.provider;

     if (!provider) {
          addSystemMessage("Error: Model provider not found for continuation.", "error");
          // Reset UI
          sendButton.disabled = false; sendButton.innerHTML = '<i class="bi bi-send-fill"></i>';
          messageInput.disabled = false; stopButton.style.display = 'none';
          chatContainer.removeEventListener('scroll', scrollHandler);
           if (contentDiv) contentDiv.classList.remove('streaming');
           state.currentAssistantMessageDiv = null;
          return;
     }

    try {
        await streamLLMResponse(
            provider, modelIdentifier, context, defaultGenArgs,
            // onChunk
            (chunk) => {
                continuationText += chunk;
                const fullText = existingText + continuationText;
                contentDiv.innerHTML = renderMarkdown(fullText);
                contentDiv.dataset.raw = fullText;
                contentDiv.querySelectorAll('pre code').forEach(block => {
                     const preElement = block.parentElement;
                     if (preElement && preElement.tagName === 'PRE' && !preElement.closest('.code-block-wrapper')) {
                          const codeText = block.textContent;
                          const langClass = block.className.split(' ').find(cls => cls.startsWith('language-'));
                          const lang = langClass ? langClass.substring(9) : '';
                          const wrapper = createCodeBlockWithContent(codeText, lang);
                          preElement.replaceWith(wrapper);
                     } else if (preElement && preElement.closest('.code-block-wrapper code') && !block.classList.contains('hljs')) {
                         try { hljs.highlightElement(block); } catch(e) { console.error("Error highlighting mid-stream:", e); }
                     }
                 });
                if (!state.userHasScrolled && state.isAutoScrolling) scrollToBottom();
            },
            // onComplete (MODIFIED - reload state)
            async () => {
                 console.log("Continuation streaming completed.");
                 contentDiv.classList.remove('streaming');
                 state.currentAssistantMessageDiv = null;
                 const finalFullText = existingText + continuationText;
                 try {
                      const attachmentsForSave = messageToContinue.attachments.map(({ rawContent, ...rest }) => rest);
                     const saveResponse = await fetch(`${API_BASE}/chat/${state.currentChatId}/edit_message/${messageId}`, {
                         method: 'POST', headers: { 'Content-Type': 'application/json' },
                         body: JSON.stringify({
                             message: finalFullText, attachments: attachmentsForSave,
                             model_name: originalModelName // Keep original model name unless explicitly changed
                         })
                     });
                      if (!saveResponse.ok) throw new Error(`Failed to save continued message: ${await saveResponse.text()}`);
                     console.log(`Continued message ${messageId} saved successfully.`);

                     // *** Reload chat state FROM BACKEND ***
                     await loadChat(state.currentChatId);

                 } catch (saveError) {
                      console.error("Error saving continued message:", saveError);
                      addSystemMessage(`Error saving response: ${saveError.message}`, "error");
                      contentDiv.innerHTML = renderMarkdown(finalFullText + `\n\n*[Save Error]*`);
                 } finally {
                      // Final UI cleanup
                      sendButton.disabled = false; sendButton.innerHTML = '<i class="bi bi-send-fill"></i>';
                      messageInput.disabled = false; messageInput.focus();
                      stopButton.style.display = 'none'; state.isAutoScrolling = false;
                 }
            },
            // onError (MODIFIED - check error.name)
            async (error) => {
                 contentDiv.classList.remove('streaming');
                 state.currentAssistantMessageDiv = null;
                 console.error("Continuation streaming error:", error); // Log full error
                 const finalPartialText = existingText + continuationText;

                 // *** Check for AbortError ***
                 if (error.name === 'AbortError') {
                     console.log("Handling aborted continuation. Saving partial text:", finalPartialText);
                     if (continuationText.trim()) { // Only save if something new was added
                          try {
                               const attachmentsForSave = messageToContinue.attachments.map(({ rawContent, ...rest }) => rest);
                              const saveResponse = await fetch(`${API_BASE}/chat/${state.currentChatId}/edit_message/${messageId}`, {
                                   method: 'POST', headers: { 'Content-Type': 'application/json' },
                                   body: JSON.stringify({
                                       message: finalPartialText, attachments: attachmentsForSave,
                                       model_name: originalModelName + " (incomplete)"
                                   })
                               });
                              if (!saveResponse.ok) throw new Error(`Failed to save partial continuation: ${await saveResponse.text()}`);
                              console.log("Partial continuation saved.");
                               // *** Reload chat state FROM BACKEND after partial save ***
                               await loadChat(state.currentChatId);
                          } catch (saveError) {
                               console.error("Error saving partial continuation:", saveError);
                               addSystemMessage(`Error saving partial response: ${saveError.message}`, "error");
                               contentDiv.innerHTML = renderMarkdown(finalPartialText + `\n\n*[Save Error]*`);
                          }
                     } else {
                          console.log("Aborted continuation with no new text, not saving.");
                          // Restore original text in UI
                          contentDiv.innerHTML = renderMarkdown(existingText);
                          contentDiv.dataset.raw = existingText;
                     }
                     addSystemMessage("Continuation stopped by user.", "info");
                 } else { // Other errors
                     contentDiv.innerHTML = renderMarkdown(finalPartialText + `\n\n*Error: ${error.message}*`); // Show actual error
                     contentDiv.dataset.raw = finalPartialText + `\n\n*Error: ${error.message}*`;
                 }
                 // Final UI cleanup after error/abort
                 sendButton.disabled = false; sendButton.innerHTML = '<i class="bi bi-send-fill"></i>';
                 messageInput.disabled = false; messageInput.focus();
                 stopButton.style.display = 'none'; state.isAutoScrolling = false;
            }
        );
    } catch (error) { // Catch synchronous setup errors
         console.error("Error initiating continuation stream:", error);
         addSystemMessage(`Error starting continuation: ${error.message}`, "error");
         // Clean up UI
         sendButton.disabled = false; sendButton.innerHTML = '<i class="bi bi-send-fill"></i>';
         messageInput.disabled = false; stopButton.style.display = 'none';
         state.streamController = null; state.isAutoScrolling = false;
         if (contentDiv) contentDiv.classList.remove('streaming');
         state.currentAssistantMessageDiv = null;
    } finally {
         chatContainer.removeEventListener('scroll', scrollHandler);
    }
}

// Stop Streaming (Frontend Abort)
function stopStreaming() {
    if (state.streamController && !state.streamController.signal.aborted) {
        console.log("User requested stop. Aborting frontend fetch...");
        state.streamController.abort();
        stopButton.style.display = 'none';
        if (state.currentAssistantMessageDiv) {
             state.currentAssistantMessageDiv.classList.remove('streaming');
             // The onError handler now manages saving partial/showing stopped state
             state.currentAssistantMessageDiv = null;
        }
    } else { console.log("No active frontend stream to stop or already aborted."); }
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

    // Update edit/delete buttons based on selection
    const selectedId = select.value;
    document.getElementById('character-edit-btn').disabled = !selectedId;
    document.getElementById('character-delete-btn').disabled = !selectedId;
}

function displayActiveSystemPrompt(characterName, promptText) {
    const mainContent = document.querySelector('.main-content');
    let activePromptDisplay = document.getElementById('active-system-prompt');
    const chatContainerElement = document.getElementById('chat-container');

    // If no prompt text, remove the display if it exists
    if (!promptText) {
        if (activePromptDisplay) activePromptDisplay.remove();
        if(chatContainerElement) chatContainerElement.style.paddingTop = '0'; // Reset padding
        return;
    }

    // Create or update the display element
    if (!activePromptDisplay) {
        activePromptDisplay = document.createElement('div');
        activePromptDisplay.id = 'active-system-prompt';
        // Apply styles directly
        activePromptDisplay.style.cssText = `
            background: var(--message-user);
            padding: 16px 40px;
            position: sticky;
            cursor: pointer;
            overflow: hidden;
            max-height: 64px;
            transition: max-height 0.3s ease-in-out;
        `;

        activePromptDisplay.addEventListener('click', () => {
            const isCollapsed = activePromptDisplay.classList.toggle('collapsed');
            const icon = activePromptDisplay.querySelector('.expand-icon i');
            const promptContent = activePromptDisplay.querySelector('.system-prompt-content');

            if (isCollapsed) {
                activePromptDisplay.style.maxHeight = '64px'; // Collapsed height
                if (icon) icon.className = 'bi bi-chevron-down';
                if (promptContent) promptContent.style.display = 'none';
            } else {
                activePromptDisplay.style.maxHeight = '300px'; // Expanded height limit
                if (icon) icon.className = 'bi bi-chevron-up';
                if (promptContent) promptContent.style.display = 'block';
            }
        });

            // Insert it right after the header
            const headerElement = document.querySelector('.header');
            if (mainContent && headerElement) {
            headerElement.after(activePromptDisplay);
            }
    }

    // Update content
    activePromptDisplay.innerHTML = `
         <div style="display: flex; align-items: center; height: 30px; padding-left: 32px;">
            <span class="expand-icon" style="color: var(--text-secondary);"><i class="bi bi-chevron-down"></i></span>
            <span style="font-weight: 500; color: var(--text-secondary); font-size: 0.9em; padding-left: 4px;">
                Active Prompt: ${characterName || 'Unknown Character'}
            </span>
         </div>
         <pre class="system-prompt-content" style="white-space: pre-wrap; margin-top: 5px; padding: 10px; background-color: var(--bg-primary); border-radius: var(--border-radius-md); border: 1px solid var(--border-color); font-size: 0.85em; max-height: 250px; overflow-y: auto; display: none;">${promptText}</pre>
     `;

     // Ensure it's collapsed initially after update/creation
     activePromptDisplay.classList.add('collapsed');
     activePromptDisplay.style.maxHeight = '64px'; // Reset max-height
     const promptContent = activePromptDisplay.querySelector('.system-prompt-content');
     if (promptContent) promptContent.style.display = 'none';
     const icon = activePromptDisplay.querySelector('.expand-icon i');
     if (icon) icon.className = 'bi bi-chevron-down';
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
        characterEditBtn.disabled = !selectedCharacterId;
        characterDeleteBtn.disabled = !selectedCharacterId;

        // Fetch character details to get prompt text
         let activeChar = null;
         if (selectedCharacterId) {
              try {
                  const charResponse = await fetch(`${API_BASE}/chat/get_character/${selectedCharacterId}`);
                   if (charResponse.ok) activeChar = await charResponse.json();
              } catch (e) { console.error("Failed to fetch selected character details", e); }
         }
         state.currentCharacterId = selectedCharacterId;
         state.activeSystemPrompt = activeChar?.sysprompt || null; // Update prompt state

         // Update prompt display banner immediately
         displayActiveSystemPrompt(activeChar?.character_name, state.activeSystemPrompt);

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
                // Revert selection? Needs previous state.
                // characterSelect.value = state.currentCharacterId || ''; // This might be wrong if state didn't update
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
                     displayActiveSystemPrompt(null, null); // Clear banner
                      if (state.currentChatId) { // Update chat if one is loaded
                          await fetch(`${API_BASE}/chat/${state.currentChatId}/set_active_character`, {
                               method: 'POST', headers: { 'Content-Type': 'application/json' },
                               body: JSON.stringify({ character_id: null })
                          });
                      }
                 }
                 // Refresh the dropdown list
                 await populateCharacterSelect();

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

             // Update prompt display if the active character was edited, or select new one
              if (mode === 'edit' && state.currentCharacterId === outcomeCharacterId) {
                   state.activeSystemPrompt = sysprompt; // Update state directly
                   displayActiveSystemPrompt(name, sysprompt); // Update banner
              } else if (mode === 'create' && outcomeCharacterId) {
                  // Select the newly created character
                   characterSelect.value = outcomeCharacterId;
                   // Manually trigger the change handler logic (which updates state and backend if chat loaded)
                   await characterSelect.dispatchEvent(new Event('change')); // Trigger change event
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


// --- Chat Actions ---

function startNewChat() {
    console.log("Starting new chat...");
    if (state.streamController) {
         alert("Please wait for the current response to finish or stop it first."); return;
    }
    state.currentChatId = null; state.messages = [];
    messagesWrapper.innerHTML = ''; welcomeContainer.style.display = 'flex';
    localStorage.removeItem('lastChatId'); highlightCurrentChatInSidebar();
    messageInput.focus();
    const selectedCharacterId = document.getElementById('character-select').value || null;
    state.currentCharacterId = selectedCharacterId;
    if (selectedCharacterId) {
         fetchCharacters().then(characters => { // TODO: Cache characters
             const selectedChar = characters.find(c => c.character_id === selectedCharacterId);
             state.activeSystemPrompt = selectedChar?.sysprompt;
             displayActiveSystemPrompt(selectedChar?.character_name, state.activeSystemPrompt);
         });
     } else {
         state.activeSystemPrompt = null; displayActiveSystemPrompt(null, null);
     }
    state.currentImages = []; state.currentTextFiles = [];
    imagePreviewContainer.innerHTML = ''; adjustTextareaHeight();
}

async function deleteCurrentChat() {
    if (!state.currentChatId) { alert("No chat selected to delete."); return; }
     if (state.streamController) { alert("Please wait for the current response to finish or stop it before deleting."); return; }
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
    // const settingsBtn = document.getElementById('settings-btn'); // Setup in setupEventListeners
    const themeModal = document.getElementById('theme-modal');
    // Define themes
    const themes = {
        white: {
            '--bg-primary': '#ffffff', '--bg-secondary': '#f7f7f7', '--bg-tertiary': '#f0f0f0',
            '--text-primary': '#1f2328', '--text-secondary': '#57606a', '--accent-color': '#101010',
            '--accent-hover': '#1f2328', '--accent-color-highlight': '#1f2328', '--error-color': '#d73a49',
            '--message-user': '#f0f0f0', '--message-assistant': '#ffffff', '--scrollbar-bg': '#f0f0f0',
            '--scrollbar-thumb': '#cccccc', '--border-color': '#d0d7de',
        },
        solarized: {
            '--bg-primary': '#fdf6e3', '--bg-secondary': '#eee8d5', '--bg-tertiary': '#e8e1cf',
            '--text-primary': '#657b83', '--text-secondary': '#839496', '--accent-color': '#d4c4a8',
            '--accent-hover': '#657b83', '--accent-color-highlight': '#657b83', '--error-color': '#dc322f',
            '--message-user': '#eee8d5', '--message-assistant': '#fdf6e3', '--scrollbar-bg': '#eee8d5',
            '--scrollbar-thumb': '#93a1a1', '--border-color': '#d9cfb3',
        },
        dark: {
            '--bg-primary': '#121212', '--bg-secondary': '#1a1a1a', '--bg-tertiary': '#101010',
            '--text-primary': '#e0e0e0', '--text-secondary': '#a0a0a0', '--accent-color': '#2c2c2c',
            '--accent-hover': '#1a1a1a', '--accent-color-highlight': '#e0e0e0', '--error-color': '#cf6679',
            '--message-user': '#1e1e1e', '--message-assistant': '#1a1a1a', '--scrollbar-bg': '#1a1a1a',
            '--scrollbar-thumb': '#424242', '--border-color': '#333333',
        }
    };

    function applyTheme(themeName) {
         const theme = themes[themeName] || themes.dark; // Default to dark
         const customStyle = document.createElement('style'); // For dynamic background

         Object.entries(theme).forEach(([prop, value]) => {
             document.documentElement.style.setProperty(prop, value);
         });

         // Update highlight.js theme
         const highlightThemeLink = document.getElementById('highlight-theme');
         if (themeName === 'white') {
             highlightThemeLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css';
         } else if (themeName === 'solarized') {
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
          dynamicStyle.textContent = `
          pre code.hljs {
              background: var(--bg-tertiary) !important;
          }
          .code-block-wrapper { /* Ensure wrapper also gets background */
              background: var(--bg-tertiary) !important;
          }
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
    // Settings button click listener added in setupEventListeners

    // Listener for theme option buttons
    document.querySelectorAll('.theme-option[data-theme]').forEach(button => {
        button.addEventListener('click', () => { applyTheme(button.dataset.theme); });
    });

    // Close modal on background click
    themeModal.addEventListener('click', (e) => { if (e.target === themeModal) themeModal.style.display = 'none'; });

    // Apply saved theme on initial load
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
        // Read values from UI and update defaultGenArgs
        defaultGenArgs.temperature = document.getElementById('temp-none').checked ? null : parseFloat(document.getElementById('temp-slider').value);
        defaultGenArgs.min_p = document.getElementById('minp-none').checked ? null : parseFloat(document.getElementById('minp-slider').value);
        defaultGenArgs.max_tokens = document.getElementById('maxt-none').checked ? null : parseInt(document.getElementById('maxt-slider').value);
        // Add top_p if slider exists
        const topPSlider = document.getElementById('topp-slider'); // Assuming it might exist
        if (topPSlider) {
             defaultGenArgs.top_p = document.getElementById('topp-none').checked ? null : parseFloat(topPSlider.value);
        } else {
             defaultGenArgs.top_p = null; // Ensure it's null if slider doesn't exist
        }

        localStorage.setItem('genArgs', JSON.stringify(defaultGenArgs));
        modal.style.display = 'none';
    });
    cancelBtn.addEventListener('click', () => modal.style.display = 'none');
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });

    const settingsConfig = [
        { prefix: 'temp', defaultVal: 0.7, stateKey: 'temperature' },
        { prefix: 'minp', defaultVal: 0.05, stateKey: 'min_p' },
        { prefix: 'maxt', defaultVal: 1024, stateKey: 'max_tokens' },
        // { prefix: 'topp', defaultVal: 0.9, stateKey: 'top_p' }, // Uncomment if top_p slider added
    ];
    settingsConfig.forEach(({ prefix, defaultVal, stateKey }) => {
        const slider = document.getElementById(`${prefix}-slider`);
        const valueSpan = document.getElementById(`${prefix}-value`);
        const noneCheckbox = document.getElementById(`${prefix}-none`);

        if (!slider || !valueSpan || !noneCheckbox) return; // Skip if elements don't exist

        slider.addEventListener('input', () => {
            valueSpan.textContent = slider.value;
            if (noneCheckbox.checked) {
                 noneCheckbox.checked = false; // Uncheck 'None' if slider is moved
                 slider.disabled = false;
            }
        });

        noneCheckbox.addEventListener('change', () => {
            slider.disabled = noneCheckbox.checked;
            valueSpan.textContent = noneCheckbox.checked ? 'None' : slider.value;
            if (noneCheckbox.checked) {
                 // Optional: Reset slider to default when 'None' is checked?
                 // slider.value = defaultVal;
            }
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
            if (isNone) {
                 valueSpan.textContent = 'None';
                 // Keep slider value or reset to default? Keep current value.
                 // slider.value = slider.defaultValue;
            } else {
                 slider.value = currentValue;
                 valueSpan.textContent = currentValue;
            }
        });
    }
    updateSlidersUI(); // Initial UI update
}

// --- Utilities ---
function addSystemMessage(text, type = "info") { // type can be 'info', 'error', 'warning'
     console.log(`System Message [${type}]: ${text}`);
     const messageRow = document.createElement('div');
     messageRow.className = `system-info-row ${type}`; // Use distinct classes
     messageRow.style.cssText = `
        padding: 8px 20px; margin: 5px auto; max-width: 800px;
        border-radius: var(--border-radius-md);
        background-color: ${type === 'error' ? 'rgba(229, 62, 62, 0.2)' : 'color-mix(in srgb, var(--text-secondary) 10%, transparent)'};
        color: ${type === 'error' ? 'var(--error-color)' : 'var(--text-secondary)'};
        border: 1px solid ${type === 'error' ? 'var(--error-color)' : 'var(--border-color)'};
        font-size: 0.9em; display: flex; align-items: center; gap: 8px;
     `;

     const iconClass = type === 'error' ? 'exclamation-octagon-fill' : (type === 'warning' ? 'exclamation-triangle-fill' : 'info-circle-fill');
     messageRow.innerHTML = `<i class="bi bi-${iconClass}"></i> <span>${text}</span>`; // Wrap text in span

     messagesWrapper.appendChild(messageRow);
     scrollToBottom(); // Scroll to show the message
}

// Scroll Utility
function scrollToBottom(behavior = 'auto') { // 'smooth' or 'auto'
     requestAnimationFrame(() => {
         if (chatContainer) {
             chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: behavior });
         }
     });
}

// Start the Application
document.addEventListener('DOMContentLoaded', init);