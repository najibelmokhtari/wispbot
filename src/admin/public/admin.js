const BASE = window.__basePath || '';

// Toast notification
function showToast(message, type) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.className = 'toast ' + type + ' show';
    setTimeout(() => { toast.className = 'toast'; }, 3000);
}

// Toggle a boolean setting for a group
async function toggleSetting(el) {
    const groupId = el.dataset.group;
    const field = el.dataset.field;
    const value = el.checked ? 1 : 0;
    try {
        const res = await fetch(`${BASE}/api/groups/${encodeURIComponent(groupId)}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [field]: value })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(`${field.replace(/_/g, ' ')} ${value ? 'enabled' : 'disabled'}`, 'success');
        // Show/hide dependent settings sections
        if (field === 'audio_enabled') {
            const section = document.getElementById('audio-settings-section');
            if (section) section.style.display = value ? '' : 'none';
        }
        if (field === 'tts_enabled') {
            const section = document.getElementById('tts-settings-section');
            if (section) section.style.display = value ? '' : 'none';
        }
    } catch (e) {
        el.checked = !el.checked; // revert
        showToast('Failed to update setting', 'error');
    }
}

// Update a dropdown setting for a group
async function updateDropdown(el, field) {
    const groupId = el.dataset.group;
    const value = el.value;
    try {
        const res = await fetch(`${BASE}/api/groups/${encodeURIComponent(groupId)}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [field]: value })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(`${field.replace(/_/g, ' ')} updated to ${value}`, 'success');
        // If persona changed, update the Edit Persona link
        if (field === 'default_prompt_name') {
            const editLink = document.getElementById('edit-persona-link');
            if (editLink) {
                editLink.href = `${BASE}/settings#persona-${value}`;
                editLink.style.display = value === 'default' ? 'none' : '';
            }
        }
    } catch (e) {
        showToast('Failed to update setting', 'error');
    }
}

// Save group name
async function saveGroupName(groupId) {
    const name = document.getElementById('group-name-input').value.trim();
    try {
        const res = await fetch(`${BASE}/api/groups/${encodeURIComponent(groupId)}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ group_name: name })
        });
        if (!res.ok) throw new Error('Failed');
        showToast('Group name saved', 'success');
    } catch (e) {
        showToast('Failed to save group name', 'error');
    }
}

// Save group debounce time
async function saveGroupDebounce(groupId) {
    const val = document.getElementById('bg-debounce-input').value.trim();
    const ms = val ? parseInt(val) * 1000 : null;
    try {
        const res = await fetch(`${BASE}/api/groups/${encodeURIComponent(groupId)}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ background_debounce_ms: ms })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(val ? `Debounce set to ${val}s` : 'Debounce reset to default', 'success');
    } catch (e) {
        showToast('Failed to save debounce setting', 'error');
    }
}

// Save group message threshold
async function saveGroupThreshold(groupId) {
    const val = document.getElementById('bg-threshold-input').value.trim();
    const threshold = val ? parseInt(val) : null;
    try {
        const res = await fetch(`${BASE}/api/groups/${encodeURIComponent(groupId)}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ background_message_threshold: threshold })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(val ? `Threshold set to ${val} messages` : 'Threshold reset to default', 'success');
    } catch (e) {
        showToast('Failed to save threshold setting', 'error');
    }
}

// Save default debounce time (settings page)
async function saveDefaultDebounce() {
    const val = document.getElementById('default-bg-debounce').value.trim();
    const ms = val ? String(parseInt(val) * 1000) : '';
    try {
        const res = await fetch(`${BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ default_background_debounce_ms: ms })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(val ? `Default debounce set to ${val}s` : 'Default debounce cleared', 'success');
    } catch (e) {
        showToast('Failed to save default debounce', 'error');
    }
}

// Save default message history limit (settings page)
async function saveDefaultHistoryLimit() {
    const val = document.getElementById('default-history-limit').value.trim();
    if (!val) return showToast('Enter a history limit', 'error');
    try {
        const res = await fetch(`${BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ default_message_history_limit: val })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(`Default history limit set to ${val} messages`, 'success');
    } catch (e) {
        showToast('Failed to save default history limit', 'error');
    }
}

// Save default message threshold (settings page)
async function saveDefaultThreshold() {
    const val = document.getElementById('default-bg-threshold').value.trim();
    try {
        const res = await fetch(`${BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ default_background_message_threshold: val })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(val ? `Default threshold set to ${val} messages` : 'Default threshold cleared', 'success');
    } catch (e) {
        showToast('Failed to save default threshold', 'error');
    }
}

