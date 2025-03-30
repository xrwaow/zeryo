// script.js

// API Configuration
const API_BASE = 'http://localhost:8000';

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
const clearChatBtn = document.getElementById('clear-chat-btn'); // Will be repurposed to delete chat
const newChatBtn = document.getElementById('new-chat-btn');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebar = document.getElementById('sidebar');
const imagePreviewContainer = document.getElementById('image-preview-container');
const chatHistoryContainer = document.querySelector('.chat-history');

// State Management
const state = {
    currentChatId: null,
    chats: [], // List of {chat_id, preview, timestamp_updated}
    messages: [], // All messages for the current chat
    models: [],
    currentImages: [],
    currentTextFiles: [],
    streamController: null,
    currentAssistantMessageDiv: null, // The div being actively streamed into
    currentCharacterId: null,
    userHasScrolled: false,
    lastScrollTop: 0,
    isAutoScrolling: true, // Start true for initial load scroll
    activeBranchInfo: {}, // { parentMessageId: { activeIndex: number, totalBranches: number } } -> Derived from messages
    generationContext: null, // Tracks the type and relevant IDs of the ongoing generation
};

// Default generation arguments
const defaultGenArgs = {
    temperature: 0.7,
    min_p: 0.05,
    max_tokens: null, // Let model decide by default
    top_p: null, // Add top_p, default to null
};

