const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatSendButton = document.getElementById("chatSendButton");
const chatMessages = document.getElementById("chatMessages");
const chatQuotaLabel = document.getElementById("chatQuota");
const chatAccessMessage = document.getElementById("chatAccessMessage");
const userEmail = document.getElementById("userEmail");
const logoutButton = document.getElementById("logoutButton");
const upgradeLink = document.getElementById("upgradeLink");
const newChatButton = document.getElementById("newChatButton");
const recentChats = document.getElementById("recentChats");
const recentStatus = document.getElementById("recentStatus");
const conversationTitle = document.getElementById("conversationTitle");

let currentUser = null;
let chatQuota = null;
let chatPending = false;
let currentConversationId = null;

function redirectToLogin() {
    const nextPage = window.location.pathname + window.location.search;
    window.location.replace("/login.html?next=" + encodeURIComponent(nextPage));
}

function renderChatControls() {
    const hasUser = Boolean(currentUser);
    const hasQuota = Boolean(chatQuota);
    const unlimited = hasQuota && chatQuota.unlimited;
    const limitReached = hasQuota && !unlimited && chatQuota.remaining === 0;
    upgradeLink.hidden = unlimited;
    logoutButton.hidden = !hasUser;
    chatInput.disabled = !hasUser || !hasQuota || limitReached || chatPending;
    chatSendButton.disabled = chatInput.disabled;
    newChatButton.disabled = !hasUser || chatPending;

    if (!hasUser) {
        chatAccessMessage.textContent = "Sign in to start chatting.";
        chatQuotaLabel.textContent = "";
    } else if (!hasQuota) {
        chatAccessMessage.textContent = "Loading your chat access...";
        chatQuotaLabel.textContent = "";
    } else if (unlimited) {
        chatAccessMessage.textContent = "Your one-time purchase includes unlimited chat.";
    } else if (limitReached) {
        const resetTime = chatQuota.resetsAt
            ? new Date(chatQuota.resetsAt).toLocaleString()
            : "soon";
        chatAccessMessage.textContent = "You have used all 100 free prompts. Your limit resets " + resetTime + ".";
    } else {
        chatAccessMessage.textContent = "You can send " + chatQuota.remaining + " more free prompts.";
    }
}

function setUser(user) {
    currentUser = user;
    chatQuota = null;
    userEmail.hidden = !user;
    userEmail.textContent = user ? user.email : "";
    renderChatControls();
}

function updateChatQuota(usage) {
    chatQuota = usage;
    if (usage.unlimited) {
        chatQuotaLabel.textContent = "Unlimited chat access";
    } else if (usage.used === 0) {
        chatQuotaLabel.textContent = usage.limit + " free prompts. The 72-hour timer starts with your first prompt.";
    }
    renderChatControls();
}

function clearConversation(message) {
    chatMessages.replaceChildren();
    const emptyState = document.createElement("p");
    emptyState.className = "chat-empty";
    emptyState.textContent = message || "What would you like to talk about?";
    chatMessages.appendChild(emptyState);
}

function appendChatMessage(message, role) {
    const emptyState = chatMessages.querySelector(".chat-empty");
    if (emptyState) {
        emptyState.remove();
    }

    const bubble = document.createElement("div");
    bubble.className = "chat-message chat-message-" + role;
    bubble.textContent = message;
    chatMessages.appendChild(bubble);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function readJson(response) {
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || "Request failed.");
    }
    return data;
}

async function loadChatQuota() {
    const data = await readJson(await fetch("/api/chat/quota"));
    updateChatQuota(data);
}

async function loadConversationList() {
    const data = await readJson(await fetch("/api/chat/conversations"));
    recentChats.replaceChildren();
    recentStatus.textContent = data.conversations.length ? "" : "Your recent chats will appear here.";

    for (const conversation of data.conversations) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "recent-chat";
        button.textContent = conversation.title;
        button.title = conversation.title;
        button.dataset.conversationId = conversation.id;
        button.classList.toggle("active", conversation.id === currentConversationId);
        button.addEventListener("click", () => loadConversation(conversation.id));
        recentChats.appendChild(button);
    }
}