// Save group message history limit
async function saveHistoryLimit(groupId) {
    const val = document.getElementById('history-limit-input').value.trim();
    const limit = val ? parseInt(val) : null;
    try {
        const res = await fetch(`${BASE}/api/groups/${encodeURIComponent(groupId)}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ custom_message_limit: limit })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(val ? `History limit set to ${val} messages` : 'History limit reset to default', 'success');
    } catch (e) {
        showToast('Failed to save history limit', 'error');
    }
}

// Save group audio history count
async function saveAudioHistoryCount(groupId) {
    const val = document.getElementById('audio-history-count-input').value.trim();
    const count = val ? parseInt(val) : 1;
    try {
        const res = await fetch(`${BASE}/api/groups/${encodeURIComponent(groupId)}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audio_history_count: count })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(val ? `Audio history count set to ${val}` : 'Audio history count reset to default', 'success');
    } catch (e) {
        showToast('Failed to save audio history count', 'error');
    }
}

// Save group audio duration cap
async function saveAudioDurationCap(groupId) {
    const val = document.getElementById('audio-duration-cap-input').value.trim();
    const cap = val !== '' ? parseInt(val) : null;
    try {
        const res = await fetch(`${BASE}/api/groups/${encodeURIComponent(groupId)}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audio_duration_cap: cap })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(val !== '' ? `Audio duration cap set to ${val}s` : 'Audio duration cap reset to default', 'success');
    } catch (e) {
        showToast('Failed to save audio duration cap', 'error');
    }
}

// Toggle audio history count visibility based on mode
function toggleAudioHistoryCount() {
    const mode = document.getElementById('select-audio-mode');
    const container = document.getElementById('audio-history-count-container');
    if (mode && container) {
        container.style.display = mode.value === 'history' ? '' : 'none';
    }
}

// Save group context
async function saveContext(groupId) {
    const content = document.getElementById('context-editor').value;
    try {
        const res = await fetch(`${BASE}/api/groups/${encodeURIComponent(groupId)}/context`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
        if (!res.ok) throw new Error('Failed');
        showToast('Context saved', 'success');
    } catch (e) {
        showToast('Failed to save context', 'error');
    }
}

// Save group memories
async function saveMemories(groupId) {
    const content = document.getElementById('memories-editor').value;
    try {
        const res = await fetch(`${BASE}/api/groups/${encodeURIComponent(groupId)}/memories`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
        if (!res.ok) throw new Error('Failed');
        showToast('Memories saved', 'success');
    } catch (e) {
        showToast('Failed to save memories', 'error');
    }
}

// --- Settings page functions ---

// Save bot display name
async function saveBotName() {
    const name = document.getElementById('bot-name-input').value.trim();
    if (!name) return showToast('Enter a bot name', 'error');
    if (name.length > 25) return showToast('Bot name must be 25 characters or less', 'error');
    try {
        const res = await fetch(`${BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bot_name: name })
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Failed');
        }
        showToast('Bot name saved', 'success');
    } catch (e) {
        showToast(e.message || 'Failed to save bot name', 'error');
    }
}

async function saveTtsTrigger() {
    const trigger = document.getElementById('tts-trigger-input').value.trim();
    if (!trigger) return showToast('Enter a Text-To-Speech trigger tag', 'error');
    try {
        const res = await fetch(`${BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tts_trigger: trigger })
        });
        if (!res.ok) throw new Error('Failed');
        showToast('TTS trigger saved', 'success');
    } catch (e) {
        showToast('Failed to save TTS trigger', 'error');
    }
}

// Save default audio history count (settings page)
async function saveDefaultAudioHistoryCount() {
    const val = document.getElementById('default-audio-history-count').value.trim();
    if (!val) return showToast('Enter an audio history count', 'error');
    try {
        const res = await fetch(`${BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ default_audio_history_count: val })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(`Default audio history count set to ${val}`, 'success');
    } catch (e) {
        showToast('Failed to save default audio history count', 'error');
    }
}