// Configure marked for markdown parsing
marked.setOptions({
    breaks: true,
    gfm: true,
    headerIds: false,
    highlight: function(code, lang) {
        const language = hljs.getLanguage(lang) ? lang : 'plaintext';
        try {
            // Ensure code is a string
            const codeString = String(code);
            return hljs.highlight(codeString, { language, ignoreIllegals: true }).value;
        } catch (error) {
            console.error("Highlighting error:", error);
            // Ensure code is a string for fallback
            const codeString = String(code);
            return hljs.highlightAuto(codeString).value; // Fallback
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

// handleThinkBlockToggle remains unchanged
function handleThinkBlockToggle(e) {
    const toggleBtn = e.target.closest('.think-block-toggle');
    if (toggleBtn) {
        const block = toggleBtn.closest('.think-block');
        const content = block.querySelector('.think-content');
        const icon = toggleBtn.querySelector('i');
        // Use visibility/height for smoother transition if CSS is set up for it
        const isHidden = content.style.display === 'none';
        content.style.display = isHidden ? '' : 'none'; // Toggle visibility
        icon.className = isHidden ? 'bi bi-eye' : 'bi bi-eye-slash';
        // Or use a class toggle if preferred: block.classList.toggle('collapsed');
    }
}

async function init() {
    const savedGenArgs = localStorage.getItem('genArgs');
    if (savedGenArgs) {
        try {
             Object.assign(defaultGenArgs, JSON.parse(savedGenArgs));
        } catch { /* ignore parse error, use defaults */ }
    }
    // Ensure all expected keys exist after loading
    defaultGenArgs.temperature = defaultGenArgs.temperature ?? 0.7;
    defaultGenArgs.min_p = defaultGenArgs.min_p ?? 0.05;
    defaultGenArgs.max_tokens = defaultGenArgs.max_tokens ?? null;
    defaultGenArgs.top_p = defaultGenArgs.top_p ?? null;


    await fetchModels();
    await fetchChats(); // Fetches list and loads the first chat if available
    await populateCharacterSelect();
    setupCharacterEvents();
    setupEventListeners();
    adjustTextareaHeight();
    setupDropZone();
    setupThemeSwitch();
    setupInlineCodeCopy();
    setupGenerationSettings(); // Setup after loading saved args

    // Attempt to load last chat
    const lastChatId = localStorage.getItem('lastChatId');
    if (lastChatId && state.chats.some(c => c.chat_id === lastChatId)) {
        await loadChat(lastChatId);
    } else if (state.chats.length > 0 && !state.currentChatId) {
        // If no last chat or it's invalid, load the most recent one
        await loadChat(state.chats[0].chat_id);
    } else {
        // No chats exist, ensure welcome screen is shown
        welcomeContainer.style.display = 'flex';
        messagesWrapper.innerHTML = ''; // Clear any potential residue
        state.currentChatId = null;
        highlightCurrentChatInSidebar(); // Clear selection
        displayActiveSystemPrompt(null); // Ensure no prompt shown
    }

     // Load last used character if no chat is loaded initially
     if (!state.currentChatId) {
        const savedCharacterId = localStorage.getItem('lastCharacterId');
        if (savedCharacterId) {
            document.getElementById('character-select').value = savedCharacterId;
            // Fetch characters if needed to display prompt?
            const characters = await fetchCharacters();
            displayActiveSystemPrompt(savedCharacterId, characters);
            state.currentCharacterId = savedCharacterId; // Set state for new chat
        }
     }
     applySidebarState(); // Apply sidebar state after other initializations
}

function setupGenerationSettings() {
    const genSettingsBtn = document.getElementById('gen-settings-btn');
    const modal = document.getElementById('gen-settings-modal');
    const applyBtn = document.getElementById('apply-gen-settings');
    const cancelBtn = document.getElementById('cancel-gen-settings');

    genSettingsBtn.addEventListener('click', () => {
        updateSlidersUI(); // Update UI with current values when opening
        modal.style.display = 'flex';
    });

    applyBtn.addEventListener('click', () => {
        // Read values from UI and update defaultGenArgs
        defaultGenArgs.temperature = document.getElementById('temp-none').checked ? null : parseFloat(document.getElementById('temp-slider').value);
        defaultGenArgs.min_p = document.getElementById('minp-none').checked ? null : parseFloat(document.getElementById('minp-slider').value);
        defaultGenArgs.max_tokens = document.getElementById('maxt-none').checked ? null : parseInt(document.getElementById('maxt-slider').value);
        // Add top_p if slider exists
        const topPSlider = document.getElementById('topp-slider');
        if (topPSlider) {
             defaultGenArgs.top_p = document.getElementById('topp-none').checked ? null : parseFloat(topPSlider.value);
        }

        localStorage.setItem('genArgs', JSON.stringify(defaultGenArgs));
        modal.style.display = 'none';
    });

    cancelBtn.addEventListener('click', () => modal.style.display = 'none');

    // Setup sliders and checkboxes
    const settingsConfig = [
        { prefix: 'temp', defaultVal: 0.7 },
        { prefix: 'minp', defaultVal: 0.05 },
        { prefix: 'maxt', defaultVal: 1024 }, // Default for UI if null
        // Add top_p if the HTML includes elements with 'topp-' prefix
        // { prefix: 'topp', defaultVal: 0.9 },
    ];

    settingsConfig.forEach(({ prefix, defaultVal }) => {
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


    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.style.display = 'none';
    });

    // Function to set slider values based on current defaultGenArgs
    function updateSlidersUI() {
        settingsConfig.forEach(({ prefix }) => {
             const slider = document.getElementById(`${prefix}-slider`);
             const valueSpan = document.getElementById(`${prefix}-value`);
             const noneCheckbox = document.getElementById(`${prefix}-none`);

             if (!slider || !valueSpan || !noneCheckbox) return;

             // Adjust key for lookup if needed (e.g., 'maxt' vs 'max_tokens')
             const stateKey = prefix === 'maxt' ? 'max_tokens' : prefix;
             const currentValue = defaultGenArgs[stateKey];

            const isNone = currentValue === null || currentValue === undefined;

            noneCheckbox.checked = isNone;
            slider.disabled = isNone;
            if (isNone) {
                 valueSpan.textContent = 'None';
                 // Keep slider value or reset to default? Let's keep it.
                 // slider.value = slider.defaultValue; // Or the specific defaultVal
            } else {
                 slider.value = currentValue;
                 valueSpan.textContent = currentValue;
            }
        });
    }
}

// Fetch Available Models
async function fetchModels() {
    try {
        const response = await fetch(`${API_BASE}/models`);
        if (!response.ok) throw new Error(`Failed to fetch models: ${response.statusText}`);
        state.models = await response.json();
        // Sort models alphabetically by displayName?
        state.models.sort((a, b) => a.displayName.localeCompare(b.displayName));
        populateModelSelect();
    } catch (error) {
        console.error('Error fetching models:', error);
        state.models = []; // Ensure it's an empty array on error
        // Display error to user?
    }
}

function populateModelSelect() {
    modelSelect.innerHTML = ''; // Clear existing options
    if (state.models.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No models available';
        option.disabled = true;
        modelSelect.appendChild(option);
    } else {
        state.models.forEach(model => {
            const option = document.createElement('option');
            option.value = model.name; // Use the 'name' field as the value
            option.textContent = model.displayName;
            option.dataset.supportsImages = model.supportsImages; // Store image support flag
            option.dataset.provider = model.provider; // Store provider info
            modelSelect.appendChild(option);
        });
         // Try to restore last selected model
        const lastModel = localStorage.getItem('lastModelName');
        if (lastModel && state.models.some(m => m.name === lastModel)) {
            modelSelect.value = lastModel;
        }
    }
    updateAttachButtons(); // Update buttons based on initially selected model
}

// Fetch Chat List
async function fetchChats() {
    try {
        const response = await fetch(`${API_BASE}/chat/get_chats?limit=100`); // Fetch more chats
        if (!response.ok) throw new Error(`Failed to fetch chats: ${response.statusText}`);
        state.chats = await response.json();
        renderChatList(); // Render the fetched list
        // Don't automatically load chat here, let init decide based on lastChatId or first item
    } catch (error) {
        console.error('Error fetching chats:', error);
        state.chats = [];
        renderChatList(); // Render empty list or error state
    }
}

function renderChatList() {
    // Clear only the items, keep the title structure
    const historyItems = chatHistoryContainer.querySelectorAll('.history-item');
    historyItems.forEach(item => item.remove());

    const historyTitle = chatHistoryContainer.querySelector('.history-title'); // Assuming this exists

    if (state.chats.length === 0) {
        if (historyTitle) historyTitle.textContent = 'No Recent Conversations';
        // Optional: Add a placeholder message
        const noChatsMsg = document.createElement('div');
        noChatsMsg.className = 'history-item dimmed'; // Dimmed class for styling
        noChatsMsg.textContent = 'Start a new chat!';
        chatHistoryContainer.appendChild(noChatsMsg);
        return;
    }

    if (historyTitle) historyTitle.textContent = 'Recent Conversations';

    state.chats.forEach(chat => {
        const item = document.createElement('div');
        item.className = 'history-item';
        item.dataset.chatId = chat.chat_id; // Store chat ID on the element

        // Simple structure: icon + text preview
        const icon = document.createElement('i');
        icon.className = 'bi bi-chat';
        const text = document.createElement('span');
        text.textContent = chat.preview || `Chat ${chat.chat_id.substring(0, 6)}`; // Use preview or short ID

        item.appendChild(icon);
        item.appendChild(text);

        item.addEventListener('click', () => {
             if (state.currentChatId !== chat.chat_id) { // Avoid reloading same chat
                 loadChat(chat.chat_id);
             }
        });

        // Highlight if it's the current chat
        if (chat.chat_id === state.currentChatId) {
             item.classList.add('active'); // Use a class for styling active item
        }

        chatHistoryContainer.appendChild(item);
    });

    // Ensure sidebar text visibility matches collapsed state
    const isCollapsed = sidebar.classList.contains('sidebar-collapsed');
    chatHistoryContainer.querySelectorAll('.history-item span, .history-title').forEach(el => {
         el.style.display = isCollapsed ? 'none' : '';
    });
}


// Highlight Current Chat in Sidebar (using the class)
function highlightCurrentChatInSidebar() {
    const chatItems = chatHistoryContainer.querySelectorAll('.history-item');
    chatItems.forEach(item => {
        if (item.dataset.chatId === state.currentChatId) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });
}


// Load a Chat
async function loadChat(chatId) {
    if (!chatId) {
         console.warn("loadChat called with null chatId");
         startNewChat(); // Go to new chat state if ID is invalid
         return;
    }
    console.log(`Loading chat: ${chatId}`);
    state.isAutoScrolling = true; // Enable autoscroll during load
    state.userHasScrolled = false; // Reset scroll state

    try {
        const response = await fetch(`${API_BASE}/chat/${chatId}`);
        if (!response.ok) {
             if (response.status === 404) {
                 console.error(`Chat not found: ${chatId}. Removing from list and local storage.`);
                 // Remove from state.chats and rerender list
                 state.chats = state.chats.filter(c => c.chat_id !== chatId);
                 renderChatList();
                 localStorage.removeItem('lastChatId');
                 // Load the next available chat or start new
                 if (state.chats.length > 0) {
                     await loadChat(state.chats[0].chat_id);
                 } else {
                     startNewChat();
                 }
             } else {
                throw new Error(`Failed to load chat ${chatId}: ${response.statusText}`);
             }
             return; // Stop execution if chat failed to load
        }
        const chat = await response.json();

        state.currentChatId = chatId;
        // Filter out any system messages from the backend before storing
        state.messages = (chat.messages || []).filter(m => m.role !== 'system');
        state.currentCharacterId = chat.character_id;

        localStorage.setItem('lastChatId', chatId); // Save successfully loaded chat ID

        // Update character select dropdown
        document.getElementById('character-select').value = state.currentCharacterId || '';

        // Clear previous messages and render new ones
        messagesWrapper.innerHTML = '';
        welcomeContainer.style.display = 'none'; // Hide welcome message
        renderActiveMessages(); // Render the active branch

        highlightCurrentChatInSidebar(); // Update sidebar highlighting

        // Fetch characters to display the correct system prompt banner
        const characters = await fetchCharacters();
        displayActiveSystemPrompt(state.currentCharacterId, characters);

    } catch (error) {
        console.error('Error loading chat:', error);
        // Show error to user? Revert to welcome screen?
        messagesWrapper.innerHTML = `<div class="system-message error">Failed to load chat: ${error.message}</div>`;
        welcomeContainer.style.display = 'none';
        state.currentChatId = null;
        highlightCurrentChatInSidebar();
    } finally {
         // Scroll to bottom after rendering (use timeout for safety)
        setTimeout(() => {
             if (state.isAutoScrolling) {
                chatContainer.scrollTop = chatContainer.scrollHeight;
             }
             state.isAutoScrolling = false; // Disable autoscroll after initial load
        }, 100);
    }
}

// Renders only the messages on the active branch
function renderActiveMessages() {
    messagesWrapper.innerHTML = ''; // Clear existing messages
    state.activeBranchInfo = {}; // Reset derived branch info

    if (!state.messages || state.messages.length === 0) {
        console.log("No messages to render.");
        return;
    }

    // 1. Build Parent-Child Map and Branch Info
    const messageMap = new Map(state.messages.map(msg => [msg.message_id, { ...msg, children: [] }]));
    const rootMessages = [];

    state.messages.forEach(msg => {
        if (msg.role === 'system') return; // Skip system messages for rendering tree

        const msgNode = messageMap.get(msg.message_id);
        if (!msgNode) return; // Skip if message somehow not in map

        if (msg.parent_message_id && messageMap.has(msg.parent_message_id)) {
            messageMap.get(msg.parent_message_id).children.push(msgNode);
        } else if (!msg.parent_message_id) {
            rootMessages.push(msgNode);
        }
        // Store branch info while iterating
         if (msg.child_message_ids && msg.child_message_ids.length > 1) {
              state.activeBranchInfo[msg.message_id] = {
                  activeIndex: msg.active_child_index ?? 0,
                  totalBranches: msg.child_message_ids.length
              };
         }
    });

     // Sort children by timestamp just in case API didn't guarantee order
     messageMap.forEach(node => {
         if (node.children.length > 0) {
             node.children.sort((a, b) => a.timestamp - b.timestamp);
             // Update activeBranchInfo with sorted children count if it differs
              if (node.child_message_ids && node.child_message_ids.length > 1) {
                  state.activeBranchInfo[node.message_id] = {
                      activeIndex: node.active_child_index ?? 0,
                      totalBranches: node.children.length // Use actual children count
                  };
              }
         }
     });

    // Sort root messages by timestamp
    rootMessages.sort((a, b) => a.timestamp - b.timestamp);

    // 2. Traverse and Render Active Path(s)
    function renderBranch(messageNode) {
        if (!messageNode || messageNode.role === 'system') return; // Skip null or system nodes

        // Render the current message node
        const contentDiv = addMessage(messageNode); // addMessage handles rendering the node itself

        // Find the active child and recurse
        const children = messageNode.children.filter(c => c.role !== 'system'); // Filter out system children if any sneak in
        if (children && children.length > 0) {
            const activeIndex = messageNode.active_child_index ?? 0;
            const activeChildNode = children[activeIndex < children.length ? activeIndex : 0]; // Fallback to 0
            if (activeChildNode) {
                renderBranch(activeChildNode);
            } else {
                 console.warn(`Active child index ${activeIndex} out of bounds for message ${messageNode.message_id}`);
            }
        }
    }

    // Start rendering from each root message
    rootMessages.forEach(rootNode => renderBranch(rootNode));

    // 3. Highlight code blocks after rendering
    requestAnimationFrame(() => {
         messagesWrapper.querySelectorAll('pre code').forEach(block => {
            try {
                // Ensure parentElement exists before replacement
                const preElement = block.parentElement;
                if (preElement && preElement.tagName === 'PRE' && !preElement.closest('.code-block-wrapper')) {
                     const codeText = block.textContent;
                     const langClass = block.className.split(' ').find(cls => cls.startsWith('language-'));
                     const lang = langClass ? langClass.substring(9) : '';

                     // Use the createCodeBlock helper with TEXT content
                     const wrapper = createCodeBlockWithContent(codeText, lang);
                     preElement.replaceWith(wrapper);
                } else if (preElement && preElement.closest('.code-block-wrapper')) {
                    // Already wrapped, just re-highlight
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
            // Calculate lines only when collapsing
            const lines = newCode.textContent.split('\n').length;
            // Handle potential trailing newline: if last line is empty, subtract 1
            const lineCount = newCode.textContent.endsWith('\n') ? lines - 1 : lines;
            collapseInfoSpan.textContent = `${lineCount} lines hidden`;
            collapseInfoSpan.style.display = 'inline-block'; // Show info
             newPre.style.display = 'none'; // Explicitly hide pre (CSS might do this too)
        } else {
            icon.className = 'bi bi-chevron-up';
            collapseBtn.title = 'Collapse code';
            collapseInfoSpan.style.display = 'none'; // Hide info
            newPre.style.display = ''; // Show pre
        }
        e.stopPropagation();
    });


    return wrapper;
}

// addMessage renders a single message node and its controls (Updated with button logic)
function addMessage(message) {
    // --- Do not render system messages in the main flow ---
    if (message.role === 'system') {
        return null;
    }

    const role = message.role === 'llm' ? 'assistant' : message.role; // Normalize role
    const messageRow = document.createElement('div');
    messageRow.className = `message-row ${role}-row`; // e.g., user-row, assistant-row
    messageRow.dataset.messageId = message.message_id; // Add ID to the row for easier selection

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';

    const avatarActionsDiv = document.createElement('div');
    avatarActionsDiv.className = 'message-avatar-actions'; // Container for avatar and actions

    // --- Message Actions (Buttons) ---
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'message-actions';

    // --- START OF RESTORED BUTTON LOGIC ---

    // Branch Navigation Controls (if applicable)
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

        actionsDiv.appendChild(branchNav); // Add branch controls first
    }


    // Standard Action Buttons
    const copyBtn = document.createElement('button');
    copyBtn.className = 'message-action-btn';
    copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>';
    copyBtn.title = 'Copy message text';
    copyBtn.addEventListener('click', () => copyMessageContent(contentDiv, copyBtn)); // Pass contentDiv here
    actionsDiv.appendChild(copyBtn);

    // Edit Button
    const editBtn = document.createElement('button');
    editBtn.className = 'message-action-btn';
    editBtn.innerHTML = '<i class="bi bi-pencil"></i>';
    editBtn.title = 'Edit message';
    editBtn.addEventListener('click', () => startEditing(message.message_id));
    actionsDiv.appendChild(editBtn);

    // Regenerate, Branch, Continue Buttons (Only for Assistant messages)
    if (role === 'assistant') {
        const regenerateBtn = document.createElement('button');
        regenerateBtn.className = 'message-action-btn';
        regenerateBtn.innerHTML = '<i class="bi bi-arrow-repeat"></i>';
        regenerateBtn.title = 'Regenerate this response (Replace)';
        regenerateBtn.addEventListener('click', () => regenerateMessage(message.message_id, false));
        actionsDiv.appendChild(regenerateBtn);

        const branchBtn = document.createElement('button');
        branchBtn.className = 'message-action-btn';
        branchBtn.innerHTML = '<i class="bi bi-diagram-3"></i>'; // Branching icon
        branchBtn.title = 'Regenerate as new branch';
        branchBtn.addEventListener('click', () => regenerateMessage(message.message_id, true));
        actionsDiv.appendChild(branchBtn);

        const continueBtn = document.createElement('button');
        continueBtn.className = 'message-action-btn';
        continueBtn.innerHTML = '<i class="bi bi-arrow-bar-right"></i>'; // Or other continue icon
        continueBtn.title = 'Continue generating this response';
        continueBtn.addEventListener('click', () => continueMessage(message.message_id));
        actionsDiv.appendChild(continueBtn);
    }

    // Delete Button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'message-action-btn delete-btn'; // Specific class for styling maybe
    deleteBtn.innerHTML = '<i class="bi bi-trash"></i>';
    deleteBtn.title = 'Delete message (and descendants)';
    deleteBtn.addEventListener('click', () => deleteMessage(message.message_id));
    actionsDiv.appendChild(deleteBtn);

    // --- END OF RESTORED BUTTON LOGIC ---


    // --- Message Content ---
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.dataset.raw = message.message; // Store raw markdown/text

    if (role === 'user') {
        // For user messages, display raw text respecting whitespace/newlines
        contentDiv.textContent = message.message;
        contentDiv.style.whiteSpace = 'pre-wrap';
    } else { // Assistant/LLM
        contentDiv.innerHTML = renderMarkdown(message.message);
         // Process code blocks after initial renderMarkdown
         contentDiv.querySelectorAll('pre code').forEach(block => {
            const preElement = block.parentElement;
            if (preElement && preElement.tagName === 'PRE' && !preElement.closest('.code-block-wrapper')) {
                 const codeText = block.textContent;
                 const langClass = block.className.split(' ').find(cls => cls.startsWith('language-'));
                 const lang = langClass ? langClass.substring(9) : '';
                 const wrapper = createCodeBlockWithContent(codeText, lang); // Use helper function
                 preElement.replaceWith(wrapper);
            }
         });
    }

    // --- Attachments Display ---
    if (message.attachments && message.attachments.length > 0) {
        const attachmentsContainer = document.createElement('div');
        attachmentsContainer.className = 'attachments-container'; // Use the new CSS class

        message.attachments.forEach(attachment => {
            // Store raw content if available (for popup viewer)
            const rawContent = attachment.rawContent || null;

            if (attachment.type === 'image') {
                const imgWrapper = document.createElement('div');
                imgWrapper.className = 'attachment-preview image-preview-wrapper'; // Use CSS classes
                // Pass attachment data (including potential rawContent) to popup
                imgWrapper.addEventListener('click', () => viewAttachmentPopup({...attachment, rawContent}));

                const img = document.createElement('img');
                img.src = `data:image/jpeg;base64,${attachment.content}`;
                img.alt = attachment.name || 'Attached image'; // Use name if available
                imgWrapper.appendChild(img);
                attachmentsContainer.appendChild(imgWrapper);
            } else if (attachment.type === 'file') {
                const fileWrapper = document.createElement('div');
                fileWrapper.className = 'attachment-preview file-preview-wrapper'; // Use CSS classes
                // Pass attachment data (including potential rawContent) to popup
                fileWrapper.addEventListener('click', () => viewAttachmentPopup({...attachment, rawContent}));

                const filename = attachment.name || extractFilename(attachment.content) || 'Attached File';
                // Inner structure for file preview (icon + name)
                fileWrapper.innerHTML = `<i class="bi bi-file-earmark-text"></i> <span>${filename}</span>`;
                attachmentsContainer.appendChild(fileWrapper);
            }
        });
        contentDiv.appendChild(attachmentsContainer); // Append attachments below main content
    }
    // --- End Attachments Display ---


    messageDiv.appendChild(contentDiv); // Add content div

    // Add Actions below content (Now actionsDiv is populated)
    avatarActionsDiv.appendChild(actionsDiv); // Add actions to the avatar/actions container
    messageDiv.appendChild(avatarActionsDiv); // Append the container to the message div


    messageRow.appendChild(messageDiv); // Append the main message div to the row
    messagesWrapper.appendChild(messageRow); // Append the row to the main wrapper

    // Return the contentDiv for potential streaming updates
    return contentDiv;
}


// --- Branching Logic ---

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

         // Update local state message first (important!)
         const parentMessage = state.messages.find(m => m.message_id === parentMessageId);
         if (parentMessage) {
             parentMessage.active_child_index = newIndex;
         } else {
              console.error(`Parent message ${parentMessageId} not found in local state after API call.`);
              // Fallback to full reload if state is inconsistent
              await loadChat(state.currentChatId);
              return;
         }


         // Re-render the messages from the point of change downwards
         // For simplicity, let's reload the whole chat view for now
          renderActiveMessages(); // This uses the updated state.messages
          // Optional: scroll to the parent message after re-render?
          const parentRow = messagesWrapper.querySelector(`.message-row[data-message-id="${parentMessageId}"]`);
          if (parentRow) {
               // parentRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }

     } catch (error) {
         console.error('Error setting active branch:', error);
         alert(`Failed to switch branch: ${error.message}`);
     }
}


// --- Continue / Regenerate ---

// Continue Message (update catch block for saving partial)
async function continueMessage(messageId) {
    if (!state.currentChatId || state.streamController) return; // Prevent parallel generations

    const message = state.messages.find(m => m.message_id === messageId);
    if (!message || message.role !== 'llm') { // Ensure it's an assistant message
        addSystemMessage("Error: Can only continue assistant messages.", "error");
        return;
    }

    const messageRow = messagesWrapper.querySelector(`.message-row[data-message-id="${messageId}"]`);
    const contentDiv = messageRow?.querySelector('.message-content');
    if (!contentDiv) {
        addSystemMessage(`Error: Could not find message content div for ${messageId}.`, "error");
        return;
    }

    let existingContent = message.message; // Use state message content
    contentDiv.dataset.raw = existingContent; // Ensure raw data is up-to-date

    console.log(`Continuing message ${messageId}`);

    state.streamController = new AbortController();
    // Set context for saving on abort
    state.generationContext = { type: 'continue', messageId: messageId };

    stopButton.style.display = 'flex';
    sendButton.disabled = true; // Disable send while generating
    state.isAutoScrolling = true; // Re-enable auto-scroll for continuation
    state.userHasScrolled = false;

    const scrollHandler = createScrollHandler();
    chatContainer.addEventListener('scroll', scrollHandler);

    let fullText = existingContent; // Start with existing content
    let continuationText = ''; // Only the newly streamed part

    try {
        const response = await fetch(`${API_BASE}/chat/${state.currentChatId}/continue/${messageId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model_name: modelSelect.value, // Use current UI model
                streaming: true,
                gen_args: defaultGenArgs,
                provider: state.models.find(m => m.name === modelSelect.value)?.provider
            }),
            signal: state.streamController.signal
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => `HTTP ${response.status}`);
            throw new Error(`Failed to continue message: ${errorText}`);
        }

        const reader = response.body.getReader();
        const textDecoder = new TextDecoder();
        contentDiv.classList.add('streaming'); // Add streaming indicator

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                 console.log(`Continue stream for ${messageId} finished.`);
                 break; // Handled by [DONE] signal from API
            }
            if (state.streamController?.signal.aborted) {
                 console.log(`Continue stream read aborted.`);
                 break; // Exit loop, handle in catch
            }

            const textChunk = textDecoder.decode(value, { stream: true });
            const lines = textChunk.split('\n').filter(line => line.trim());

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.substring(6).trim();
                    if (data === '[DONE]') {
                         // API indicates completion. Reload chat to get final state.
                         console.log(`Received [DONE] for continue ${messageId}. Reloading chat.`);
                         await loadChat(state.currentChatId); // Reload to get final state
                         // Clear context after successful completion and reload
                         state.generationContext = null;
                         return; // Exit the handler
                    }
                     try {
                         const json = JSON.parse(data);
                         if (json.error) {
                            throw new Error(json.error);
                         }
                          // Check for cancellation status from backend
                         if (json.status === 'cancelled') {
                             console.log("Backend confirmed cancellation for continue.");
                             continue; // Let abort signal handle flow
                         }
                         const content = json.content || '';
                         if (content && content !== ': OPENROUTER PROCESSING') { // Filter OpenRouter ping
                             continuationText += content;
                             fullText = existingContent + continuationText; // Update full text

                             // Update UI by appending to existing content
                             contentDiv.innerHTML = renderMarkdown(fullText);
                             contentDiv.dataset.raw = fullText; // Update raw data too

                            // Process code blocks AFTER innerHTML update
                             contentDiv.querySelectorAll('pre code').forEach(block => {
                                 const preElement = block.parentElement;
                                 if (preElement && preElement.tagName === 'PRE' && !preElement.closest('.code-block-wrapper')) {
                                      const codeText = block.textContent;
                                      const langClass = block.className.split(' ').find(cls => cls.startsWith('language-'));
                                      const lang = langClass ? langClass.substring(9) : '';
                                      const wrapper = createCodeBlockWithContent(codeText, lang);
                                      preElement.replaceWith(wrapper);
                                 } else if (preElement && preElement.closest('.code-block-wrapper code') && !block.classList.contains('hljs')) {
                                      try { hljs.highlightElement(block); } catch(e) { console.error("Error highlighting continue block mid-stream:", e); }
                                 }
                             });


                             if (!state.userHasScrolled && state.isAutoScrolling) {
                                 scrollToBottom();
                             }
                         }
                         if (json.complete && json.message_id === messageId) {
                              // Server confirmed save, but wait for [DONE] before reload
                              console.log(`Server confirmed continuation saved for ${messageId}`);
                         }
                     } catch (e) {
                          console.warn('Failed to parse continue stream chunk:', data, e);
                          fullText += `\n\n*Error parsing stream data*`;
                          contentDiv.innerHTML = renderMarkdown(fullText);
                          contentDiv.dataset.raw = fullText;
                     }
                }
            }
        }
        // If loop finishes without [DONE]
         console.log("Continue stream loop finished without [DONE] signal. Reloading chat state.");
         await loadChat(state.currentChatId);

    } catch (error) {
        if (error.name === 'AbortError') {
             console.log("Continue generation stopped by user.");
            // --- SAVE PARTIAL TEXT ---
            const partialText = fullText; // Use the accumulated text
            const context = state.generationContext;

            if (partialText && partialText.trim() && context && context.type === 'continue' && context.messageId) {
                 // Only save if different from original? Optional optimization.
                 if (partialText !== existingContent) {
                     try {
                         console.log("Attempting to save partial continuation...");
                         // Endpoint to save partial text for an EXISTING message
                         const saveUrl = `${API_BASE}/chat/${state.currentChatId}/save_edit_result/${context.messageId}`;
                         const payload = { message: partialText };

                          console.log(`Saving partial edit to ${saveUrl}`);
                          const saveResponse = await fetch(saveUrl, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify(payload)
                          });
                          if (!saveResponse.ok) {
                               const err = await saveResponse.text().catch(() => `HTTP ${saveResponse.status}`);
                               throw new Error(`Failed to save partial edit result: ${err}`);
                          }
                          console.log("Partial continuation saved successfully via API.");
                     } catch (saveError) {
                          console.error("Error saving partial continuation via API:", saveError);
                          addSystemMessage("Could not save the partial response.", "error");
                     }
                 } else {
                      console.log("Partial text same as original, not saving.");
                 }
            } else {
                console.warn("Partial text empty or context invalid for saving continue.", { partialText, context });
            }
            // --- END SAVE PARTIAL TEXT ---

            // Always reload chat state after abort to sync with backend
            await loadChat(state.currentChatId);

        } else {
             // Handle non-abort errors
            console.error('Continue error:', error);
            // Append error message to the div? Or show system message?
            fullText += `\n\n*Error continuing: ${error.message}*`;
            contentDiv.innerHTML = renderMarkdown(fullText);
            contentDiv.dataset.raw = fullText;
            addSystemMessage(`Error continuing generation: ${error.message}`, "error");
            await loadChat(state.currentChatId); // Reload to ensure consistent state
        }
    } finally {
        stopButton.style.display = 'none';
        sendButton.disabled = false;
        messageInput.disabled = false;
        state.streamController = null;
        state.generationContext = null; // Clear context
        state.isAutoScrolling = false; // Disable auto-scroll after finishing/aborting
        chatContainer.removeEventListener('scroll', scrollHandler);
        // Ensure streaming class is removed
        if (contentDiv) contentDiv.classList.remove('streaming');
    }
}

// Regenerate Message (update catch block for saving partial)
async function regenerateMessage(messageId, newBranch = false) {
    if (!state.currentChatId || state.streamController) return;

    const messageToRegen = state.messages.find(m => m.message_id === messageId);
    if (!messageToRegen || messageToRegen.role !== 'llm') { // Can only regen assistant messages
        addSystemMessage("Error: Can only regenerate assistant messages.", "error");
        return;
    }
    const parentMessage = state.messages.find(m => m.message_id === messageToRegen.parent_message_id);
    if (!parentMessage) {
         addSystemMessage("Error: Cannot regenerate message without a parent.", "error");
         return;
    }

    console.log(`Regenerating message ${messageId} (new branch: ${newBranch})`);

    // Find the content div of the message being regenerated/replaced
    const targetMessageRow = messagesWrapper.querySelector(`.message-row[data-message-id="${messageId}"]`);
    // Target div only relevant if NOT branching
    const contentDiv = (!newBranch && targetMessageRow) ? targetMessageRow.querySelector('.message-content') : null;

    if (!contentDiv && !newBranch) { // If replacing, we need the div
         addSystemMessage(`Error: Cannot find content div for message ${messageId} to replace.`, "error");
         return;
    }

    state.streamController = new AbortController();
     // Set context for saving on abort
    state.generationContext = { type: 'regen', messageId: messageId, newBranch: newBranch, parentMessageId: parentMessage.message_id };

    stopButton.style.display = 'flex';
    sendButton.disabled = true;
    state.isAutoScrolling = true;
    state.userHasScrolled = false;

    const scrollHandler = createScrollHandler();
    chatContainer.addEventListener('scroll', scrollHandler);

    let fullText = ''; // Accumulate new text
    let currentTargetDiv = contentDiv; // Start with original div if replacing

    if (newBranch) {
         // If branching, we don't update the original div directly.
         // We wait for the [DONE] signal which includes the new message ID, then reload.
         console.log("Regenerating as new branch. Waiting for completion...");
         // Optionally add a temporary "Generating new branch..." indicator near the original message?
    } else if (currentTargetDiv) {
         // If replacing, clear the target div and add streaming indicator
         currentTargetDiv.innerHTML = '';
         currentTargetDiv.dataset.raw = '';
         currentTargetDiv.classList.add('streaming');
    }


    try {
        const response = await fetch(`${API_BASE}/chat/${state.currentChatId}/regenerate/${messageId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model_name: modelSelect.value, // Use current UI model
                streaming: true,
                gen_args: defaultGenArgs,
                new_branch: newBranch, // Pass the flag
                provider: state.models.find(m => m.name === modelSelect.value)?.provider
            }),
            signal: state.streamController.signal
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => `HTTP ${response.status}`);
            throw new Error(`Failed to regenerate: ${errorText}`);
        }

        const reader = response.body.getReader();
        const textDecoder = new TextDecoder();
        let finalMessageId = null; // Could be original ID or new branch ID

        while (true) {
            const { done, value } = await reader.read();
             if (done) {
                 console.log(`Regen stream for ${messageId} finished.`);
                 break; // Wait for [DONE]
             }
             if (state.streamController?.signal.aborted) {
                  console.log(`Regen stream read aborted.`);
                  break; // Handle in catch
             }

            const textChunk = textDecoder.decode(value, {stream: true});
            const lines = textChunk.split('\n').filter(line => line.trim());

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.substring(6).trim();
                     if (data === '[DONE]') {
                          console.log(`Received [DONE] for regenerate ${messageId}. Reloading chat.`);
                          await loadChat(state.currentChatId); // Reload to get final state (new branch or replaced content)
                          // Clear context after successful completion and reload
                          state.generationContext = null;
                          return; // Exit handler
                     }
                     try {
                         const json = JSON.parse(data);
                         if (json.error) {
                            throw new Error(json.error);
                         }
                         // Check for cancellation status from backend
                         if (json.status === 'cancelled') {
                             console.log("Backend confirmed cancellation for regenerate.");
                             continue; // Let abort signal handle flow
                         }

                         if (json.complete && json.message_id) {
                              finalMessageId = json.message_id;
                              console.log(`Server confirmed regeneration saved for ${finalMessageId}`);
                         }

                         const content = json.content || '';
                         if (content && content !== ': OPENROUTER PROCESSING') {
                             fullText += content;
                             // Only update UI if *replacing* the message
                             if (!newBranch && currentTargetDiv) {
                                 currentTargetDiv.innerHTML = renderMarkdown(fullText);
                                 currentTargetDiv.dataset.raw = fullText;

                                // Process code blocks AFTER innerHTML update
                                 currentTargetDiv.querySelectorAll('pre code').forEach(block => {
                                     const preElement = block.parentElement;
                                     if (preElement && preElement.tagName === 'PRE' && !preElement.closest('.code-block-wrapper')) {
                                          const codeText = block.textContent;
                                          const langClass = block.className.split(' ').find(cls => cls.startsWith('language-'));
                                          const lang = langClass ? langClass.substring(9) : '';
                                          const wrapper = createCodeBlockWithContent(codeText, lang);
                                          preElement.replaceWith(wrapper);
                                     } else if (preElement && preElement.closest('.code-block-wrapper code') && !block.classList.contains('hljs')) {
                                           try { hljs.highlightElement(block); } catch(e) { console.error("Error highlighting regen block mid-stream:", e); }
                                     }
                                 });

                                 if (!state.userHasScrolled && state.isAutoScrolling) {
                                     scrollToBottom();
                                 }
                             }
                         }
                     } catch (e) {
                          console.warn('Failed to parse regen stream chunk:', data, e);
                           if (!newBranch && currentTargetDiv) {
                                fullText += `\n\n*Error parsing stream data*`;
                                currentTargetDiv.innerHTML = renderMarkdown(fullText);
                                currentTargetDiv.dataset.raw = fullText;
                           }
                     }
                }
            }
        }
        // If loop finishes without [DONE]
        console.log("Regen stream loop finished without [DONE] signal. Reloading chat state.");
        await loadChat(state.currentChatId);

    } catch (error) {
        if (error.name === 'AbortError') {
            console.log("Regeneration stopped by user.");
            // --- SAVE PARTIAL TEXT ---
            const partialText = fullText;
            const context = state.generationContext;

            if (partialText && partialText.trim() && context && context.type === 'regen') {
                 try {
                     console.log("Attempting to save partial regeneration...");
                     let saveUrl = '';
                     let payload = { message: partialText };

                     if (context.newBranch && context.parentMessageId) {
                         // Save as a new message under the original parent if branching was intended
                         saveUrl = `${API_BASE}/chat/${state.currentChatId}/save_generation_result/${context.parentMessageId}`;
                          console.log(`Saving partial NEW branch to ${saveUrl}`);
                     } else if (!context.newBranch && context.messageId) {
                          // Save by editing the message that was being replaced
                          saveUrl = `${API_BASE}/chat/${state.currentChatId}/save_edit_result/${context.messageId}`;
                           console.log(`Saving partial REPLACEMENT to ${saveUrl}`);
                     } else {
                          console.warn("Invalid context for saving partial regeneration.", context);
                     }

                     if (saveUrl) {
                          const saveResponse = await fetch(saveUrl, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify(payload)
                          });
                          if (!saveResponse.ok) {
                               const err = await saveResponse.text().catch(() => `HTTP ${saveResponse.status}`);
                               throw new Error(`Failed to save partial regen result: ${err}`);
                          }
                          console.log("Partial regeneration saved successfully via API.");
                     }
                 } catch (saveError) {
                      console.error("Error saving partial regeneration via API:", saveError);
                      addSystemMessage("Could not save the partial response.", "error");
                 }
            } else {
                 console.warn("Partial text empty or context invalid for saving regen.", { partialText, context });
            }
            // --- END SAVE PARTIAL TEXT ---

            // Always reload chat state after abort
            await loadChat(state.currentChatId);

        } else {
             // Handle non-abort errors
            console.error('Regeneration error:', error);
            if (!newBranch && contentDiv) { // Show error in original div if replacing
                 contentDiv.innerHTML = renderMarkdown(`*Error regenerating: ${error.message}*`);
                 contentDiv.dataset.raw = `Error regenerating: ${error.message}`;
                 contentDiv.classList.remove('streaming');
            } else { // Show system message if branching or div not found
                 addSystemMessage(`Error regenerating response: ${error.message}`, "error");
            }
            await loadChat(state.currentChatId); // Reload state after error
        }
    } finally {
        stopButton.style.display = 'none';
        sendButton.disabled = false;
        messageInput.disabled = false;
        state.streamController = null;
        state.generationContext = null; // Clear context
        state.isAutoScrolling = false;
        chatContainer.removeEventListener('scroll', scrollHandler);
        // Ensure streaming class is removed if replacing
        if (!newBranch && contentDiv) contentDiv.classList.remove('streaming');
    }
}