async function loadConversation(id, force) {
    if (chatPending && !force) {
        return;
    }
    chatAccessMessage.textContent = "";
    try {
        const data = await readJson(await fetch("/api/chat/conversations/" + encodeURIComponent(id)));
        currentConversationId = data.conversation.id;
        conversationTitle.textContent = data.conversation.title;
        clearConversation(data.conversation.messages.length ? "" : "What would you like to talk about?");
        for (const message of data.conversation.messages) {
            appendChatMessage(message.text, message.role === "user" ? "user" : "assistant");
        }
        history.replaceState(null, "", "/chat.html?chat=" + encodeURIComponent(currentConversationId));
        await loadConversationList();
        chatMessages.scrollTop = chatMessages.scrollHeight;
    } catch (error) {
        chatAccessMessage.textContent = error.message;
    }
}

function startNewChat() {
    if (chatPending) {
        return;
    }
    currentConversationId = null;
    conversationTitle.textContent = "New chat";
    clearConversation();
    chatAccessMessage.textContent = "";
    history.replaceState(null, "", "/chat.html");
    for (const button of recentChats.querySelectorAll(".recent-chat")) {
        button.classList.remove("active");
    }
    chatInput.focus();
}

async function createConversation() {
    const data = await readJson(await fetch("/api/chat/conversations", { method: "POST" }));
    currentConversationId = data.conversation.id;
    conversationTitle.textContent = data.conversation.title;
    history.replaceState(null, "", "/chat.html?chat=" + encodeURIComponent(currentConversationId));
    return currentConversationId;
}

async function refreshAuthState() {
    const response = await fetch("/api/auth/me");
    let data;
    try {
        data = await response.json();
    } catch {
        throw new Error("Could not check your account.");
    }
    if (response.status === 401) {
        redirectToLogin();
        return;
    }
    if (!response.ok) {
        throw new Error(data.error || "Could not check your account.");
    }

    setUser(data.user);
    await Promise.all([loadChatQuota(), loadConversationList()]);
    const conversationId = new URLSearchParams(window.location.search).get("chat");
    if (conversationId) {
        await loadConversation(conversationId);
    } else {
        const firstChat = recentChats.querySelector(".recent-chat");
        if (firstChat) {
            await loadConversation(firstChat.dataset.conversationId);
        } else {
            startNewChat();
        }
    }
}

newChatButton.addEventListener("click", startNewChat);

logoutButton.addEventListener("click", async () => {
    try {
        const response = await fetch("/api/auth/logout", { method: "POST" });
        await readJson(response);
        window.location.assign("/");
    } catch (error) {
        chatAccessMessage.textContent = error.message;
    }
});

// Listen for keydown events on the chat textarea
chatInput.addEventListener("keydown", function(event) {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        chatForm.requestSubmit();
    }
});

// --- File & Attachment State Variables ---
const attachButton = document.getElementById("attachButton");
const fileInput = document.getElementById("fileInput");
const fileAttachmentPreview = document.getElementById("fileAttachmentPreview");
const fileNameText = document.getElementById("fileNameText");
const removeFileBtn = document.getElementById("removeFileBtn");

let attachedFileContent = null;
let attachedFileName = null;

attachButton.addEventListener("click", () => {
    fileInput.click();
});
fileInput.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;

    // Check if user is restricted by file quota
    const hasQuota = Boolean(chatQuota);
    const unlimited = hasQuota && chatQuota.unlimited;
    
    // If you track files uploaded today in chatQuota object from backend:
    // const filesToday = chatQuota.filesToday || 0;
    // if (!unlimited && filesToday >= 10) {
    //     alert("You have reached your 10 free file uploads for today. Upgrade for unlimited file uploads!");
    //     fileInput.value = "";
    //     return;
    // }

    attachedFileName = file.name;
    const reader = new FileReader();

    reader.onload = function(e) {
        attachedFileContent = e.target.result;
        fileNameText.textContent = `📄 ${attachedFileName}`;
        fileAttachmentPreview.style.display = "inline-flex";
        chatInput.required = false;
        chatSendButton.disabled = false;
    };

    if (file.type.startsWith("text/") || file.name.match(/\.(js|py|html|css|json|md|txt|csv)$/i)) {
        reader.readAsText(file);
    } else {
        reader.readAsDataURL(file);
    }
});