// Save default audio duration cap (settings page)
async function saveDefaultAudioDurationCap() {
    const val = document.getElementById('default-audio-duration-cap').value.trim();
    if (val === '') return showToast('Enter an audio duration cap', 'error');
    try {
        const res = await fetch(`${BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ default_audio_duration_cap: val })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(parseInt(val) === 0 ? 'Default audio duration cap disabled (no limit)' : `Default audio duration cap set to ${val}s`, 'success');
    } catch (e) {
        showToast('Failed to save default audio duration cap', 'error');
    }
}

// Toggle default audio history count visibility based on mode (settings page)
function toggleDefaultAudioHistoryCount() {
    const mode = document.getElementById('default-audio-history-mode');
    const container = document.getElementById('default-audio-history-count-container');
    if (mode && container) {
        container.style.display = mode.value === 'history' ? '' : 'none';
    }
}

// Update a default toggle setting
async function updateDefaultToggle(field, checked) {
    try {
        const res = await fetch(`${BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [field]: checked ? '1' : '0' })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(`${field.replace(/^default_/, '').replace(/_/g, ' ')} ${checked ? 'enabled' : 'disabled'}`, 'success');
    } catch (e) {
        showToast('Failed to update setting', 'error');
    }
}

// Update a default dropdown setting
async function updateDefaultDropdown(field, value) {
    try {
        const res = await fetch(`${BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [field]: value })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(`${field.replace(/^default_/, '').replace(/_/g, ' ')} updated to ${value}`, 'success');
        // If default persona changed, update the Edit Persona link
        if (field === 'default_persona') {
            const editLink = document.getElementById('edit-default-persona-link');
            if (editLink) {
                editLink.href = `#persona-${value}`;
                editLink.style.display = value === 'default' ? 'none' : '';
            }
        }
    } catch (e) {
        showToast('Failed to update setting', 'error');
    }
}

// Load persona content when a details element is toggled open
async function loadPersonaContent(name) {
    const textarea = document.getElementById('persona-content-' + name);
    const alreadyLoaded = textarea ? textarea.dataset.loaded : false;

    // Load persona prompt (skip for 'default' which has no prompt textarea)
    if (textarea && !alreadyLoaded) {
        try {
            const res = await fetch(`${BASE}/api/personas/${encodeURIComponent(name)}`);
            if (!res.ok) throw new Error('Failed');
            const data = await res.json();
            textarea.value = data.content;
            textarea.dataset.loaded = '1';
        } catch (e) {
            textarea.value = 'Failed to load persona content.';
        }
    }

    // Load TTS settings (voice + style prompt)
    const voiceSelect = document.getElementById('persona-tts-voice-' + name);
    const styleTextarea = document.getElementById('persona-tts-style-' + name);
    if (styleTextarea && !styleTextarea.dataset.loaded) {
        try {
            const res = await fetch(`${BASE}/api/personas/${encodeURIComponent(name)}/tts`);
            if (!res.ok) throw new Error('Failed');
            const data = await res.json();
            if (voiceSelect) voiceSelect.value = data.voice || '';
            styleTextarea.value = data.stylePrompt || '';
            styleTextarea.dataset.loaded = '1';
        } catch (e) {
            styleTextarea.value = 'Failed to load TTS style prompt.';
        }
    }
}

// Save persona from settings page
async function savePersonaFromSettings(name) {
    const textarea = document.getElementById('persona-content-' + name);
    if (!textarea) return;
    try {
        const res = await fetch(`${BASE}/api/personas/${encodeURIComponent(name)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: textarea.value })
        });
        if (!res.ok) throw new Error('Failed');
        showToast('Persona prompt saved', 'success');
    } catch (e) {
        showToast('Failed to save persona', 'error');
    }
}

// Save persona TTS voice
async function savePersonaTtsVoice(name, voice) {
    try {
        const res = await fetch(`${BASE}/api/personas/${encodeURIComponent(name)}/tts/voice`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ voice })
        });
        if (!res.ok) throw new Error('Failed');
        showToast('TTS voice saved', 'success');
    } catch (e) {
        showToast('Failed to save TTS voice', 'error');
    }
}

// Save persona TTS style prompt
async function savePersonaTtsStyle(name) {
    const textarea = document.getElementById('persona-tts-style-' + name);
    if (!textarea) return;
    try {
        const res = await fetch(`${BASE}/api/personas/${encodeURIComponent(name)}/tts/style`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: textarea.value })
        });
        if (!res.ok) throw new Error('Failed');
        showToast('TTS style prompt saved', 'success');
    } catch (e) {
        showToast('Failed to save TTS style prompt', 'error');
    }
}

// Load system prompt content when a details element is toggled open
async function loadSystemPrompt(name) {
    const textarea = document.getElementById('sysprompt-content-' + name);
    if (!textarea || textarea.dataset.loaded) return;
    try {
        const res = await fetch(`${BASE}/api/system-prompts/${encodeURIComponent(name)}`);
        if (!res.ok) throw new Error('Failed');
        const data = await res.json();
        textarea.value = data.content;
        textarea.dataset.loaded = '1';
    } catch (e) {
        textarea.value = 'Failed to load system prompt.';
    }
}

// Save system prompt
async function saveSystemPrompt(name) {
    const textarea = document.getElementById('sysprompt-content-' + name);
    if (!textarea) return;
    try {
        const res = await fetch(`${BASE}/api/system-prompts/${encodeURIComponent(name)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: textarea.value })
        });
        if (!res.ok) throw new Error('Failed');
        showToast('System prompt saved', 'success');
    } catch (e) {
        showToast('Failed to save system prompt', 'error');
    }
}