async function deleteMessage(messageId) {
    if (!state.currentChatId) return;

    const messageText = state.messages.find(m => m.message_id === messageId)?.message || `message ID ${messageId}`;
    if (!confirm(`Are you sure you want to delete this message and all its subsequent responses/branches?\n"${messageText.substring(0, 50)}..."`)) {
         return;
    }

    console.log(`Deleting message ${messageId} and descendants.`);

    try {
        const response = await fetch(`${API_BASE}/chat/${state.currentChatId}/delete_message/${messageId}`, {
            method: 'POST' // Changed to POST as DELETE with body can be problematic
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ detail: response.statusText }));
            throw new Error(`Failed to delete message: ${errorData.detail || response.statusText}`);
        }
        // Remove the message row immediately for responsiveness? Or just reload?
        // Let's reload for simplicity and guaranteed consistency.
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

    // Store original state to restore on cancel
    const originalContentHTML = contentDiv.innerHTML;
    const originalActionsDisplay = actionsDiv ? actionsDiv.style.display : '';

    contentDiv.classList.add('editing');
    if (actionsDiv) actionsDiv.style.display = 'none'; // Hide actions while editing
    contentDiv.innerHTML = ''; // Clear current content

    const textarea = document.createElement('textarea');
    textarea.className = 'edit-textarea';
    textarea.value = message.message; // Edit the raw message text
    textarea.rows = Math.min(20, Math.max(3, message.message.split('\n').length + 1)); // Auto-size roughly

    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'edit-buttons';

    const saveButton = document.createElement('button');
    saveButton.textContent = 'Save';
    saveButton.className = 'btn-primary'; // Use theme button class
    saveButton.onclick = () => saveEdit(messageId, textarea.value, message.role);

    const cancelButton = document.createElement('button');
    cancelButton.textContent = 'Cancel';
    cancelButton.className = 'btn-secondary'; // Use theme button class
    cancelButton.onclick = () => {
        contentDiv.classList.remove('editing');
        contentDiv.innerHTML = originalContentHTML; // Restore original rendered HTML
        if (actionsDiv) actionsDiv.style.display = originalActionsDisplay; // Restore actions visibility
    };

    buttonContainer.appendChild(saveButton);
    buttonContainer.appendChild(cancelButton);

    contentDiv.appendChild(textarea);
    contentDiv.appendChild(buttonContainer);

    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length; // Move cursor to end
}