removeFileBtn.addEventListener("click", () => {
    clearAttachedFile();
});

function clearAttachedFile() {
    attachedFileContent = null;
    attachedFileName = null;
    fileInput.value = "";
    fileAttachmentPreview.style.display = "none";
    chatInput.required = true;
}


// --- Voice-to-Text (Microphone) Logic ---
const micButton = document.getElementById("micButton");
let recognition = null;

if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
        micButton.classList.add("recording");
        micButton.title = "Listening... Speak now";
        chatInput.placeholder = "Listening for voice note...";
    };

    recognition.onresult = (event) => {
        let transcript = "";
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            transcript += event.results[i][0].transcript;
        }
        chatInput.value = transcript;
    };

    recognition.onerror = (event) => {
        console.error("Speech recognition error", event.error);
        stopMic();
    };

    recognition.onend = () => {
        stopMic();
    };
} else {
    micButton.style.display = "none";
}

function stopMic() {
    micButton.classList.remove("recording");
    micButton.title = "Voice note";
    chatInput.placeholder = "Message GEMA AI...";
}

micButton.addEventListener("click", () => {
    if (!recognition) {
        alert("Speech recognition is not supported in your browser.");
        return;
    }
    if (micButton.classList.contains("recording")) {
        recognition.stop();
        stopMic();
    } else {
        chatInput.value = "";
        recognition.start();
    }
});


// --- Form Submit Handler (Properly Nested) ---
chatForm.addEventListener("submit", async event => {
    event.preventDefault();
    
    const userTypedText = chatInput.value.trim();
    if (!userTypedText && !attachedFileContent) return;

    if (!currentUser
        || !chatQuota
        || (!chatQuota.unlimited && chatQuota.remaining === 0)
        || chatPending) {
        return;
    }

    // Build final message payload including attached file content if present
    const messageToSend = attachedFileContent
        ? `[Attached File: ${attachedFileName}]\n\`\`\`\n${attachedFileContent}\n\`\`\`\n\n${userTypedText || "Please read and analyze this file."}`
        : userTypedText;

    chatPending = true;
    appendChatMessage(userTypedText || `[Attached File: ${attachedFileName}]`, "user");
    
    // Reset input box and clear attachment preview chip
    chatInput.value = "";
    clearAttachedFile();
    renderChatControls();

    try {
        const conversationId = currentConversationId || await createConversation();
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: messageToSend, conversationId })
        });
        const data = await response.json();
        if (data.usage) {
            updateChatQuota(data.usage);
        }
        if (!response.ok) {
            throw new Error(data.error || "Could not send your message.");
        }
        conversationTitle.textContent = data.conversation.title;
        appendChatMessage(data.message, "assistant");
        try {
            await loadConversationList();
        } catch (error) {
            recentStatus.textContent = error.message;
        }
        try {
            await loadChatQuota();
        } catch (error) {
            chatAccessMessage.textContent = error.message;
        }
    } catch (error) {
        let submitError = error.message;
        if (currentConversationId) {
            await loadConversation(currentConversationId, true);
        }
        try {
            await loadChatQuota();
        } catch (quotaError) {
            submitError += " " + quotaError.message;
        }
        chatAccessMessage.textContent = submitError;
    } finally {
        chatPending = false;
        renderChatControls();
        if (!chatInput.disabled) {
            chatInput.focus();
        }
    }
});

refreshAuthState().catch(error => {
    setUser(null);
    chatAccessMessage.textContent = error.message;
});

renderChatControls();


// Mobile menu toggle handling
const mobileMenuToggle = document.getElementById("mobileMenuToggle");
const sidebar = document.querySelector(".sidebar");

if (mobileMenuToggle && sidebar) {
    mobileMenuToggle.addEventListener("click", () => {
        sidebar.classList.toggle("mobile-open");
    });

    newChatButton.addEventListener("click", () => {
        sidebar.classList.remove("mobile-open");
    });

    recentChats.addEventListener("click", (e) => {
        if (e.target.classList.contains("recent-chat")) {
            sidebar.classList.remove("mobile-open");
        }
    });
}