// Create new persona
async function createNewPersona() {
    const nameInput = document.getElementById('new-persona-name');
    const contentTextarea = document.getElementById('new-persona-content');
    const name = nameInput.value.trim().toLowerCase();
    if (!name) return showToast('Enter a persona name', 'error');
    if (!/^[a-z0-9_]+$/.test(name)) return showToast('Name must be lowercase letters, numbers, underscores only', 'error');
    if (name.length > 30) return showToast('Name must be 30 characters or less', 'error');
    if (name === 'default') return showToast('Cannot overwrite the default persona', 'error');
    const content = contentTextarea.value.trim();
    if (!content) return showToast('Enter persona content', 'error');
    // Check if persona already exists
    const existing = document.getElementById('persona-detail-' + name);
    if (existing && !confirm(`Persona "${name}" already exists. Overwrite it?`)) return;
    try {
        const res = await fetch(`${BASE}/api/personas/${encodeURIComponent(name)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Failed');
        }
        showToast('Persona created', 'success');
        setTimeout(() => location.reload(), 500);
    } catch (e) {
        showToast('Failed to create persona', 'error');
    }
}

// Delete persona
async function deletePersona(name) {
    if (!confirm(`Delete persona "${name}"? This cannot be undone.`)) return;
    try {
        const res = await fetch(`${BASE}/api/personas/${encodeURIComponent(name)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed');
        showToast('Persona deleted', 'success');
        setTimeout(() => location.reload(), 500);
    } catch (e) {
        showToast('Failed to delete persona', 'error');
    }
}


// Add user (authorized or admin)
async function addUser(type) {
    const inputId = type === 'authorized' ? 'add-authorized-input' : 'add-admin-input';
    let userId = document.getElementById(inputId).value.trim();
    if (!userId) return showToast('Enter a phone number', 'error');
    // Strip leading + and auto-append @c.us if the user entered a phone number
    userId = userId.replace(/^\+/, '');
    if (/^\d+$/.test(userId)) userId = userId + '@c.us';
    const endpoint = type === 'authorized' ? `${BASE}/api/authorized-users` : `${BASE}/api/admin-users`;
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId })
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Failed');
        }
        document.getElementById(inputId).value = '';
        showToast('User added', 'success');
        setTimeout(() => location.reload(), 500);
    } catch (e) {
        showToast('Failed to add user', 'error');
    }
}