async function saveEdit(messageId, newText, role) {
    // Role shouldn't change on edit, but we pass it for the API model
     const originalMessage = state.messages.find(m => m.message_id === messageId);
     if (!originalMessage) return; // Should not happen

    console.log(`Saving edit for message ${messageId}`);

    try {
        const response = await fetch(`${API_BASE}/chat/${state.currentChatId}/edit_message/${messageId}`, {
            method: 'POST', // Changed to POST as PUT often expects full resource replacement
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                 message: newText,
                 role: role, // Pass the original role
                 model_name: originalMessage.model_name, // Preserve original model if assistant
                 attachments: originalMessage.attachments // Preserve original attachments
            })
        });
        if (!response.ok) {
             const errorData = await response.json().catch(() => ({ detail: response.statusText }));
            throw new Error(`Failed to edit message: ${errorData.detail || response.statusText}`);
        }

        // Reload the chat to reflect the changes accurately
        await loadChat(state.currentChatId);

    } catch (error) {
        console.error('Error editing message:', error);
        alert(`Failed to save changes: ${error.message}`);
        // Optionally restore original content on failure? The reload above handles consistency.
    }
}


function extractFilename(content) {
    // Look for patterns like "filename.txt:\n```" or similar
    // This is heuristic and might need adjustment based on how filenames are embedded
     if (!content) return null;
    const lines = content.split('\n');
    // Basic check: first line contains ':', second line starts with ```
    if (lines.length > 1 && lines[0].includes(':') && lines[1].startsWith('```')) {
         const potentialFilename = lines[0].substring(0, lines[0].lastIndexOf(':')).trim();
         // Avoid overly long or weird "filenames"
         if (potentialFilename.length > 0 && potentialFilename.length < 100 && !potentialFilename.includes('\n')) {
            return potentialFilename;
         }
    }
    // Fallback or add more specific patterns if needed
    return null; // Return null if no reliable pattern matches
}

function copyMessageContent(contentDiv, buttonElement) {
    const rawText = contentDiv.dataset.raw || contentDiv.textContent; // Get raw text stored earlier
    if (!rawText) return;

    navigator.clipboard.writeText(rawText).then(() => {
         // Provide feedback on the button clicked
         const originalHTML = buttonElement.innerHTML;
         buttonElement.innerHTML = '<i class="bi bi-check-lg"></i>';
         buttonElement.disabled = true;
        setTimeout(() => {
             buttonElement.innerHTML = originalHTML;
             buttonElement.disabled = false;
        }, 1500);
    }).catch(err => {
        console.error('Failed to copy message content:', err);
        alert('Failed to copy text.'); // Provide feedback to user
    });
}

// Copy inline code
function setupInlineCodeCopy() {
    messagesWrapper.addEventListener('click', (e) => {
        // Check if the click target is a <code> element NOT inside a <pre>
        if (e.target.tagName === 'CODE' && e.target.closest('pre') === null) {
            const text = e.target.textContent;
            navigator.clipboard.writeText(text).then(() => {
                // Visual feedback: temporary highlight
                 e.target.style.transition = 'background-color 0.1s ease-in-out';
                e.target.style.backgroundColor = 'var(--accent-hover)'; // Use theme color
                setTimeout(() => {
                    e.target.style.backgroundColor = ''; // Revert to original or CSS default
                }, 500); // Shorter feedback duration
            }).catch(err => {
                 console.error("Failed to copy inline code:", err);
            });
        }
    });
}

// --- Event Listeners Setup ---
function setupEventListeners() {
    messageInput.addEventListener('keydown', handleInputKeydown);
    messageInput.addEventListener('input', adjustTextareaHeight);
    sendButton.addEventListener('click', sendMessage);
    stopButton.addEventListener('click', stopStreaming);
    // clearChatBtn repurposed for delete
    clearChatBtn.title = 'Delete current chat'; // Update title
    clearChatBtn.onclick = deleteCurrentChat; // Assign new handler
    newChatBtn.addEventListener('click', startNewChat);
    imageButton.addEventListener('click', () => openFileSelector('image/*'));
    fileButton.addEventListener('click', () => openFileSelector('.txt,.py,.js,.ts,.html,.css,.json,.md,.yaml,.sql,.java,.c,.cpp,.cs,.go,.php,.rb,.swift,.kt,.rs,.toml')); // Common text/code extensions
    sidebarToggle.addEventListener('click', toggleSidebar);
    modelSelect.addEventListener('change', handleModelChange); // Added handler
    document.addEventListener('paste', handlePaste);
    // Think block toggle might need to be delegated if messagesWrapper is cleared often
    messagesWrapper.addEventListener('click', handleThinkBlockToggle);
}

function handleModelChange() {
     updateAttachButtons();
     // Save selected model to local storage
     localStorage.setItem('lastModelName', modelSelect.value);
}

// Scroll handler factory
function createScrollHandler() {
     // Closure to keep track of scroll state for this specific generation
     let localUserScrolled = false;
     let localLastScrollTop = chatContainer.scrollTop;

     return () => {
         const currentScrollTop = chatContainer.scrollTop;
         const scrollHeight = chatContainer.scrollHeight;
         const clientHeight = chatContainer.clientHeight;
         const scrollDirection = currentScrollTop > localLastScrollTop ? 'down' : 'up';
         localLastScrollTop = currentScrollTop;

         // If user scrolls up significantly from the bottom, set userHasScrolled
         if (scrollDirection === 'up' && currentScrollTop < scrollHeight - clientHeight - 100) { // 100px threshold
             localUserScrolled = true;
             state.userHasScrolled = true; // Update global state too if needed
             state.isAutoScrolling = false; // Disable global autoscroll
         } else if (scrollDirection === 'down' && currentScrollTop >= scrollHeight - clientHeight - 5) { // Close to bottom
             // If user scrolls back down near the bottom, re-enable autoscroll only if *they* initiated it
             // We generally want auto-scroll unless they deliberately scrolled up.
              // Let's simplify: auto-scroll is disabled *only* if they scroll up significantly.
              // It stays disabled until the next message send/generation starts.
              // So, no re-enabling here.
         }

         // Update global state based on local state if necessary, or manage scrolling directly here
          if (localUserScrolled) {
              state.isAutoScrolling = false;
          }
     };
}


function handleInputKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
        e.preventDefault(); // Prevent newline default
        sendMessage();
    } else if (e.key === 'Enter' && e.ctrlKey) {
         e.preventDefault(); // Prevent potential form submission if inside one
         sendMessage(); // Send on Ctrl+Enter
    }
    // Shift+Enter is implicitly handled by allowing the default newline behavior
}

function adjustTextareaHeight() {
    const inputArea = document.querySelector('.input-area'); // Target the container
    const inputContainer = document.querySelector('.input-container');
    const initialTextareaHeight = 24; // Match CSS line-height or min-height
    const maxHeight = 300; // Max height for the textarea in pixels

    messageInput.style.height = 'auto'; // Temporarily shrink to measure scrollHeight
    let newScrollHeight = messageInput.scrollHeight;

    // Account for padding and border if box-sizing is border-box (usually is)
    const style = window.getComputedStyle(messageInput);
    const paddingTop = parseFloat(style.paddingTop);
    const paddingBottom = parseFloat(style.paddingBottom);
    // Border calculation can be complex, often 1px top/bottom
    // Let's use scrollHeight directly, but cap it.

    let newHeight = Math.max(initialTextareaHeight, newScrollHeight);
    newHeight = Math.min(newHeight, maxHeight);

    messageInput.style.height = `${newHeight}px`;

    // Adjust overall input area padding/height based on textarea size
    // This is complex. Let's adjust the bottom padding of the chat container instead.
    const basePaddingBottom = 100; // Base padding when textarea is minimal
    const extraPadding = Math.max(0, newHeight - initialTextareaHeight);
    chatContainer.style.paddingBottom = `${basePaddingBottom + extraPadding}px`;
    // Scroll to bottom if focused? Maybe not, could be annoying.
}


function toggleSidebar() {
    const characterBtn = document.getElementById('character-btn');
    const isCollapsed = sidebar.classList.toggle('sidebar-collapsed');
    const icon = sidebarToggle.querySelector('i');
    const textElements = sidebar.querySelectorAll('.sidebar-title span, .new-chat-btn span, .history-item span, .history-title');
    const mainContent = document.querySelector('.main-content'); // Get main content area

    icon.className = `bi bi-chevron-${isCollapsed ? 'right' : 'left'}`;

    // Adjust layout based on collapsed state using CSS custom property
    document.documentElement.style.setProperty('--sidebar-width', isCollapsed ? '0px' : '260px');
    mainContent.style.marginLeft = '0px'//isCollapsed ? '0px' : '260px'; // Sync margin


    // Hide/show text elements within the sidebar
    textElements.forEach(el => {
         el.style.display = isCollapsed ? 'none' : ''; // Use '' to revert to CSS default (inline/block etc.)
    });

    // Adjust character button position relative to sidebar toggle
    //sidebarToggle.style.left = isCollapsed ? '0px' : '260px';
    characterBtn.style.marginLeft = isCollapsed ? '32px' : '0px';

    // Save state?
    //localStorage.setItem('sidebarCollapsed', isCollapsed);
}

// Apply sidebar state on load
function applySidebarState() {
     const isCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';
     const icon = sidebarToggle.querySelector('i');
     const textElements = sidebar.querySelectorAll('.sidebar-title span, .new-chat-btn span, .history-item span, .history-title');
     const mainContent = document.querySelector('.main-content'); // Get main content area

     if (isCollapsed) {
         // Don't toggle, directly set the state
          sidebar.classList.add('sidebar-collapsed');
          icon.className = `bi bi-chevron-right`;
          textElements.forEach(el => { el.style.display = 'none'; });
          document.documentElement.style.setProperty('--sidebar-width', '0px');
          //mainContent.style.marginLeft = '0px'; // Set initial margin
          //sidebarToggle.style.left = '0px';
     } else {
          sidebar.classList.remove('sidebar-collapsed');
          icon.className = `bi bi-chevron-left`;
          textElements.forEach(el => { el.style.display = ''; });
          document.documentElement.style.setProperty('--sidebar-width', '260px');
          //mainContent.style.marginLeft = '260px'; // Set initial margin
          //sidebarToggle.style.left = '260px';
     }
}


function updateAttachButtons() {
    const selectedOption = modelSelect.options[modelSelect.selectedIndex];
    const supportsImages = selectedOption ? selectedOption.dataset.supportsImages === 'true' : false;

    imageButton.style.display = supportsImages ? 'flex' : 'none';
    // File button is always shown for now
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
            // Check file size? Limit to e.g., 1MB?
            if (file.size > 1 * 1024 * 1024) {
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
    // Use common preview class AND specific image class
    wrapper.className = 'image-preview-wrapper attached-file-preview';

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
        // Format for sending to API (include filename)
        // Determine language from extension for ``` block
        const extension = filename.split('.').pop() || 'text';
        const formattedContent = `${filename}:\n\`\`\`${extension}\n${content}\n\`\`\``;
        const fileData = { name: filename, content: formattedContent, type: 'file', rawContent: content }; // Store raw content too
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
    // Use common preview class AND specific file class
    wrapper.className = 'file-preview-wrapper attached-file-preview';

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

// Helper to create standardized remove button (Added position styling)
// No changes needed here, just ensure the CSS for .remove-attachment exists
function createRemoveButton(onClickCallback) {
    const removeButton = document.createElement('button');
    removeButton.className = 'remove-attachment'; // Use this class for CSS targeting
    removeButton.innerHTML = '<i class="bi bi-x"></i>';
    removeButton.title = 'Remove attachment';
    removeButton.type = 'button'; // Ensure it doesn't submit forms
    // Add inline styles for positioning as CSS cannot be changed
    // --- CSS is now handling this styling via the .remove-attachment class ---
    // removeButton.style.cssText = `...`; // Remove inline styles if CSS handles it

    removeButton.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent triggering preview click
        onClickCallback();
    });
    // Remove hover effects if CSS handles them
    // removeButton.addEventListener('mouseover', () => { ... });
    // removeButton.addEventListener('mouseout', () => { ... });
    return removeButton;
}

// addMessage renders a single message node and its controls (Updated with button logic)
function addMessage(message) {
    // --- Do not render system messages in the main flow ---
    if (message.role === 'system') {
        return null;
    }

    const role = message.role === 'llm' ? 'assistant' : message.role; // Normalize role
    const messageRow = document.createElement('div');
    messageRow.className = `message-row ${role}-row`; // e.g., user-row, assistant-row
    messageRow.dataset.messageId = message.message_id; // Add ID to the row for easier selection

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';

    const avatarActionsDiv = document.createElement('div');
    avatarActionsDiv.className = 'message-avatar-actions'; // Container for avatar and actions

    // --- Message Actions (Buttons) ---
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'message-actions';

    // --- START OF RESTORED BUTTON LOGIC ---

    // Branch Navigation Controls (if applicable)
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

        actionsDiv.appendChild(branchNav); // Add branch controls first
    }


    // Standard Action Buttons
    const copyBtn = document.createElement('button');
    copyBtn.className = 'message-action-btn';
    copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>';
    copyBtn.title = 'Copy message text';
    copyBtn.addEventListener('click', () => copyMessageContent(contentDiv, copyBtn)); // Pass contentDiv here
    actionsDiv.appendChild(copyBtn);

    // Edit Button
    const editBtn = document.createElement('button');
    editBtn.className = 'message-action-btn';
    editBtn.innerHTML = '<i class="bi bi-pencil"></i>';
    editBtn.title = 'Edit message';
    editBtn.addEventListener('click', () => startEditing(message.message_id));
    actionsDiv.appendChild(editBtn);

    // Regenerate, Branch, Continue Buttons (Only for Assistant messages)
    if (role === 'assistant') {
        const regenerateBtn = document.createElement('button');
        regenerateBtn.className = 'message-action-btn';
        regenerateBtn.innerHTML = '<i class="bi bi-arrow-repeat"></i>';
        regenerateBtn.title = 'Regenerate this response (Replace)';
        regenerateBtn.addEventListener('click', () => regenerateMessage(message.message_id, false));
        actionsDiv.appendChild(regenerateBtn);

        const branchBtn = document.createElement('button');
        branchBtn.className = 'message-action-btn';
        branchBtn.innerHTML = '<i class="bi bi-diagram-3"></i>'; // Branching icon
        branchBtn.title = 'Regenerate as new branch';
        branchBtn.addEventListener('click', () => regenerateMessage(message.message_id, true));
        actionsDiv.appendChild(branchBtn);

        const continueBtn = document.createElement('button');
        continueBtn.className = 'message-action-btn';
        continueBtn.innerHTML = '<i class="bi bi-arrow-bar-right"></i>'; // Or other continue icon
        continueBtn.title = 'Continue generating this response';
        continueBtn.addEventListener('click', () => continueMessage(message.message_id));
        actionsDiv.appendChild(continueBtn);
    }

    // Delete Button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'message-action-btn delete-btn'; // Specific class for styling maybe
    deleteBtn.innerHTML = '<i class="bi bi-trash"></i>';
    deleteBtn.title = 'Delete message (and descendants)';
    deleteBtn.addEventListener('click', () => deleteMessage(message.message_id));
    actionsDiv.appendChild(deleteBtn);

    // --- END OF RESTORED BUTTON LOGIC ---


    // --- Message Content ---
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.dataset.raw = message.message; // Store raw markdown/text

    if (role === 'user') {
        // For user messages, display raw text respecting whitespace/newlines
        contentDiv.textContent = message.message;
        contentDiv.style.whiteSpace = 'pre-wrap';
    } else { // Assistant/LLM
        contentDiv.innerHTML = renderMarkdown(message.message);
         // Process code blocks after initial renderMarkdown
         contentDiv.querySelectorAll('pre code').forEach(block => {
            const preElement = block.parentElement;
            if (preElement && preElement.tagName === 'PRE' && !preElement.closest('.code-block-wrapper')) {
                 const codeText = block.textContent;
                 const langClass = block.className.split(' ').find(cls => cls.startsWith('language-'));
                 const lang = langClass ? langClass.substring(9) : '';
                 const wrapper = createCodeBlockWithContent(codeText, lang); // Use helper function
                 preElement.replaceWith(wrapper);
            }
         });
    }

    // --- Attachments Display ---
    if (message.attachments && message.attachments.length > 0) {
        const attachmentsContainer = document.createElement('div');
        attachmentsContainer.className = 'attachments-container'; // Use the new CSS class

        message.attachments.forEach(attachment => {
            // Store raw content if available (for popup viewer)
            const rawContent = attachment.rawContent || null;

            if (attachment.type === 'image') {
                const imgWrapper = document.createElement('div');
                imgWrapper.className = 'attachment-preview image-preview-wrapper'; // Use CSS classes
                // Pass attachment data (including potential rawContent) to popup
                imgWrapper.addEventListener('click', () => viewAttachmentPopup({...attachment, rawContent}));

                const img = document.createElement('img');
                img.src = `data:image/jpeg;base64,${attachment.content}`;
                img.alt = attachment.name || 'Attached image'; // Use name if available
                imgWrapper.appendChild(img);
                attachmentsContainer.appendChild(imgWrapper);
            } else if (attachment.type === 'file') {
                const fileWrapper = document.createElement('div');
                fileWrapper.className = 'attachment-preview file-preview-wrapper'; // Use CSS classes
                // Pass attachment data (including potential rawContent) to popup
                fileWrapper.addEventListener('click', () => viewAttachmentPopup({...attachment, rawContent}));

                const filename = attachment.name || extractFilename(attachment.content) || 'Attached File';
                // Inner structure for file preview (icon + name)
                fileWrapper.innerHTML = `<i class="bi bi-file-earmark-text"></i> <span>${filename}</span>`;
                attachmentsContainer.appendChild(fileWrapper);
            }
        });
        contentDiv.appendChild(attachmentsContainer); // Append attachments below main content
    }
    // --- End Attachments Display ---


    messageDiv.appendChild(contentDiv); // Add content div

    // Add Actions below content (Now actionsDiv is populated)
    avatarActionsDiv.appendChild(actionsDiv); // Add actions to the avatar/actions container
    messageDiv.appendChild(avatarActionsDiv); // Append the container to the message div


    messageRow.appendChild(messageDiv); // Append the main message div to the row
    messagesWrapper.appendChild(messageRow); // Append the row to the main wrapper

    // Return the contentDiv for potential streaming updates
    return contentDiv;
}

// View attachment in popup (updated to use rawContent)
function viewAttachmentPopup(attachment) {
     const popup = document.createElement('div');
     popup.className = 'attachment-popup-overlay';
     popup.addEventListener('click', (e) => {
         // Close if clicked outside the content area
         if (e.target === popup) {
             popup.remove();
         }
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
         // Use the rawContent passed from addMessage if available
         let rawFileContent = attachment.rawContent;
         if (rawFileContent === null || rawFileContent === undefined) {
             // Fallback: Attempt to parse back from formatted content if rawContent wasn't stored/passed
             console.warn("Raw content not available for file popup, attempting parse fallback.");
             rawFileContent = attachment.content ? attachment.content.replace(/^.*:\n```[^\n]*\n/, '').replace(/\n```$/, '') : null;
         }
          contentElement.textContent = rawFileContent !== null ? rawFileContent : "Could not load file content."; // Display raw content
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

// View attachment in popup
function viewAttachmentPopup(attachment) {
     const popup = document.createElement('div');
     popup.className = 'attachment-popup-overlay';
     popup.addEventListener('click', (e) => {
         // Close if clicked outside the content area
         if (e.target === popup) {
             popup.remove();
         }
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
         contentElement.alt = 'Image attachment';
         contentElement.className = 'attachment-popup-image';
     } else if (attachment.type === 'file') {
         contentElement = document.createElement('pre');
         // Display the *raw* content, not the formatted version with backticks
         // Need to parse it back here or use stored raw content
         let rawFileContent = attachment.rawContent; // Prefer stored raw content if available
         if (!rawFileContent && attachment.content) {
              // Attempt to parse back if rawContent wasn't stored/passed
              rawFileContent = attachment.content.replace(/^.*:\n```[^\n]*\n/, '').replace(/\n```$/, '');
         }
          contentElement.textContent = rawFileContent || "Could not load file content."; // Display raw content
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
    if (!supportsImages) return; // Only handle paste if images are supported by model

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
    const dropZone = document.body; // Or a more specific element like chatContainer

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
        document.body.addEventListener(eventName, preventDefaults, false); // Prevent browser default drop anywhere
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
             // Add visual indicator class to the drop zone (e.g., body or input area)
             document.body.classList.add('dragover-active');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
             document.body.classList.remove('dragover-active');
        }, false);
    });

    dropZone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files && files.length > 0) {
            handleFiles(files); // Use the same handler as file input
        }
    });
}