// Remove user (authorized or admin)
async function removeUser(type, userId) {
    if (!confirm(`Remove ${userId}?`)) return;
    const endpoint = type === 'authorized' ? `${BASE}/api/authorized-users` : `${BASE}/api/admin-users`;
    try {
        const res = await fetch(`${endpoint}/${encodeURIComponent(userId)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed');
        showToast('User removed', 'success');
        setTimeout(() => location.reload(), 500);
    } catch (e) {
        showToast('Failed to remove user', 'error');
    }
}

// Accept add request
async function acceptRequest(userId) {
    try {
        const res = await fetch(`${BASE}/api/add-requests/${encodeURIComponent(userId)}/accept`, { method: 'POST' });
        if (!res.ok) throw new Error('Failed');
        showToast('Request accepted', 'success');
        setTimeout(() => location.reload(), 500);
    } catch (e) {
        showToast('Failed to accept request', 'error');
    }
}

// Reject add request
async function rejectRequest(userId) {
    if (!confirm(`Reject request from ${userId}?`)) return;
    try {
        const res = await fetch(`${BASE}/api/add-requests/${encodeURIComponent(userId)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed');
        showToast('Request rejected', 'success');
        setTimeout(() => location.reload(), 500);
    } catch (e) {
        showToast('Failed to reject request', 'error');
    }
}

// Accept all add requests
async function acceptAllRequests() {
    if (!confirm('Accept all pending requests?')) return;
    try {
        const res = await fetch(`${BASE}/api/add-requests/accept-all`, { method: 'POST' });
        if (!res.ok) throw new Error('Failed');
        const data = await res.json();
        showToast(`Accepted ${data.count} requests`, 'success');
        setTimeout(() => location.reload(), 500);
    } catch (e) {
        showToast('Failed to accept all requests', 'error');
    }
}

// Search known users
let searchTimeout;
async function searchUsers(query) {
    clearTimeout(searchTimeout);
    const container = document.getElementById('search-results');
    if (!container) return;
    if (!query.trim()) { container.innerHTML = ''; return; }
    searchTimeout = setTimeout(async () => {
        try {
            const res = await fetch(`${BASE}/api/known-users?q=${encodeURIComponent(query)}`);
            const users = await res.json();
            if (users.length === 0) {
                container.innerHTML = '<p><small>No users found.</small></p>';
                return;
            }
            let html = '<table><thead><tr><th>Phone</th><th>WhatsApp Name</th><th>Alias</th></tr></thead><tbody>';
            for (const u of users) {
                html += `<tr>
                    <td><small>${u.user_id.replace(/@c\.us$/, '')}</small></td>
                    <td>${u.whatsapp_name || '-'}</td>
                    <td>${u.custom_alias || '-'}</td>
                </tr>`;
            }
            html += '</tbody></table>';
            container.innerHTML = html;
        } catch (e) {
            container.innerHTML = '<p><small>Search failed.</small></p>';
        }
    }, 300);
}

// Connect the WhatsApp bot
async function connectBot() {
    var btn = document.getElementById('connect-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Connecting...'; }
    try {
        var res = await fetch(BASE + '/api/connection/connect', { method: 'POST' });
        if (!res.ok) {
            var data = await res.json();
            throw new Error(data.error || 'Failed');
        }
        showToast('Reconnecting...', 'success');
    } catch (e) {
        showToast(e.message || 'Failed to connect', 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Connect'; }
    }
}

// Disconnect the WhatsApp bot
async function disconnectBot() {
    if (!confirm('Disconnect the bot from WhatsApp?')) return;
    var btn = document.getElementById('disconnect-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Disconnecting...'; }
    try {
        var res = await fetch(BASE + '/api/connection/disconnect', { method: 'POST' });
        if (!res.ok) throw new Error('Failed');
        showToast('Bot disconnected', 'success');
    } catch (e) {
        showToast('Failed to disconnect', 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Disconnect'; }
    }
}

// --- Connection page: polling + QR rendering ---
(function initConnectionPage() {
    var qrCanvas = document.getElementById('qr-canvas');
    if (!qrCanvas) return; // Not on the connection page

    var statusBadge = document.getElementById('status-badge');
    var statusMsg = document.getElementById('status-message');
    var qrContainer = document.getElementById('qr-container');
    var connectedInfo = document.getElementById('connected-info');
    var connectedName = document.getElementById('connected-name');
    var connectedPhone = document.getElementById('connected-phone');
    var disconnectedInfo = document.getElementById('disconnected-info');
    var loadingContainer = document.getElementById('loading-container');
    var loadingProgress = document.getElementById('loading-progress');
    var loadingMsg = document.getElementById('loading-message');
    var qrLibReady = false;
    var pendingQr = null;
    var lastRenderedQr = null;

    // Load QR library from CDN
    var script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/qrcode@1/build/qrcode.min.js';
    script.onload = function () {
        qrLibReady = true;
        addLog('QR library loaded');
        if (pendingQr) renderQr(pendingQr);
    };
    script.onerror = function () {
        addLog('QR library failed to load from CDN');
    };
    document.head.appendChild(script);

    function setBadge(text, color) {
        statusBadge.textContent = text;
        statusBadge.style.background = color;
        statusBadge.style.color = '#fff';
    }

    function addLog(msg) {
        // no-op: event log UI removed
    }

    function hideAll() {
        qrContainer.style.display = 'none';
        connectedInfo.style.display = 'none';
        disconnectedInfo.style.display = 'none';
        loadingContainer.style.display = 'none';
    }

    function renderQr(qrData) {
        if (qrLibReady && typeof QRCode !== 'undefined') {
            QRCode.toCanvas(qrCanvas, qrData, {
                width: 280,
                margin: 2,
                color: { dark: '#000000', light: '#ffffff' }
            }, function (error) {
                if (error) addLog('QR render error: ' + error.message);
            });
            pendingQr = null;
        } else {
            pendingQr = qrData;
        }
    }

    function handleStatus(data) {
        statusMsg.textContent = data.message;

        switch (data.status) {
            case 'qr':
                hideAll();
                qrContainer.style.display = 'block';
                setBadge('QR Ready', '#1565c0');
                if (data.qr && data.qr !== lastRenderedQr) {
                    lastRenderedQr = data.qr;
                    addLog('QR code received');
                    renderQr(data.qr);
                }
                break;
            case 'ready':
                hideAll();
                connectedInfo.style.display = 'block';
                connectedName.textContent = (data.info && data.info.pushname) || 'Unknown';
                connectedPhone.textContent = (data.info && data.info.phone) || 'Unknown';
                setBadge('Connected', '#2e7d32');
                break;
            case 'authenticated':
                hideAll();
                loadingContainer.style.display = 'block';
                setBadge('Authenticated', '#f9a825');
                break;
            case 'loading':
                hideAll();
                loadingContainer.style.display = 'block';
                loadingProgress.value = (data.info && data.info.percent) || 0;
                loadingMsg.textContent = data.message;
                setBadge('Loading', '#f9a825');
                break;
            case 'disconnected':
                hideAll();
                disconnectedInfo.style.display = 'block';
                var connectBtn = document.getElementById('connect-btn');
                if (connectBtn) { connectBtn.disabled = false; connectBtn.textContent = 'Connect'; }
                setBadge('Disconnected', '#c62828');
                break;
            case 'auth_failure':
                hideAll();
                disconnectedInfo.style.display = 'block';
                setBadge('Auth Failed', '#c62828');
                break;
            case 'waiting':
                hideAll();
                setBadge('Waiting', '#757575');
                break;
        }
    }

    // Poll every 3 seconds
    function poll() {
        fetch(BASE + '/api/connection/status')
            .then(function (r) { return r.json(); })
            .then(function (data) { handleStatus(data); })
            .catch(function () {
                statusMsg.textContent = 'Failed to reach server. Retrying...';
                setBadge('Error', '#c62828');
            });
    }

    addLog('Polling started');
    poll();
    setInterval(poll, 3000);
})();

// --- Global header: live connection status + auto-redirect ---
(function initHeaderStatus() {
    var label = document.getElementById('connection-status-label');
    if (!label) return;

    var prevStatus = null;
    var isConnectionPage = !!document.getElementById('qr-canvas');

    function updateHeader() {
        fetch(BASE + '/api/connection/status')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.status === 'ready') {
                    label.textContent = '✅';
                    label.title = 'Connected';

                    // Redirect to home (groups) when status transitions to ready on the connection page
                    if (prevStatus && prevStatus !== 'ready' && isConnectionPage) {
                        window.location.href = BASE + '/groups';
                    }
                } else {
                    label.textContent = '⚠️';
                    label.title = 'Disconnected';
                }
                prevStatus = data.status;
            })
            .catch(function () {
                label.textContent = '⚠️';
                label.title = 'Disconnected';
            });
    }

    updateHeader();
    setInterval(updateHeader, 5000);
})();

// --- Groups: action buttons + row navigation (event delegation) ---
document.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-action]');
    if (btn) {
        const action = btn.dataset.action;
        const groupId = btn.dataset.groupId;
        if (action === 'activate') activateGroup(groupId);
        else if (action === 'inspect') inspectGroup(groupId);
        else if (action === 'deactivate') deactivateGroup(groupId);
        return;
    }
    const row = e.target.closest('.group-row[data-href]');
    if (row) {
        window.location = row.dataset.href;
    }
});