// --- Send Message & Generate Response ---

async function sendMessage() {
    const messageText = messageInput.value.trim();
    const attachments = [
        // Map stored image data to API format
        ...state.currentImages.map(img => ({ type: 'image', content: img.base64 })),
        // Map stored text file data to API format
        ...state.currentTextFiles.map(file => ({ type: 'file', content: file.content, name: file.name })) // Include name if API uses it
    ];

    if (!messageText && attachments.length === 0) {
         console.log("Empty message and no attachments, not sending.");
         return; // Don't send empty messages
    }
     if (state.streamController) {
          console.log("Already generating, please wait.");
          // Optionally provide user feedback (e.g., shake button)
          return;
     }

    // Disable input and show loading state
    sendButton.disabled = true;
    sendButton.innerHTML = '<div class="spinner"></div>'; // Loading indicator
    messageInput.disabled = true;
    stopButton.style.display = 'none'; // Hide stop button initially

    // Clear input area *after* grabbing values
    messageInput.value = '';
    state.currentImages = [];
    state.currentTextFiles = [];
    imagePreviewContainer.innerHTML = '';
    adjustTextareaHeight(); // Adjust height after clearing input and previews

    // Hide welcome container if it's visible
    if (welcomeContainer.style.display !== 'none') {
         welcomeContainer.style.display = 'none';
    }

    try {
        let currentChatId = state.currentChatId;
        let messagesForGeneration = [];

        // 1. Create new chat if necessary
        if (!currentChatId) {
            console.log("No current chat, creating new one...");
            const response = await fetch(`${API_BASE}/chat/new_chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                     message: messageText || " ", // Send space if only attachments
                     attachments: attachments,
                     character_id: state.currentCharacterId // Pass selected character
                })
            });
            if (!response.ok) throw new Error(`Failed to create chat: ${await response.text()}`);
            const { chat_id } = await response.json();
            currentChatId = chat_id;
            state.currentChatId = chat_id; // Update state
            console.log(`New chat created: ${currentChatId}`);
            await fetchChats(); // Refresh chat list
            await loadChat(currentChatId); // Load the new chat (which includes the first message)
            // Generation will happen naturally if loadChat triggers it, or call explicitly?
            // The flow now relies on generateResponse being called *after* ensuring the user message exists.
             // Since new_chat adds the message, we proceed to generate.
        } else {
             // 2. Add user message to existing chat
             console.log(`Adding message to chat: ${currentChatId}`);
             const response = await fetch(`${API_BASE}/chat/${currentChatId}/add_message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                     message: messageText || " ", // Send space if only attachments
                     role: 'user',
                     attachments: attachments
                 })
            });
            if (!response.ok) throw new Error(`Failed to add message: ${await response.text()}`);
            const { message_id } = await response.json();
            console.log(`User message ${message_id} added.`);
            // Add message locally for instant display? Or rely on generate's reload?
             // Let's add locally then call generate.
             const newUserMessage = {
                 message_id,
                 chat_id: currentChatId,
                 role: 'user',
                 message: messageText || " ",
                 attachments: attachments, // Use the same attachments array
                 timestamp: Date.now(),
                 parent_message_id: state.messages.length > 0 ? findLastActiveMessageId(state.messages) : null, // Find actual parent
                 active_child_index: 0,
                 child_message_ids: []
             };
              state.messages.push(newUserMessage); // Add to local state
              renderActiveMessages(); // Re-render to show the new user message immediately
              scrollToBottom();
        }

        // 3. Trigger Generation
         if (currentChatId) {
             await generateResponse(); // Now call generate
         } else {
              console.error("Chat ID is still null after attempting creation/message add.");
         }

    } catch (error) {
        console.error('Error sending message or starting generation:', error);
        addSystemMessage(`Error: ${error.message}`, "error"); // Show error in chat
    } finally {
        // Restore input state
        sendButton.disabled = false;
        sendButton.innerHTML = '<i class="bi bi-send-fill"></i>'; // Restore send icon
        messageInput.disabled = false;
        // Keep focus on input?
        messageInput.focus();
    }
}

// Helper to find the last message ID in the active branch
function findLastActiveMessageId(messages) {
     if (!messages || messages.length === 0) return null;

     const messageMap = new Map(messages.map(msg => [msg.message_id, { ...msg, children: [] }]));
     const rootMessages = [];

     messages.forEach(msg => {
         if (msg.role === 'system') return; // Skip system messages
         const msgNode = messageMap.get(msg.message_id);
         if (!msgNode) return;
         if (msg.parent_message_id && messageMap.has(msg.parent_message_id)) {
             messageMap.get(msg.parent_message_id).children.push(msgNode);
         } else if (!msg.parent_message_id) {
             rootMessages.push(msgNode);
         }
     });
     messageMap.forEach(node => node.children.sort((a, b) => a.timestamp - b.timestamp));
     rootMessages.sort((a, b) => a.timestamp - b.timestamp);

     let lastActiveId = null;
     let currentNode = rootMessages.length > 0 ? rootMessages[0] : null;

     while (currentNode) {
         lastActiveId = currentNode.message_id;
         const children = currentNode.children;
         if (children && children.length > 0) {
             const activeIndex = currentNode.active_child_index ?? 0;
             currentNode = children[activeIndex < children.length ? activeIndex : 0];
         } else {
             currentNode = null; // End of branch
         }
     }
     return lastActiveId;
}