async function activateGroup(groupId) {
    try {
        const res = await fetch(`${BASE}/api/groups/${encodeURIComponent(groupId)}/activate`, { method: 'POST' });
        if (!res.ok) throw new Error('Failed');
        showToast('Group activated', 'success');
        setTimeout(() => location.reload(), 1000);
    } catch (e) {
        showToast('Failed to activate group', 'error');
    }
}

async function deactivateGroup(groupId) {
    if (!confirm('Deactivate this group? The bot will stop responding in it.')) return;
    try {
        const res = await fetch(`${BASE}/api/groups/${encodeURIComponent(groupId)}/deactivate`, { method: 'POST' });
        if (!res.ok) throw new Error('Failed');
        showToast('Group deactivated', 'success');
        setTimeout(() => location.reload(), 1000);
    } catch (e) {
        showToast('Failed to deactivate group', 'error');
    }
}

async function inspectGroup(groupId) {
    const row = document.getElementById('inspect-row-' + groupId);
    if (!row) return;
    const target = row.querySelector('td');
    if (!target) return;

    // Toggle visibility
    const isVisible = row.style.display !== 'none';
    if (isVisible && target.innerHTML.indexOf('Loading') === -1) {
        row.style.display = 'none';
        return;
    }
    row.style.display = 'table-row';
    target.innerHTML = '<p aria-busy="true">Loading WhatsApp info…</p>';

    try {
        const res = await fetch(`${BASE}/api/groups/${encodeURIComponent(groupId)}/whatsapp-info`);
        if (!res.ok) throw new Error('Failed');
        const data = await res.json();

        let html = '';
        if (data.name) html += `<p><strong>Name:</strong> ${data.name}</p>`;
        if (data.description) html += `<p><strong>Description:</strong> ${data.description}</p>`;
        if (data.createdAt) html += `<p><strong>Created:</strong> ${new Date(data.createdAt).toLocaleDateString()}</p>`;
        html += `<p><strong>Members (${data.participantCount}):</strong></p>`;
        html += '<ul class="participant-list">';
        for (const p of data.participants) {
            let badge = '';
            if (p.isSuperAdmin) badge = ' <span class="admin-badge">Group Owner</span>';
            else if (p.isAdmin) badge = ' <span class="admin-badge">Group Admin</span>';
            let authBadge = '';
            if (p.isBot) {
                authBadge = ' (Bot)';
            } else if (p.isBotAdmin) {
                authBadge = ' (Bot Admin)';
            } else if (p.isAuthorized) {
                authBadge = ' (Authorized)';
            } else {
                authBadge = ` <button onclick="authorizeUserFromGroup('${p.id}', '${groupId}')" style="font-size:0.75em;padding:2px 8px;margin-left:6px">Authorize</button>`;
            }
            html += `<li>${p.name}${badge}${authBadge}</li>`;
        }
        html += '</ul>';
        target.innerHTML = html;
    } catch (e) {
        target.innerHTML = '<p style="color:#c62828">Failed to load WhatsApp info. Is the bot connected?</p>';
    }
}

async function authorizeUserFromGroup(userId, groupId) {
    try {
        const res = await fetch(`${BASE}/api/authorized-users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId })
        });
        if (!res.ok) throw new Error('Failed to authorize user');
        // Force panel to re-fetch by clearing its content, then re-inspect
        const panel = document.getElementById('inspect-' + groupId);
        const row = document.getElementById('inspect-row-' + groupId);
        const target = panel || (row ? row.querySelector('td') : null);
        if (target) target.innerHTML = '';
        await inspectGroup(groupId);
    } catch (e) {
        alert('Failed to authorize user: ' + e.message);
    }
}

// --- Settings page: auto-expand persona from URL hash ---
function openPersonaByHash(hash) {
    if (!hash || !hash.startsWith('#persona-')) return;
    const name = hash.replace('#persona-', '');
    const detail = document.getElementById('persona-detail-' + name);
    if (detail) {
        detail.open = true;
        detail.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}
openPersonaByHash(window.location.hash);

// Handle in-page persona links (Edit Persona > on settings page)
document.addEventListener('click', function (e) {
    const link = e.target.closest('a[href^="#persona-"]');
    if (link) {
        e.preventDefault();
        openPersonaByHash(link.getAttribute('href'));
    }
});