// Generate Response (updated stream handling and abort logic)
async function generateResponse() {
    if (!state.currentChatId || state.streamController) {
         console.warn("Generation skipped: No chat ID or already generating.");
         return;
    }

    const parentMessageId = findLastActiveMessageId(state.messages); // Find true parent for context
    if (!parentMessageId) {
        addSystemMessage("Error: Cannot generate response without a preceding message.", "error");
        return;
    }

    console.log(`Starting generation for chat ${state.currentChatId}, parent: ${parentMessageId}`);

    state.streamController = new AbortController();
    // Set context for saving on abort
    state.generationContext = { type: 'new', parentMessageId: parentMessageId };

    stopButton.style.display = 'flex';
    sendButton.disabled = true; // Keep send disabled
    state.isAutoScrolling = true; // Enable auto-scroll for new response
    state.userHasScrolled = false;

    const scrollHandler = createScrollHandler();
    chatContainer.addEventListener('scroll', scrollHandler);

    // Add placeholder for the assistant message
    const assistantMessagePlaceholder = {
         message_id: `temp_${Date.now()}`, // Temporary ID
         role: 'llm',
         message: '',
         attachments: [],
         timestamp: Date.now(),
         parent_message_id: parentMessageId,
         active_child_index: 0,
         child_message_ids: []
    };


    // Add placeholder to local state and render it
    state.messages.push(assistantMessagePlaceholder);
    renderActiveMessages(); // Re-render to show the placeholder (empty initially)
    const contentDiv = messagesWrapper.querySelector(`.message-row[data-message-id="${assistantMessagePlaceholder.message_id}"] .message-content`);

    if (!contentDiv) {
         console.error("Failed to find placeholder message div after rendering.");
         // Cleanup before erroring out
          stopButton.style.display = 'none';
          sendButton.disabled = false;
          state.streamController = null;
          state.generationContext = null;
          state.messages = state.messages.filter(m => m.message_id !== assistantMessagePlaceholder.message_id); // Remove placeholder from state
          renderActiveMessages(); // Re-render without placeholder
         addSystemMessage("Internal error: Could not create message placeholder.", "error");
         return;
    }

    contentDiv.classList.add('streaming'); // Add streaming indicator
    state.currentAssistantMessageDiv = contentDiv; // Track the div being streamed into
    scrollToBottom(); // Scroll after placeholder is added

    let fullText = ''; // Accumulate text here
    let finalMessageId = null;

    try {
        const response = await fetch(`${API_BASE}/chat/${state.currentChatId}/generate/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model_name: modelSelect.value,
                streaming: true,
                gen_args: defaultGenArgs,
                provider: state.models.find(m => m.name === modelSelect.value)?.provider
            }),
            signal: state.streamController.signal
        });

        if (!response.ok) {
             const errorText = await response.text().catch(() => `HTTP ${response.status}`);
            throw new Error(`Generation request failed: ${errorText}`);
        }

        const reader = response.body.getReader();
        const textDecoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
             if (done) {
                  console.log(`Generation stream for ${state.currentChatId} finished.`);
                  break; // Should be handled by [DONE] signal
             }
              if (state.streamController?.signal.aborted) {
                  // AbortError will be thrown by fetch, handled in catch block
                  console.log(`Stream read aborted.`);
                  break; // Exit loop immediately
              }

            const textChunk = textDecoder.decode(value, { stream: true }); // Use stream: true
            const lines = textChunk.split('\n').filter(line => line.trim());

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.substring(6).trim();
                    if (data === '[DONE]') {
                         console.log(`Received [DONE] for generation in ${state.currentChatId}. Reloading chat.`);
                         // The backend handled saving, just reload to get the final state with correct ID
                         await loadChat(state.currentChatId);
                         // Clear context after successful completion and reload
                         state.generationContext = null;
                         return; // Exit generation handler
                    }
                    try {
                         const json = JSON.parse(data);
                         if (json.error) {
                            throw new Error(json.error);
                         }
                          // Check for cancellation status from backend (redundant if using abort signal properly)
                         if (json.status === 'cancelled') {
                             console.log("Backend indicated cancellation (may be delayed).");
                             // AbortError should handle this flow via the catch block now
                             continue; // Skip further processing of this chunk
                         }

                         // Check for final message ID confirmation
                          if (json.complete && json.message_id) {
                               finalMessageId = json.message_id;
                               console.log(`Server confirmed message saved with ID: ${finalMessageId}`);
                               // We still wait for [DONE] before reload
                          }

                         const content = json.content || '';
                         if (content && content !== ': OPENROUTER PROCESSING') {
                             fullText += content; // Accumulate full text
                             contentDiv.innerHTML = renderMarkdown(fullText); // Update HTML
                             contentDiv.dataset.raw = fullText; // Update raw data

                             // Process code blocks AFTER innerHTML update
                             contentDiv.querySelectorAll('pre code').forEach(block => {
                                 const preElement = block.parentElement;
                                 if (preElement && preElement.tagName === 'PRE' && !preElement.closest('.code-block-wrapper')) {
                                      // Found an unwrapped block, wrap it
                                      const codeText = block.textContent;
                                      const langClass = block.className.split(' ').find(cls => cls.startsWith('language-'));
                                      const lang = langClass ? langClass.substring(9) : '';
                                      // Use the updated createCodeBlockWithContent
                                      const wrapper = createCodeBlockWithContent(codeText, lang);
                                      preElement.replaceWith(wrapper);
                                 } else if (preElement && preElement.closest('.code-block-wrapper code')) {
                                     // It's already wrapped, check if highlighting needs refresh (e.g., theme change logic)
                                     // For streaming, marked should apply classes, hljs might run in createCodeBlockWithContent
                                     // Re-highlighting here might be redundant unless classes are missing
                                      if (!block.classList.contains('hljs')) {
                                           try { hljs.highlightElement(block); } catch(e) { console.error("Error highlighting block mid-stream:", e); }
                                      }
                                 }
                             });


                             if (!state.userHasScrolled && state.isAutoScrolling) {
                                 scrollToBottom();
                             }
                         }
                    } catch (e) {
                        console.warn('Failed to parse generation stream chunk:', data, e);
                        // Update UI with error indication within the stream if possible
                        fullText += `\n\n*Error parsing stream data*`;
                        contentDiv.innerHTML = renderMarkdown(fullText);
                        contentDiv.dataset.raw = fullText;
                    }
                }
            }
        }

        // If loop finishes without [DONE] (e.g., network issue before explicit abort)
        console.log("Stream loop finished without [DONE] signal. Reloading chat state.");
        await loadChat(state.currentChatId);


    } catch (error) {
        if (error.name === 'AbortError') {
            console.log("Generation stopped by user.");
            // --- SAVE PARTIAL TEXT ---
            const partialText = fullText; // Get the text accumulated so far
            const context = state.generationContext; // Get context

            if (partialText && partialText.trim() && context && context.type === 'new' && context.parentMessageId) {
                 try {
                     console.log("Attempting to save partial generation...");
                     // Endpoint to save partial text for a NEW message under a parent
                     const saveUrl = `${API_BASE}/chat/${state.currentChatId}/save_generation_result/${context.parentMessageId}`;
                     const payload = { message: partialText };

                      console.log(`Saving partial to ${saveUrl}`);
                      const saveResponse = await fetch(saveUrl, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(payload)
                      });
                      if (!saveResponse.ok) {
                           const err = await saveResponse.text().catch(() => `HTTP ${saveResponse.status}`);
                           throw new Error(`Failed to save partial result: ${err}`);
                      }
                      console.log("Partial generation saved successfully via API.");
                 } catch (saveError) {
                      console.error("Error saving partial generation via API:", saveError);
                      // Inform the user the save failed, but still reload
                      addSystemMessage("Could not save the partial response.", "error");
                 }
            } else {
                 console.warn("Partial text empty or context invalid, not saving.", { partialText, context });
            }
            // --- END SAVE PARTIAL TEXT ---

            // Always reload chat state after abort to sync with backend (whether save succeeded or not)
            await loadChat(state.currentChatId);

        } else {
            // Handle non-abort errors as before
            console.error('Generation error:', error);
            if (contentDiv) { // Show error in the placeholder div
                 contentDiv.innerHTML = renderMarkdown(fullText + `\n\n*Error generating response: ${error.message}*`);
                 contentDiv.classList.remove('streaming');
                 contentDiv.dataset.raw = fullText + `\n\nError generating response: ${error.message}`;
            } else { // Fallback to system message
                 addSystemMessage(`Error generating response: ${error.message}`, "error");
            }
             // Attempt to reload chat state even after error to ensure consistency
             try { await loadChat(state.currentChatId); } catch { /* ignore reload error */ }
        }
    } finally {
        stopButton.style.display = 'none';
        sendButton.disabled = false; // Re-enable send button
        messageInput.disabled = false; // Re-enable input
        state.streamController = null;
        state.generationContext = null; // Clear context regardless of outcome
        state.currentAssistantMessageDiv = null;
        state.isAutoScrolling = false; // Disable auto-scroll
        chatContainer.removeEventListener('scroll', scrollHandler);
        // Ensure streaming class is removed if it was added and might still be present
        const finalPlaceholderDiv = messagesWrapper.querySelector(`.message-row[data-message-id="${assistantMessagePlaceholder.message_id}"] .message-content`);
        if (finalPlaceholderDiv) finalPlaceholderDiv.classList.remove('streaming');
        // If the message ID changed after reload, the placeholder is gone anyway.
        // We might need to find the *actual* last message div and ensure its class is removed?
        // Reloading the chat should handle the final state correctly.
    }
}


// stopStreaming function (now only aborts, saving is handled in catch block)
async function stopStreaming() {
    if (state.streamController && !state.streamController.signal.aborted) {
        console.log("Attempting to stop streaming via AbortController...");
        state.streamController.abort(); // Abort the fetch request

        // Optional: Send non-blocking signal to backend if helpful for faster cleanup
        fetch(`${API_BASE}/stop`, { method: 'POST' }).catch(err => console.warn("Backend /stop signal failed:", err));

        // UI cleanup (hiding button) happens immediately
        stopButton.style.display = 'none';
        // Re-enabling send/input and final state update (saving partial, reloading) is handled
        // in the catch block of the function that initiated the stream.
    } else {
        console.log("No active stream to stop or already aborted.");
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
            // Store sysprompt directly on option for displayActiveSystemPrompt? Maybe not needed.
            // option.dataset.sysprompt = char.sysprompt;
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

    // Display prompt for the currently selected character in the dropdown (even if not active chat char)
     // This seems wrong, displayActiveSystemPrompt should reflect the *chat's* character.
     // Let's call displayActiveSystemPrompt based on state.currentCharacterId instead.
     // displayActiveSystemPrompt(selectedId, characters); // No, do this based on chat load / selection change
}

function displayActiveSystemPrompt(characterId, characters = null) {
    const mainContent = document.querySelector('.main-content');
    let activePromptDisplay = document.getElementById('active-system-prompt');
    const chatContainerElement = document.getElementById('chat-container');

    // If no character ID, remove the display if it exists
    if (!characterId) {
        if (activePromptDisplay) activePromptDisplay.remove();
        if(chatContainerElement) chatContainerElement.style.paddingTop = '0'; // Reset padding
        return;
    }

     // Ensure characters list is available
     if (!characters) {
          console.warn("Cannot display system prompt without character list.");
          // Optionally fetch characters here if needed, but better to pass them in
          if (activePromptDisplay) activePromptDisplay.remove(); // Remove old one if exists
          if(chatContainerElement) chatContainerElement.style.paddingTop = '0'; // Reset padding
          return;
     }

    const character = characters.find(c => c.character_id === characterId);
    if (!character || !character.sysprompt) {
        // Character selected but no prompt, or character not found? Remove display.
        if (activePromptDisplay) activePromptDisplay.remove();
        if(chatContainerElement) chatContainerElement.style.paddingTop = '0'; // Reset padding
        return;
    }

    // Create or update the display element
    if (!activePromptDisplay) {
        activePromptDisplay = document.createElement('div');
        activePromptDisplay.id = 'active-system-prompt';
        // Apply styles directly - designed to look like a message row header
        activePromptDisplay.style.cssText = `
            background: var(--message-user);
            padding: 5px 20px; /* Match header padding */
            border-bottom: 1px solid var(--border-color);
            position: sticky; /* Stick to top */
            top: 60px; /* Below main header */
            z-index: 4; /* Below header, above chat */
            cursor: pointer;
            max-height: 40px; /* Initial collapsed height */
            overflow: hidden;
            transition: max-height 0.3s ease-in-out;
        `;

        activePromptDisplay.addEventListener('click', () => {
            const isCollapsed = activePromptDisplay.classList.toggle('collapsed');
            const icon = activePromptDisplay.querySelector('.expand-icon i');
            const promptContent = activePromptDisplay.querySelector('.system-prompt-content');

            if (isCollapsed) {
                activePromptDisplay.style.maxHeight = '40px'; // Collapsed height
                if (icon) icon.className = 'bi bi-chevron-down';
                if (promptContent) promptContent.style.display = 'none';
            } else {
                activePromptDisplay.style.maxHeight = '300px'; // Expanded height limit
                 if (icon) icon.className = 'bi bi-chevron-up';
                if (promptContent) promptContent.style.display = 'block'; // Or 'pre' if needed
            }
        });

         // Insert it right after the header
         const headerElement = document.querySelector('.header');
         if (mainContent && headerElement) {
             headerElement.after(activePromptDisplay); // Insert after the main header
         }
    }

    // Update content
    activePromptDisplay.innerHTML = `
         <div style="display: flex; justify-content: space-between; align-items: center; height: 30px;">
              <span style="font-weight: 500; color: var(--text-secondary); font-size: 0.9em;">
                 Active Prompt: ${character.character_name}
              </span>
              <span class="expand-icon" style="color: var(--text-secondary);"><i class="bi bi-chevron-down"></i></span>
         </div>
         <pre class="system-prompt-content" style="white-space: pre-wrap; margin-top: 5px; padding: 10px; background-color: var(--bg-primary); border-radius: var(--border-radius-md); border: 1px solid var(--border-color); font-size: 0.85em; max-height: 250px; overflow-y: auto; display: none;">${character.sysprompt}</pre>
     `;

     // Ensure it's collapsed initially after update/creation
     activePromptDisplay.classList.add('collapsed');
     activePromptDisplay.style.maxHeight = '40px'; // Reset max-height
     const promptContent = activePromptDisplay.querySelector('.system-prompt-content');
     if (promptContent) promptContent.style.display = 'none';
     const icon = activePromptDisplay.querySelector('.expand-icon i');
     if (icon) icon.className = 'bi bi-chevron-down';

     // Adjust chat container padding dynamically? Maybe not needed with sticky position.
     // if(chatContainerElement) chatContainerElement.style.paddingTop = `${activePromptDisplay.offsetHeight}px`;

}


// Simplified Character Modal Logic (Removed model selection from character)
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
        // Toggle display, ensure it's positioned correctly relative to button
        characterPopup.style.display = characterPopup.style.display === 'none' ? 'block' : 'none';
        e.stopPropagation(); // Prevent triggering document click listener immediately
    });

    characterSelect.addEventListener('change', async () => {
        const selectedCharacterId = characterSelect.value || null;
        console.log(`Character selection changed to: ${selectedCharacterId}`);
        localStorage.setItem('lastCharacterId', selectedCharacterId || ''); // Save selection

        // Enable/disable edit/delete buttons
        characterEditBtn.disabled = !selectedCharacterId;
        characterDeleteBtn.disabled = !selectedCharacterId;

        // Update the active character for the *current chat*
        if (state.currentChatId) {
            try {
                console.log(`Setting character ${selectedCharacterId} for chat ${state.currentChatId}`);
                const response = await fetch(`${API_BASE}/chat/${state.currentChatId}/set_active_character`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ character_id: selectedCharacterId })
                });
                if (!response.ok) throw new Error(`Failed to set character: ${await response.text()}`);
                state.currentCharacterId = selectedCharacterId; // Update local state *after* success
                // Reload the chat to reflect potential system prompt changes? Yes.
                 await loadChat(state.currentChatId); // This handles displaying the prompt banner
            } catch (error) {
                console.error('Error setting character for chat:', error);
                alert(`Failed to set active character: ${error.message}`);
                // Revert dropdown?
                characterSelect.value = state.currentCharacterId || '';
            }
        } else {
             // No active chat, just update state for potential new chat
             state.currentCharacterId = selectedCharacterId;
             // Update the prompt display based on selection even without a chat
             const characters = await fetchCharacters();
             displayActiveSystemPrompt(selectedCharacterId, characters);
        }
        characterPopup.style.display = 'none'; // Close popup after selection
    });

    characterCreateBtn.addEventListener('click', () => {
        openCharacterModal('create');
        characterPopup.style.display = 'none';
    });

    characterEditBtn.addEventListener('click', async () => {
        const characterId = characterSelect.value;
        if (!characterId) return; // Should be disabled, but check anyway

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
                // If the deleted character was active, clear the state
                 if (state.currentCharacterId === characterId) {
                     state.currentCharacterId = null;
                     localStorage.removeItem('lastCharacterId'); // Clear saved selection too
                     // If a chat is loaded, update its character to null
                      if (state.currentChatId) {
                          await fetch(`${API_BASE}/chat/${state.currentChatId}/set_active_character`, {
                               method: 'POST',
                               headers: { 'Content-Type': 'application/json' },
                               body: JSON.stringify({ character_id: null })
                          });
                           // Reload chat to remove prompt banner
                           await loadChat(state.currentChatId);
                      } else {
                           // No chat loaded, just remove the banner
                           displayActiveSystemPrompt(null);
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
        if (!characterBtn.contains(e.target) && !characterPopup.contains(e.target)) {
            characterPopup.style.display = 'none';
        }
    });

    // --- Character Modal Form Handling ---
    characterForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const mode = e.target.dataset.mode;
        const name = document.getElementById('character-name').value.trim();
        const sysprompt = document.getElementById('character-sysprompt').value.trim();
        const characterId = document.getElementById('character-id').value; // Only used in edit mode

        if (!name || !sysprompt) {
            alert('Character Name and System Prompt are required.');
            return;
        }

        const characterData = { character_name: name, sysprompt, settings: {} }; // Settings not used currently

        try {
             let response;
             let newCharacterId = null;
             if (mode === 'create') {
                 console.log("Creating character:", characterData);
                 response = await fetch(`${API_BASE}/chat/create_character`, {
                     method: 'POST',
                     headers: { 'Content-Type': 'application/json' },
                     body: JSON.stringify(characterData)
                 });
                  if (response.ok) {
                     const respData = await response.json();
                     newCharacterId = respData.character_id;
                  }
             } else if (mode === 'edit' && characterId) {
                  console.log(`Updating character ${characterId}:`, characterData);
                 response = await fetch(`${API_BASE}/chat/update_character/${characterId}`, {
                     method: 'PUT',
                     headers: { 'Content-Type': 'application/json' },
                     body: JSON.stringify(characterData)
                 });
             } else {
                  throw new Error("Invalid form mode or missing character ID for edit.");
             }

             if (!response.ok) {
                 const errorData = await response.json().catch(() => ({ detail: response.statusText }));
                 throw new Error(`Failed to ${mode} character: ${errorData.detail || response.statusText}`);
             }

             console.log(`Character ${mode === 'create' ? 'created' : 'updated'} successfully.`);
             characterModal.style.display = 'none'; // Close modal on success
             await populateCharacterSelect(); // Refresh dropdown

             // If editing the currently active character, reload the chat/prompt display
             if (mode === 'edit' && state.currentCharacterId === characterId) {
                  if (state.currentChatId) {
                       await loadChat(state.currentChatId);
                  } else {
                       const characters = await fetchCharacters();
                       displayActiveSystemPrompt(characterId, characters);
                  }
             } else if (mode === 'create' && newCharacterId) {
                  // Optionally select the newly created character?
                   characterSelect.value = newCharacterId;
                   characterSelect.dispatchEvent(new Event('change')); // Trigger change handler to apply it
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
    state.currentChatId = null;
    state.messages = [];
    messagesWrapper.innerHTML = ''; // Clear messages display
    welcomeContainer.style.display = 'flex'; // Show welcome message
    localStorage.removeItem('lastChatId'); // Clear last chat ID
    highlightCurrentChatInSidebar(); // De-select in sidebar
    messageInput.focus();

    // Keep the selected character active for the new chat
    const selectedCharacterId = document.getElementById('character-select').value || null;
    state.currentCharacterId = selectedCharacterId;
     if (selectedCharacterId) {
          // Fetch characters if needed to display prompt banner for new chat
          fetchCharacters().then(characters => {
               displayActiveSystemPrompt(selectedCharacterId, characters);
          });
     } else {
          displayActiveSystemPrompt(null); // Ensure no prompt shown if "No Character" selected
     }

     // Clear file/image previews
     state.currentImages = [];
     state.currentTextFiles = [];
     imagePreviewContainer.innerHTML = '';
     adjustTextareaHeight();
}

async function deleteCurrentChat() {
    if (!state.currentChatId) {
         alert("No chat selected to delete.");
         return;
    }

    const chatPreview = state.chats.find(c => c.chat_id === state.currentChatId)?.preview || `Chat ${state.currentChatId.substring(0,6)}`;
    if (!confirm(`Are you sure you want to permanently delete this chat?\n"${chatPreview}"`)) {
        return;
    }

    console.log(`Deleting chat: ${state.currentChatId}`);

    try {
        const response = await fetch(`${API_BASE}/chat/${state.currentChatId}`, {
            method: 'DELETE'
        });
        if (!response.ok) {
             const errorData = await response.json().catch(() => ({ detail: response.statusText }));
            throw new Error(`Failed to delete chat: ${errorData.detail || response.statusText}`);
        }

        console.log(`Chat ${state.currentChatId} deleted successfully.`);
        const deletedChatId = state.currentChatId; // Store ID before clearing state

        // Go to new chat state
        startNewChat();

        // Remove deleted chat from the list in the UI
        state.chats = state.chats.filter(c => c.chat_id !== deletedChatId);
        renderChatList(); // Re-render sidebar

        // Load the next chat if available? Or stay on new chat? Stay on new chat is simpler.


    } catch (error) {
        console.error('Error deleting chat:', error);
        alert(`Failed to delete chat: ${error.message}`);
        // Optionally add error as system message?
        // addSystemMessage(`Error deleting chat: ${error.message}`, "error");
    }
}


// --- Theme Switcher --- (Largely unchanged, ensure variables match CSS)
function setupThemeSwitch() {
    const settingsBtn = document.getElementById('settings-btn');
    const themeModal = document.getElementById('theme-modal');
    const colorPicker = document.getElementById('accent-color-picker');
    const applyColorBtn = document.getElementById('apply-color');

    // Define themes (ensure these variables are used in style.css)
    const themes = {
        white: {
            '--bg-primary': '#ffffff',
            '--bg-secondary': '#f7f7f7', // Slightly adjusted
            '--bg-tertiary': '#f0f0f0', // Slightly adjusted
            '--text-primary': '#1f2328',
            '--text-secondary': '#57606a', // Adjusted
            '--accent-color': '#0969da', // GitHub blue
            '--accent-hover': '#2c85e9',
            '--error-color': '#d73a49', // GitHub red
            '--message-user': '#f0f0f0',
            '--message-assistant': '#ffffff',
            '--scrollbar-bg': '#f0f0f0',
            '--scrollbar-thumb': '#cccccc',
            '--border-color': '#d0d7de',
            '--code-bg': '#f6f8fa', // Code background
             '--code-text': '#1f2328',
             '--link-color': '#0969da',
        },
        solarized: { // Using Solarized Light values
            '--bg-primary': '#fdf6e3',   // base3
            '--bg-secondary': '#eee8d5', // base2
            '--bg-tertiary': '#e8e1cf',   // Adjusted tertiary
            '--text-primary': '#657b83', // base00
            '--text-secondary': '#839496', // base0
            '--accent-color': '#268bd2', // blue
            '--accent-hover': '#58a6ff', // Lighter blue
            '--error-color': '#dc322f', // red
            '--message-user': '#eee8d5',
            '--message-assistant': '#fdf6e3',
            '--scrollbar-bg': '#eee8d5',
            '--scrollbar-thumb': '#93a1a1', // base01
            '--border-color': '#d9cfb3',   // Adjusted border
            '--code-bg': '#eee8d5',
             '--code-text': '#657b83',
             '--link-color': '#268bd2',
        },
        dark: { // Example dark theme (adjust as needed)
            '--bg-primary': '#0d1117',   // GitHub Dark Dimmed like
            '--bg-secondary': '#161b22',
            '--bg-tertiary': '#21262d',
            '--text-primary': '#c9d1d9',
            '--text-secondary': '#8b949e',
            '--accent-color': '#58a6ff', // GitHub Dark blue
            '--accent-hover': '#79c0ff',
            '--error-color': '#f85149', // GitHub Dark red
            '--message-user': '#1a1f27', // Slightly different user message bg
            '--message-assistant': '#161b22',
            '--scrollbar-bg': '#161b22',
            '--scrollbar-thumb': '#444c56',
            '--border-color': '#30363d',
            '--code-bg': '#161b22',
             '--code-text': '#c9d1d9',
             '--link-color': '#58a6ff',
        }
    };

    function applyTheme(themeName) {
         const theme = themes[themeName] || themes.dark; // Default to dark
         Object.entries(theme).forEach(([prop, value]) => {
             document.documentElement.style.setProperty(prop, value);
         });
         // Update derived RGB color
          updateAccentColorRGB(document.documentElement.style.getPropertyValue('--accent-color'));

         // Update highlight.js theme
         const highlightThemeLink = document.getElementById('highlight-theme');
         if (themeName === 'white') {
             highlightThemeLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css';
         } else if (themeName === 'solarized') {
             // Using light version, map solarized theme name to appropriate CSS
              highlightThemeLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/solarized-light.min.css';
         } else { // dark theme
             highlightThemeLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark-dimmed.min.css'; // Or another dark theme
         }

         // Re-highlight existing code blocks after theme change
          setTimeout(() => { // Timeout ensures CSS is applied
              messagesWrapper.querySelectorAll('pre code').forEach(block => {
                   try {
                        const preElement = block.parentElement;
                        if (preElement && preElement.tagName === 'PRE') {
                            // Check if it needs wrapping or just re-highlighting
                             if (!preElement.closest('.code-block-wrapper')) {
                                const codeText = block.textContent;
                                const langClass = block.className.split(' ').find(cls => cls.startsWith('language-'));
                                const lang = langClass ? langClass.substring(9) : '';
                                const wrapper = createCodeBlockWithContent(codeText, lang); // Use updated function
                                preElement.replaceWith(wrapper);
                            } else {
                                // Already wrapped, just re-highlight the block
                                hljs.highlightElement(block);
                            }
                        }
                   } catch (e) { console.error("Error re-highlighting:", e); }
              });
          }, 100);

         localStorage.setItem('theme', themeName);
         console.log(`Theme applied: ${themeName}`);
    }

    function setAccentColor(colorValue) {
        if (!colorValue) return;
         document.documentElement.style.setProperty('--accent-color', colorValue);
         updateAccentColorRGB(colorValue);
         // Calculate hover color (e.g., slightly lighter/brighter)
          const hoverColor = lightenColor(colorValue, 0.15); // Adjust lighten factor as needed
         document.documentElement.style.setProperty('--accent-hover', hoverColor);
         document.documentElement.style.setProperty('--link-color', colorValue); // Update link color too
         localStorage.setItem('accentColor', colorValue);
         console.log(`Accent color set to: ${colorValue}`);
    }

     function updateAccentColorRGB(hexColor) {
         if (!hexColor || !hexColor.startsWith('#')) return;
         const cleanHex = hexColor.substring(1);
         if (cleanHex.length !== 6 && cleanHex.length !== 3) return; // Basic validation

          let r = 0, g = 0, b = 0;
          if (cleanHex.length === 3) {
              r = parseInt(cleanHex[0] + cleanHex[0], 16);
              g = parseInt(cleanHex[1] + cleanHex[1], 16);
              b = parseInt(cleanHex[2] + cleanHex[2], 16);
          } else {
              r = parseInt(cleanHex.substring(0, 2), 16);
              g = parseInt(cleanHex.substring(2, 4), 16);
              b = parseInt(cleanHex.substring(4, 6), 16);
          }
          if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
             document.documentElement.style.setProperty('--accent-color-rgb', `${r}, ${g}, ${b}`);
          }
     }

    function lightenColor(hex, factor) {
         if (!hex || !hex.startsWith('#')) return hex; // Return original if invalid
         let cleanHex = hex.substring(1);
          if (cleanHex.length === 3) {
              cleanHex = cleanHex[0] + cleanHex[0] + cleanHex[1] + cleanHex[1] + cleanHex[2] + cleanHex[2];
          }
          if (cleanHex.length !== 6) return hex;

         try {
             let r = parseInt(cleanHex.substring(0, 2), 16);
             let g = parseInt(cleanHex.substring(2, 4), 16);
             let b = parseInt(cleanHex.substring(4, 6), 16);

             r = Math.min(255, Math.round(r + (255 - r) * factor));
             g = Math.min(255, Math.round(g + (255 - g) * factor));
             b = Math.min(255, Math.round(b + (255 - b) * factor));

             return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
         } catch (e) {
             console.error("Error lightening color:", e);
             return hex; // Return original on error
         }
    }

    // --- Event Listeners for Theme Modal ---
    settingsBtn.addEventListener('click', (e) => {
        themeModal.style.display = 'flex';
        e.stopPropagation();
    });

    document.querySelectorAll('.theme-option[data-theme]').forEach(button => {
        button.addEventListener('click', () => {
            applyTheme(button.dataset.theme);
        });
    });

    applyColorBtn.addEventListener('click', () => {
        setAccentColor(colorPicker.value);
        // Optionally close modal after applying
        // themeModal.style.display = 'none';
    });

    document.querySelectorAll('.theme-preset').forEach(preset => {
        preset.addEventListener('click', () => {
            const color = preset.dataset.color;
            colorPicker.value = color; // Update picker value
            setAccentColor(color); // Apply the color
        });
    });

    // Close modal on background click
    themeModal.addEventListener('click', (e) => {
        if (e.target === themeModal) {
            themeModal.style.display = 'none';
        }
    });

    // Apply saved theme and color on initial load
    const savedTheme = localStorage.getItem('theme') || 'dark'; // Default to dark
    applyTheme(savedTheme);
    const savedColor = localStorage.getItem('accentColor');
    if (savedColor) {
        colorPicker.value = savedColor; // Set picker value
        setAccentColor(savedColor); // Apply saved color
    } else {
         // If no saved color, apply the default accent of the loaded theme
         setAccentColor(document.documentElement.style.getPropertyValue('--accent-color'));
    }
}

// Add System Message utility (for frontend errors/info)
function addSystemMessage(text, type = "info") { // type can be 'info', 'error', 'warning'
     console.log(`System Message [${type}]: ${text}`);
     const messageRow = document.createElement('div');
     // Use distinct classes, not reusing message-row system-row if that's removed
     messageRow.className = `system-info-row ${type}`;
     messageRow.style.cssText = `
        padding: 8px 20px; /* Adjust padding */
        margin: 5px auto; /* Center with auto margins */
        max-width: 800px; /* Match message width */
        border-radius: var(--border-radius-md);
        background-color: ${type === 'error' ? 'rgba(229, 62, 62, 0.2)' : 'rgba(var(--accent-color-rgb), 0.1)'};
        color: ${type === 'error' ? 'var(--error-color)' : 'var(--text-secondary)'};
        border: 1px solid ${type === 'error' ? 'var(--error-color)' : 'var(--border-color)'};
        font-size: 0.9em;
     `;

     messageRow.innerHTML = `<i class="bi bi-${type === 'error' ? 'exclamation-octagon-fill' : 'info-circle-fill'}"></i> ${text}`; // Add icon

     messagesWrapper.appendChild(messageRow);
     scrollToBottom(); // Scroll to show the message
}

// Scroll Utility
function scrollToBottom(behavior = 'auto') { // 'smooth' or 'auto'
     // Debounce or throttle this if called very frequently? Not strictly necessary yet.
     requestAnimationFrame(() => {
         // Check if the container exists before scrolling
         if (chatContainer) {
             chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: behavior });
         }
     });
}


// Start the Application
document.addEventListener('DOMContentLoaded', () => {
    init(); // Init will call applySidebarState internally now
});