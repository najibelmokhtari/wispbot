var BASE = window.__basePath || '';
var CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')?.content || '';

// Wrap fetch to auto-include CSRF token on state-changing requests
var _origFetch = window.fetch;
window.fetch = function(url, opts) {
    opts = opts || {};
    if (opts.method && opts.method !== 'GET') {
        opts.headers = Object.assign({ 'X-CSRF-Token': CSRF_TOKEN }, opts.headers || {});
    }
    return _origFetch.call(window, url, opts);
};

// --- Dirty-tracking for input/textarea + save button pairs ---
// Stores original value and disables button; enables on change
function trackDirty(input, btn) {
    input.dataset.origVal = input.value;
    btn.disabled = true;
    input.addEventListener('input', () => {
        btn.disabled = (input.value === input.dataset.origVal);
    });
}

// Call after successful save to reset dirty state
function markClean(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.dataset.origVal = input.value;
    const btn = input.closest('.inline-form')?.querySelector('button')
        || document.getElementById(input.dataset.saveBtn);
    if (btn) btn.disabled = true;
}

// Auto-wire on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
    // Auto-wire all .inline-form containers
    document.querySelectorAll('.inline-form').forEach(form => {
        const input = form.querySelector('input, textarea');
        const btn = form.querySelector('button');
        if (input && btn) trackDirty(input, btn);
    });

    // Auto-wire standalone textareas with data-save-btn attribute
    // Skip lazy-loaded textareas (e.g. system prompts) — they get wired after content loads
    document.querySelectorAll('textarea[data-save-btn]').forEach(ta => {
        if (ta.id && ta.id.startsWith('sysprompt-content-')) return;
        const btn = document.getElementById(ta.dataset.saveBtn);
        if (btn) trackDirty(ta, btn);
    });
});

// --- Unsaved changes guard ---
// Returns true if any tracked input/textarea has unsaved changes
function hasUnsavedChanges() {
    // Check inline-form and standalone tracked inputs/textareas
    const tracked = document.querySelectorAll('[data-orig-val]');
    for (const el of tracked) {
        if (el.value !== el.dataset.origVal) return true;
    }
    // Check persona editors (use button disabled state)
    const btnPrompt = document.getElementById('btn-save-persona-prompt');
    if (btnPrompt && !btnPrompt.disabled) return true;
    const btnStyle = document.getElementById('btn-save-tts-style');
    if (btnStyle && !btnStyle.disabled) return true;
    const btnTtsAuto = document.getElementById('btn-save-tts-auto-persona');
    if (btnTtsAuto && !btnTtsAuto.disabled) return true;
    return false;
}

// Warn on browser close/navigate away
window.addEventListener('beforeunload', function (e) {
    if (hasUnsavedChanges()) {
        e.preventDefault();
        e.returnValue = '';
    }
});

// Confirm before following a link when there are unsaved changes
function confirmUnsaved() {
    if (!hasUnsavedChanges()) return true;
    return confirm('You have unsaved changes. Discard them and leave?');
}

// Intercept navigation link clicks (nav bar + any link that leaves the page)
document.addEventListener('click', function (e) {
    const link = e.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href');
    // Only guard internal links that navigate to a different page
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || link.target === '_blank') return;
    // Same-page hash links on personas page are handled by selectPersona guard
    if (href.includes('#persona-') && document.getElementById('persona-list')) return;
    if (!confirmUnsaved()) {
        e.preventDefault();
        e.stopPropagation();
    }
}, true);

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
        if (field === 'image_enabled') {
            const section = document.getElementById('image-settings-section');
            if (section) section.style.display = value ? '' : 'none';
        }
        if (field === 'tts_enabled') {
            const section = document.getElementById('tts-settings-section');
            if (section) section.style.display = value ? '' : 'none';
        }
        if (field === 'active_listening_enabled') {
            const content = document.getElementById('active-listening-content');
            const overlay = document.getElementById('al-disabled-overlay');
            if (value) {
                // Enable: remove disabled styling and scroll to section
                if (content) content.classList.remove('section-disabled-wrapper');
                if (overlay) overlay.remove();
                const section = document.getElementById('active-listening-section');
                if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } else {
                // Disable: add disabled styling with overlay
                if (content) {
                    content.classList.add('section-disabled-wrapper');
                    if (!document.getElementById('al-disabled-overlay')) {
                        const ov = document.createElement('div');
                        ov.className = 'section-disabled-overlay';
                        ov.id = 'al-disabled-overlay';
                        ov.innerHTML = '<span class="disabled-tooltip">Enable Active Listening above to configure these settings</span>';
                        content.prepend(ov);
                    }
                }
            }
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
                editLink.href = `${BASE}/personas#persona-${value}`;
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
        markClean('group-name-input');
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
        markClean('bg-debounce-input');
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
        markClean('bg-threshold-input');
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
        markClean('default-bg-debounce');
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
        markClean('default-history-limit');
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
        markClean('default-bg-threshold');
    } catch (e) {
        showToast('Failed to save default threshold', 'error');
    }
}

// --- Active Listening save functions ---

// Save default active listening throttle (settings page)
async function saveDefaultActiveListeningThrottle() {
    const val = document.getElementById('default-al-throttle').value.trim();
    const ms = val ? String(parseInt(val) * 1000) : '';
    try {
        const res = await fetch(`${BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ default_active_listening_throttle_ms: ms })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(val ? `Default throttle set to ${val}s` : 'Default throttle cleared', 'success');
        markClean('default-al-throttle');
    } catch (e) {
        showToast('Failed to save default throttle', 'error');
    }
}

// Save default active listening context count (settings page)
async function saveDefaultActiveListeningContextCount() {
    const val = document.getElementById('default-al-context-count').value.trim();
    try {
        const res = await fetch(`${BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ default_active_listening_context_count: val })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(val ? `Default context count set to ${val} messages` : 'Default context count cleared', 'success');
        markClean('default-al-context-count');
    } catch (e) {
        showToast('Failed to save default context count', 'error');
    }
}

// Save group active listening throttle
async function saveGroupActiveListeningThrottle(groupId) {
    const val = document.getElementById('al-throttle-input').value.trim();
    const ms = val ? parseInt(val) * 1000 : null;
    try {
        const res = await fetch(`${BASE}/api/groups/${encodeURIComponent(groupId)}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active_listening_throttle_ms: ms })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(val ? `Throttle set to ${val}s` : 'Throttle reset to default', 'success');
        markClean('al-throttle-input');
    } catch (e) {
        showToast('Failed to save throttle setting', 'error');
    }
}

// Save group active listening context count
async function saveGroupActiveListeningContextCount(groupId) {
    const val = document.getElementById('al-context-count-input').value.trim();
    const count = val ? parseInt(val) : null;
    try {
        const res = await fetch(`${BASE}/api/groups/${encodeURIComponent(groupId)}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active_listening_context_count: count })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(val ? `Context count set to ${val} messages` : 'Context count reset to default', 'success');
        markClean('al-context-count-input');
    } catch (e) {
        showToast('Failed to save context count', 'error');
    }
}

// Save group active listening custom prompt
async function saveGroupActiveListeningPrompt(groupId) {
    const content = document.getElementById('al-prompt-editor').value;
    try {
        const res = await fetch(`${BASE}/api/groups/${encodeURIComponent(groupId)}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active_listening_prompt: content || null })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(content ? 'Additional instructions saved' : 'Additional instructions cleared', 'success');
        markClean('al-prompt-editor');
    } catch (e) {
        showToast('Failed to save additional instructions', 'error');
    }
}

// Save group voice reply instructions ('auto' TTS trigger mode)
async function saveGroupTtsAutoInstructions(groupId) {
    const content = document.getElementById('tts-auto-editor').value;
    try {
        const res = await fetch(`${BASE}/api/groups/${encodeURIComponent(groupId)}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tts_auto_instructions: content || null })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(content ? 'Voice reply instructions saved' : 'Voice reply instructions cleared', 'success');
        markClean('tts-auto-editor');
    } catch (e) {
        showToast('Failed to save voice reply instructions', 'error');
    }
}

// Show the voice reply instructions only in 'auto' trigger mode
function toggleGroupTtsAutoSection(mode) {
    const section = document.getElementById('tts-auto-instructions-section');
    if (section) section.style.display = mode === 'auto' ? '' : 'none';
}

// Save group active listening audio count
async function saveGroupAlAudioCount(groupId) {
    const val = document.getElementById('al-audio-count-input').value.trim();
    const count = val ? parseInt(val) : null;
    try {
        const res = await fetch(`${BASE}/api/groups/${encodeURIComponent(groupId)}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active_listening_audio_count: count })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(val ? `Audio count set to ${val}` : 'Audio count reset to default', 'success');
        markClean('al-audio-count-input');
    } catch (e) {
        showToast('Failed to save audio count', 'error');
    }
}

// Save default active listening audio count
async function saveDefaultAlAudioCount() {
    const val = document.getElementById('default-al-audio-count').value.trim();
    try {
        const res = await fetch(`${BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ default_al_audio_count: val || '3' })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(val ? `Default audio count set to ${val}` : 'Default audio count reset', 'success');
        markClean('default-al-audio-count');
    } catch (e) {
        showToast('Failed to save default audio count', 'error');
    }
}

// Save group active listening image count
async function saveGroupAlImageCount(groupId) {
    const val = document.getElementById('al-image-count-input').value.trim();
    const count = val ? parseInt(val) : null;
    try {
        const res = await fetch(`${BASE}/api/groups/${encodeURIComponent(groupId)}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active_listening_image_count: count })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(val ? `Image count set to ${val}` : 'Image count reset to default', 'success');
        markClean('al-image-count-input');
    } catch (e) {
        showToast('Failed to save image count', 'error');
    }
}

// Save default active listening image count
async function saveDefaultAlImageCount() {
    const val = document.getElementById('default-al-image-count').value.trim();
    try {
        const res = await fetch(`${BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ default_al_image_count: val || '3' })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(val ? `Default image count set to ${val}` : 'Default image count reset', 'success');
        markClean('default-al-image-count');
    } catch (e) {
        showToast('Failed to save default image count', 'error');
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
        markClean('history-limit-input');
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
        markClean('audio-history-count-input');
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
        markClean('audio-duration-cap-input');
    } catch (e) {
        showToast('Failed to save audio duration cap', 'error');
    }
}

// Save group voice note preview length
async function saveAudioPreviewSeconds(groupId) {
    const val = document.getElementById('audio-preview-seconds-input').value.trim();
    const seconds = val !== '' ? parseInt(val) : null;
    try {
        const res = await fetch(`${BASE}/api/groups/${encodeURIComponent(groupId)}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audio_preview_seconds: seconds })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(val !== '' ? `Preview length set to ${val}s` : 'Preview length reset to default', 'success');
        markClean('audio-preview-seconds-input');
    } catch (e) {
        showToast('Failed to save preview length', 'error');
    }
}

// Show the preview length only when voice note previews are on
function toggleAudioPreviewSeconds() {
    const select = document.getElementById('select-audio-preview');
    const container = document.getElementById('audio-preview-seconds-container');
    if (select && container) container.style.display = select.value === '1' ? '' : 'none';
}

// Toggle audio history count visibility based on mode
function toggleAudioHistoryCount() {
    const mode = document.getElementById('select-audio-mode');
    const container = document.getElementById('audio-history-count-container');
    if (mode && container) {
        container.style.display = mode.value === 'history' ? '' : 'none';
    }
}

// Save group image history count
async function saveImageHistoryCount(groupId) {
    const val = document.getElementById('image-history-count-input').value.trim();
    const count = val ? parseInt(val) : 1;
    try {
        const res = await fetch(`${BASE}/api/groups/${encodeURIComponent(groupId)}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_history_count: count })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(val ? `Image history count set to ${val}` : 'Image history count reset to default', 'success');
        markClean('image-history-count-input');
    } catch (e) {
        showToast('Failed to save image history count', 'error');
    }
}

// Toggle image history count visibility based on mode
function toggleImageHistoryCount() {
    const mode = document.getElementById('select-image-mode');
    const container = document.getElementById('image-history-count-container');
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
        markClean('context-editor');
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
        markClean('memories-editor');
    } catch (e) {
        showToast('Failed to save memories', 'error');
    }
}

// --- Settings page functions ---

// Save bot display name
async function toggleBotActive(checked) {
    try {
        const res = await fetch(`${BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bot_active: checked ? '1' : '0' })
        });
        if (!res.ok) throw new Error('Failed');
        // Update UI
        const label = document.getElementById('bot-active-label');
        const desc = document.getElementById('bot-active-desc');
        const badge = document.getElementById('bot-active-badge');
        const article = document.getElementById('bot-active-switch')?.closest('article');
        if (label) label.textContent = checked ? 'ON' : 'OFF';
        if (desc) desc.style.display = checked ? 'none' : '';
        if (badge) {
            badge.textContent = checked ? 'Active' : 'Disabled';
            badge.style.background = checked ? '#e8f5e9' : '#ffebee';
            badge.style.color = checked ? '#2e7d32' : '#c62828';
        }
        if (article) {
            article.style.borderColor = checked ? '#2e7d32' : '#c62828';
            const header = article.querySelector('header');
            if (header) header.style.background = checked ? '#2e7d32' : '#c62828';
        }
        // Update nav indicator
        const navIndicator = document.getElementById('bot-active-nav-indicator');
        if (navIndicator) navIndicator.style.display = checked ? 'none' : '';
        showToast(`Bot ${checked ? 'enabled' : 'disabled'}`, 'success');
    } catch (e) {
        showToast('Failed to toggle bot status', 'error');
        // Revert switch
        const sw = document.getElementById('bot-active-switch');
        if (sw) sw.checked = !checked;
    }
}

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
        markClean('bot-name-input');
    } catch (e) {
        showToast(e.message || 'Failed to save bot name', 'error');
    }
}

function toggleTtsTriggerTag() {
    const mode = document.getElementById('default-tts-trigger-mode').value;
    const container = document.getElementById('tts-trigger-tag-container');
    if (container) container.style.display = mode === 'always' ? 'none' : '';
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
        markClean('tts-trigger-input');
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
        markClean('default-audio-history-count');
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
        markClean('default-audio-duration-cap');
    } catch (e) {
        showToast('Failed to save default audio duration cap', 'error');
    }
}

// Toggle activation mode sections (settings page)
function toggleActivationMode() {
    const mode = document.getElementById('bot-activation-mode');
    if (!mode) return;
    const isAL = mode.value === 'active_listening';
    const descManual = document.getElementById('activation-mode-desc-manual');
    const descAL = document.getElementById('activation-mode-desc-al');
    if (descManual) descManual.style.display = isAL ? 'none' : '';
    if (descAL) descAL.style.display = isAL ? '' : 'none';
}

// Toggle default audio history count visibility based on mode (settings page)
function toggleDefaultAudioHistoryCount() {
    const mode = document.getElementById('default-audio-history-mode');
    const container = document.getElementById('default-audio-history-count-container');
    if (mode && container) {
        container.style.display = mode.value === 'history' ? '' : 'none';
    }
}

// Save default image history count (settings page)
async function saveDefaultImageHistoryCount() {
    const val = document.getElementById('default-image-history-count').value.trim();
    if (!val) return showToast('Enter an image history count', 'error');
    try {
        const res = await fetch(`${BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ default_image_history_count: val })
        });
        if (!res.ok) throw new Error('Failed');
        showToast(`Default image history count set to ${val}`, 'success');
        markClean('default-image-history-count');
    } catch (e) {
        showToast('Failed to save default image history count', 'error');
    }
}

// Toggle default image history count visibility based on mode (settings page)
function toggleDefaultImageHistoryCount() {
    const mode = document.getElementById('default-image-history-mode');
    const container = document.getElementById('default-image-history-count-container');
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
        const label = field === 'bot_activation_mode'
            ? `Default activation mode for new groups updated to ${value.replace(/_/g, ' ')}`
            : `${field.replace(/^default_/, '').replace(/_/g, ' ')} updated to ${value}`;
        showToast(label, 'success');
        // If default persona changed, update the Edit Persona link
        if (field === 'default_persona') {
            const editLink = document.getElementById('edit-default-persona-link');
            if (editLink) {
                editLink.href = `${BASE}/personas#persona-${value}`;
                editLink.style.display = value === 'default' ? 'none' : '';
            }
        }
    } catch (e) {
        showToast('Failed to update setting', 'error');
    }
}

// --- Persona split-panel UI ---
let currentPersona = null;

// Enable save button when a textarea is edited
function markPersonaDirty(field) {
    if (field === 'prompt') {
        const btn = document.getElementById('btn-save-persona-prompt');
        if (btn) btn.disabled = false;
    } else if (field === 'ttsStyle') {
        const btn = document.getElementById('btn-save-tts-style');
        if (btn) btn.disabled = false;
    } else if (field === 'ttsAuto') {
        const btn = document.getElementById('btn-save-tts-auto-persona');
        if (btn) btn.disabled = false;
    } else if (field === 'description') {
        const btn = document.getElementById('btn-save-persona-description');
        if (btn) btn.disabled = false;
    }
}

// Disable all save buttons (called after load or successful save)
function resetPersonaDirty() {
    const btnPrompt = document.getElementById('btn-save-persona-prompt');
    const btnStyle = document.getElementById('btn-save-tts-style');
    const btnDesc = document.getElementById('btn-save-persona-description');
    const btnTtsAuto = document.getElementById('btn-save-tts-auto-persona');
    if (btnTtsAuto) btnTtsAuto.disabled = true;
    if (btnPrompt) btnPrompt.disabled = true;
    if (btnStyle) btnStyle.disabled = true;
    if (btnDesc) btnDesc.disabled = true;
}

// Select a persona from the sidebar
async function selectPersona(name) {
    if (name !== currentPersona && !confirmUnsaved()) return;
    currentPersona = name;

    // Update sidebar active state
    document.querySelectorAll('.persona-sidebar-item').forEach(el => el.classList.remove('active'));
    const item = document.getElementById('persona-item-' + name);
    if (item) item.classList.add('active');

    // Show detail view, hide others
    const emptyState = document.getElementById('persona-empty-state');
    const detailView = document.getElementById('persona-detail-view');
    const createView = document.getElementById('persona-create-view');
    if (emptyState) emptyState.style.display = 'none';
    if (createView) createView.style.display = 'none';
    if (detailView) detailView.style.display = 'block';

    // Set title
    document.getElementById('persona-detail-title').textContent = name;

    // Show/hide sections based on whether it's default
    const isDefault = name === 'default';
    document.getElementById('persona-default-notice').style.display = isDefault ? 'block' : 'none';
    document.getElementById('persona-prompt-section').style.display = isDefault ? 'none' : 'block';
    document.getElementById('persona-description-section').style.display = isDefault ? 'none' : 'block';
    document.getElementById('persona-delete-btn').style.display = isDefault ? 'none' : '';

    // Update TTS descriptions
    document.getElementById('persona-tts-voice-desc').innerHTML = isDefault
        ? 'The voice used when this persona speaks. This is the fallback voice for all personas without a custom voice.'
        : 'The voice used when this persona speaks.';
    document.getElementById('persona-tts-style-desc').innerHTML = isDefault
        ? 'Instructions for how this persona should speak (tone, accent, mannerisms). This is the fallback style for personas without a custom TTS prompt.'
        : 'Instructions for how this persona should speak (tone, accent, mannerisms). Leave empty to use the default style.';

    document.getElementById('persona-tts-auto-desc').innerHTML = isDefault
        ? 'When this persona should answer with a voice note in groups using the "Let AI decide" trigger mode. Used for personas without their own instructions; each group can add its own on top.'
        : 'When this persona should answer with a voice note in groups using the "Let AI decide" trigger mode. Each group can add its own instructions on top. Leave empty to use the default persona\'s instructions.';

    // Show/hide the "Use Default" option in voice select
    document.getElementById('persona-tts-voice-default-opt').style.display = isDefault ? 'none' : '';

    // Load persona content
    const contentEditor = document.getElementById('persona-content-editor');
    const voiceSelect = document.getElementById('persona-tts-voice-select');
    const styleEditor = document.getElementById('persona-tts-style-editor');
    const autoEditor = document.getElementById('persona-tts-auto-editor');

    // Reset
    if (contentEditor) { contentEditor.value = ''; contentEditor.placeholder = 'Loading...'; }
    if (styleEditor) { styleEditor.value = ''; styleEditor.placeholder = 'Loading...'; }
    if (autoEditor) { autoEditor.value = ''; autoEditor.placeholder = 'Loading...'; }
    if (voiceSelect) voiceSelect.value = '';

    // Hide community notice by default
    const communityNotice = document.getElementById('persona-community-notice');
    if (communityNotice) communityNotice.style.display = 'none';

    // Load prompt and description (non-default only)
    if (!isDefault && contentEditor) {
        try {
            const res = await fetch(`${BASE}/api/personas/${encodeURIComponent(name)}`);
            if (!res.ok) throw new Error('Failed');
            const data = await res.json();
            contentEditor.value = data.content;
            contentEditor.placeholder = 'Enter the system prompt for this persona...';

            // Populate description
            const descEditor = document.getElementById('persona-description-editor');
            if (descEditor) descEditor.value = data.description || '';

            // Show asterisk + notice if this is a modified community persona
            if (data.communityModified) {
                document.getElementById('persona-detail-title').textContent = name + '*';
                if (communityNotice) communityNotice.style.display = 'block';
                // Also mark the sidebar item
                const sidebarName = item?.querySelector('.persona-sidebar-name');
                if (sidebarName) sidebarName.textContent = name + '*';
            }
        } catch (e) {
            contentEditor.value = 'Failed to load persona content.';
        }
    }

    // Load TTS settings
    try {
        const res = await fetch(`${BASE}/api/personas/${encodeURIComponent(name)}/tts`);
        if (!res.ok) throw new Error('Failed');
        const data = await res.json();
        if (voiceSelect) voiceSelect.value = data.voice || '';
        if (styleEditor) { styleEditor.value = data.stylePrompt || ''; styleEditor.placeholder = 'Enter TTS style instructions...'; }
        if (autoEditor) { autoEditor.value = data.autoInstructions || ''; autoEditor.placeholder = 'e.g. Send a voice note for jokes, roasts and storytelling; use text for anything factual.'; }
    } catch (e) {
        if (styleEditor) styleEditor.value = 'Failed to load TTS style prompt.';
        if (autoEditor) autoEditor.value = 'Failed to load voice reply instructions.';
    }

    // Reset dirty state after loading
    resetPersonaDirty();

    // Update URL hash
    window.history.replaceState(null, '', '#persona-' + name);
}

// Show the create new persona panel
function showCreatePersonaPanel() {
    if (!confirmUnsaved()) return;
    currentPersona = null;
    document.querySelectorAll('.persona-sidebar-item').forEach(el => el.classList.remove('active'));

    document.getElementById('persona-empty-state').style.display = 'none';
    document.getElementById('persona-detail-view').style.display = 'none';
    document.getElementById('persona-create-view').style.display = 'block';

    document.getElementById('new-persona-name').value = '';
    document.getElementById('new-persona-description').value = '';
    document.getElementById('new-persona-content').value = '';
    document.getElementById('new-persona-name').focus();
}

// Cancel creating a new persona
function cancelCreatePersona() {
    document.getElementById('persona-create-view').style.display = 'none';
    if (currentPersona) {
        selectPersona(currentPersona);
    } else {
        document.getElementById('persona-empty-state').style.display = 'flex';
    }
}

// Re-check community modified status and update asterisk/notice
async function refreshCommunityStatus() {
    if (!currentPersona || currentPersona === 'default') return;
    try {
        const res = await fetch(`${BASE}/api/personas/${encodeURIComponent(currentPersona)}`);
        if (!res.ok) return;
        const data = await res.json();
        const baseName = currentPersona.replace(/\*$/, '');
        const title = document.getElementById('persona-detail-title');
        const notice = document.getElementById('persona-community-notice');
        const sidebarName = document.getElementById('persona-item-' + baseName)?.querySelector('.persona-sidebar-name');
        if (data.communityModified) {
            if (title) title.textContent = baseName + '*';
            if (sidebarName) sidebarName.textContent = baseName + '*';
            if (notice) notice.style.display = 'block';
        } else if (data.communitySource !== undefined) {
            if (title) title.textContent = baseName;
            if (sidebarName) sidebarName.textContent = baseName;
            if (notice) notice.style.display = 'none';
        }
    } catch { /* ignore */ }
}

// Save persona prompt from the detail panel
async function savePersonaPrompt() {
    if (!currentPersona || currentPersona === 'default') return;
    const textarea = document.getElementById('persona-content-editor');
    if (!textarea) return;
    try {
        const res = await fetch(`${BASE}/api/personas/${encodeURIComponent(currentPersona)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: textarea.value })
        });
        if (!res.ok) throw new Error('Failed');
        showToast('Persona prompt saved', 'success');
        const btn = document.getElementById('btn-save-persona-prompt');
        if (btn) btn.disabled = true;
        refreshCommunityStatus();
    } catch (e) {
        showToast('Failed to save persona', 'error');
    }
}

// Save persona description
async function savePersonaDescription() {
    if (!currentPersona || currentPersona === 'default') return;
    const input = document.getElementById('persona-description-editor');
    if (!input) return;
    try {
        const res = await fetch(`${BASE}/api/personas/${encodeURIComponent(currentPersona)}/description`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description: input.value })
        });
        if (!res.ok) throw new Error('Failed');
        showToast('Description saved', 'success');
        const btn = document.getElementById('btn-save-persona-description');
        if (btn) btn.disabled = true;
        // Update sidebar tooltip
        const sidebarItem = document.getElementById('persona-item-' + currentPersona);
        if (sidebarItem) sidebarItem.title = input.value.trim();
    } catch (e) {
        showToast('Failed to save description', 'error');
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
        refreshCommunityStatus();
    } catch (e) {
        showToast('Failed to save TTS voice', 'error');
    }
}

// Save persona TTS style prompt
async function savePersonaTtsStyle() {
    if (!currentPersona) return;
    const textarea = document.getElementById('persona-tts-style-editor');
    if (!textarea) return;
    try {
        const res = await fetch(`${BASE}/api/personas/${encodeURIComponent(currentPersona)}/tts/style`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: textarea.value })
        });
        if (!res.ok) throw new Error('Failed');
        showToast('TTS style prompt saved', 'success');
        const btn = document.getElementById('btn-save-tts-style');
        if (btn) btn.disabled = true;
        refreshCommunityStatus();
    } catch (e) {
        showToast('Failed to save TTS style prompt', 'error');
    }
}

// Save persona voice reply instructions ('auto' TTS trigger mode)
async function savePersonaTtsAuto() {
    if (!currentPersona) return;
    const textarea = document.getElementById('persona-tts-auto-editor');
    if (!textarea) return;
    try {
        const res = await fetch(`${BASE}/api/personas/${encodeURIComponent(currentPersona)}/tts/auto`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: textarea.value })
        });
        if (!res.ok) throw new Error('Failed');
        showToast('Voice reply instructions saved', 'success');
        const btn = document.getElementById('btn-save-tts-auto-persona');
        if (btn) btn.disabled = true;
        refreshCommunityStatus();
    } catch (e) {
        showToast('Failed to save voice reply instructions', 'error');
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
        // Set up dirty tracking now that content is loaded
        const btn = document.getElementById(textarea.dataset.saveBtn);
        if (btn) trackDirty(textarea, btn);
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
        markClean('sysprompt-content-' + name);
    } catch (e) {
        showToast('Failed to save system prompt', 'error');
    }
}

// Create new persona
async function createNewPersona() {
    const nameInput = document.getElementById('new-persona-name');
    const contentTextarea = document.getElementById('new-persona-content');
    const descriptionInput = document.getElementById('new-persona-description');
    const name = nameInput.value.trim().toLowerCase();
    if (!name) return showToast('Enter a persona name', 'error');
    if (!/^[a-z0-9_]+$/.test(name)) return showToast('Name must be lowercase letters, numbers, underscores only', 'error');
    if (name.length > 30) return showToast('Name must be 30 characters or less', 'error');
    if (name === 'default') return showToast('Cannot overwrite the default persona', 'error');
    const content = contentTextarea.value.trim();
    if (!content) return showToast('Enter persona content', 'error');
    const description = descriptionInput ? descriptionInput.value.trim() : '';
    // Check if persona already exists
    const existing = document.getElementById('persona-item-' + name);
    if (existing && !confirm(`Persona "${name}" already exists. Overwrite it?`)) return;
    try {
        const res = await fetch(`${BASE}/api/personas/${encodeURIComponent(name)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content, description })
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
    if (!name || name === 'default') return;
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
    var alertContainer = document.getElementById('connection-alert');
    var alertMessage = document.getElementById('connection-alert-message');
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

        // Show/hide connection alert banner
        if (data.alert && alertContainer) {
            alertContainer.style.display = 'block';
            alertMessage.textContent = data.alert.message;
        } else if (alertContainer) {
            alertContainer.style.display = 'none';
        }

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

// --- Groups page: poll for new chats and auto-reload ---
(function () {
    // Only run on the groups page (check for the groups table)
    var groupRows = document.querySelectorAll('[data-group-id]');
    if (!groupRows.length && !document.querySelector('.section-heading')) return;
    // Must be on a page with "Chats" heading
    var heading = document.querySelector('h2');
    if (!heading || heading.textContent.trim() !== 'Chats') return;

    var knownIds = new Set();
    groupRows.forEach(function (el) {
        if (el.dataset.groupId) knownIds.add(el.dataset.groupId);
    });
    // Also capture IDs from group-row links (for rows without data-group-id)
    document.querySelectorAll('.group-row[data-href]').forEach(function (row) {
        var match = row.dataset.href.match(/\/groups\/([^/]+)$/);
        if (match) knownIds.add(decodeURIComponent(match[1]));
    });

    function pollNewChats() {
        fetch(BASE + '/api/groups/ids')
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (!data.ids) return;
                var hasNew = data.ids.some(function (id) { return !knownIds.has(id); });
                if (hasNew) {
                    location.reload();
                }
            })
            .catch(function () { /* ignore network errors */ });
    }

    setInterval(pollNewChats, 5000);
})();

// --- Groups: action buttons + row navigation (event delegation) ---
document.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-action]');
    if (btn) {
        const action = btn.dataset.action;
        const groupId = btn.dataset.groupId;
        if (action === 'activate') activateGroup(groupId);
        else if (action === 'inspect') inspectGroup(groupId, btn.dataset.authEnabled === '1');
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

async function inspectGroup(groupId, authEnabled) {
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
            } else if (authEnabled) {
                authBadge = ` <button onclick="authorizeUserFromGroup(this, '${p.id}')" style="font-size:0.75em;padding:2px 8px;margin-left:6px">Authorize</button>`;
            }
            let displayName = '';
            if (p.name) {
                displayName = `${p.name} <small style="opacity:0.55;font-size:0.8em">+${p.phone}</small>`;
            } else {
                displayName = `+${p.phone}`;
            }
            html += `<li>${displayName}${badge}${authBadge}</li>`;
        }
        html += '</ul>';
        target.innerHTML = html;
    } catch (e) {
        target.innerHTML = '<p style="color:#c62828">Failed to load WhatsApp info. Is the bot connected?</p>';
    }
}

async function authorizeUserFromGroup(btn, userId) {
    try {
        btn.disabled = true;
        btn.textContent = '...';
        const res = await fetch(`${BASE}/api/authorized-users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId })
        });
        if (!res.ok) throw new Error('Failed to authorize user');
        // Replace button with "(Authorized)" text in-place
        const span = document.createElement('span');
        span.textContent = ' (Authorized)';
        btn.replaceWith(span);
    } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Authorize';
        alert('Failed to authorize user: ' + e.message);
    }
}

// --- Persona page: auto-select persona from URL hash ---
function openPersonaByHash(hash) {
    if (!hash || !hash.startsWith('#persona-')) return;
    const name = hash.replace('#persona-', '');
    const item = document.getElementById('persona-item-' + name);
    if (item) {
        selectPersona(name);
    }
}
openPersonaByHash(window.location.hash);

// Handle persona links — redirect to personas page if not already there
document.addEventListener('click', function (e) {
    const link = e.target.closest('a[href*="#persona-"]');
    if (link) {
        const href = link.getAttribute('href');
        const hash = href.includes('#') ? '#' + href.split('#')[1] : href;
        // If we're on the personas page, select in-place
        if (document.getElementById('persona-list')) {
            e.preventDefault();
            openPersonaByHash(hash);
        } else {
            // Redirect to personas page with hash
            e.preventDefault();
            window.location.href = BASE + '/personas' + hash;
        }
    }
});

// --- Community Personas Browser ---
let communityIndex = null;
let communityFilter = '';
let communitySelectedPath = null;
let communityExpandedFolders = new Set();

async function loadCommunityIndex() {
    const btn = document.getElementById('community-browse-btn');
    const browser = document.getElementById('community-browser');
    if (!btn || !browser) return;

    btn.disabled = true;
    btn.textContent = 'Loading...';
    try {
        const res = await fetch(`${BASE}/api/community-personas`);
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Failed to load');
        }
        communityIndex = await res.json();
        communityExpandedFolders.clear();
        browser.style.display = 'block';
        btn.style.display = 'none';
        renderCommunityTree();
    } catch (e) {
        showToast(e.message || 'Failed to load community personas', 'error');
        btn.disabled = false;
        btn.textContent = 'Browse Community Personas';
    }
}

function filterCommunityPersonas(query) {
    const q = query.toLowerCase().trim();
    communityFilter = q.length >= 3 ? q : '';
    communityExpandedFolders.clear();
    if (communityFilter) {
        expandAllFolderPaths();
    }
    renderCommunityTree();
}

// Derive all folder paths from persona paths and expand them
function expandAllFolderPaths() {
    if (!communityIndex?.personas) return;
    for (const p of communityIndex.personas) {
        const parts = p.path.split('/');
        parts.pop(); // remove filename
        let accumulated = '';
        for (const dir of parts) {
            accumulated = accumulated ? accumulated + '/' + dir : dir;
            communityExpandedFolders.add(accumulated);
        }
    }
}

function toggleFolder(folderPath) {
    if (communityExpandedFolders.has(folderPath)) {
        communityExpandedFolders.delete(folderPath);
    } else {
        communityExpandedFolders.add(folderPath);
    }
    renderCommunityTree();
}

// Build the tree by deriving folder structure from persona paths
function buildTree() {
    if (!communityIndex) return [];

    let personas = communityIndex.personas || [];
    if (communityFilter) {
        personas = personas.filter(p => {
            const searchable = [p.name, p.description, p.author, ...(p.tags || [])].join(' ').toLowerCase();
            return searchable.includes(communityFilter);
        });
    }

    // Build a nested map from persona paths
    // { darija: { _personas: [casawi], egyptian: { _personas: [m3allem] } } }
    const root = { _personas: [] };
    for (const p of personas) {
        const parts = p.path.split('/');
        parts.pop(); // remove filename
        let current = root;
        for (const dir of parts) {
            if (!current[dir]) current[dir] = { _personas: [] };
            current = current[dir];
        }
        current._personas.push(p);
    }

    // Look up folder metadata (label, description) from index.folders if present
    function getFolderMeta(folderPath) {
        if (!communityIndex.folders) return null;
        const parts = folderPath.split('/');
        let node = communityIndex.folders;
        for (let i = 0; i < parts.length; i++) {
            const child = node[parts[i]];
            if (!child) return null;
            if (i === parts.length - 1) return child;
            node = child.children || {};
        }
        return null;
    }

    // Count all personas under a map node (recursive)
    function countPersonas(node) {
        let count = (node._personas || []).length;
        for (const [key, val] of Object.entries(node)) {
            if (key === '_personas') continue;
            count += countPersonas(val);
        }
        return count;
    }

    // Convert the nested map into tree nodes
    function mapToNodes(map, prefix) {
        const nodes = [];
        for (const [key, val] of Object.entries(map)) {
            if (key === '_personas') continue;
            const fullPath = prefix ? prefix + '/' + key : key;
            const meta = getFolderMeta(fullPath);
            const children = [];

            // Recurse into subfolders
            children.push(...mapToNodes(val, fullPath));

            // Add personas in this folder
            for (const p of (val._personas || [])) {
                children.push({ type: 'persona', persona: p });
            }

            if (children.length === 0) continue;

            nodes.push({
                type: 'folder',
                name: key,
                label: meta?.label || key.charAt(0).toUpperCase() + key.slice(1),
                description: meta?.description || '',
                path: fullPath,
                count: countPersonas(val),
                children
            });
        }
        return nodes;
    }

    const tree = mapToNodes(root, '');

    // Add root-level personas (ones with no folder)
    for (const p of root._personas) {
        tree.push({ type: 'persona', persona: p });
    }

    return tree;
}

function renderCommunityTree() {
    const container = document.getElementById('community-tree');
    if (!container) return;

    const tree = buildTree();
    if (tree.length === 0) {
        container.innerHTML = '<p><small>No personas found.</small></p>';
        return;
    }

    container.innerHTML = renderTreeNodes(tree, 0);
}

function renderTreeNodes(nodes, depth) {
    let html = '';
    for (const node of nodes) {
        if (node.type === 'folder') {
            const isExpanded = communityExpandedFolders.has(node.path);
            const chevron = isExpanded ? '&#9660;' : '&#9654;';
            const escapedPath = node.path.replace(/'/g, "\\'");
            html += `<div class="tree-folder${isExpanded ? ' open' : ''}" style="padding-left:${depth * 1.25}rem">`;
            html += `<div class="tree-folder-header" onclick="toggleFolder('${escapedPath}')">`;
            html += `<span class="tree-chevron">${chevron}</span>`;
            html += `<span class="tree-folder-icon">${isExpanded ? '&#128194;' : '&#128193;'}</span>`;
            html += `<span class="tree-folder-name">${node.label}</span>`;
            html += `<span class="tree-folder-count">${node.count}</span>`;
            html += `</div>`;
            if (isExpanded && node.children.length > 0) {
                html += `<div class="tree-folder-children">`;
                html += renderTreeNodes(node.children, depth + 1);
                html += `</div>`;
            }
            html += `</div>`;
        } else {
            const p = node.persona;
            const escapedPath = p.path.replace(/'/g, "\\'");
            const badge = p.installed
                ? '<span class="tree-badge-installed">Installed</span>'
                : '';
            const tagsHtml = (p.tags || []).map(t =>
                `<span class="tree-tag">${t}</span>`
            ).join('');
            html += `<div class="tree-persona" style="padding-left:${(depth * 1.25) + 1.25}rem" onclick="previewCommunityPersona('${escapedPath}')">`;
            const contributor = p.contributor || p.author || '';
            const contributorHtml = contributor
                ? `<span class="tree-persona-author">by <a href="https://github.com/${contributor}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:inherit; text-decoration:underline dotted">${contributor}</a></span>`
                : '';
            html += `<div class="tree-persona-header">`;
            html += `<span class="tree-persona-icon">&#128196;</span>`;
            html += `<span class="tree-persona-name">${p.name}</span>`;
            html += badge;
            html += contributorHtml;
            html += `</div>`;
            html += `<div class="tree-persona-desc">${p.description || ''}</div>`;
            if (tagsHtml) html += `<div class="tree-persona-tags">${tagsHtml}</div>`;
            html += `</div>`;
        }
    }
    return html;
}

async function previewCommunityPersona(personaPath) {
    const tree = document.getElementById('community-tree');
    const search = document.getElementById('community-search');
    const preview = document.getElementById('community-preview');
    if (!preview || !communityIndex?.personas) return;

    communitySelectedPath = personaPath;
    const persona = communityIndex.personas.find(p => p.path === personaPath);
    if (!persona) return;

    document.getElementById('community-preview-name').textContent = persona.name;
    const contributorName = persona.contributor || persona.author || '';
    const authorEl = document.getElementById('community-preview-author');
    if (contributorName) {
        authorEl.innerHTML = `contributed by <a href="https://github.com/${contributorName}" target="_blank" rel="noopener" style="color:inherit; text-decoration:underline dotted">${contributorName}</a>`;
    } else {
        authorEl.textContent = '';
    }
    document.getElementById('community-preview-description').textContent = persona.description || '';

    const tagsContainer = document.getElementById('community-preview-tags');
    tagsContainer.innerHTML = (persona.tags || []).map(t =>
        `<span style="background:var(--pico-secondary-background, #e0e0e0); color:var(--pico-secondary-inverse, #333); padding:0.1rem 0.45rem; border-radius:999px; font-size:0.7rem;">${t}</span>`
    ).join(' ');

    // Fetch full persona file for preview
    const promptEl = document.getElementById('community-preview-prompt');
    promptEl.textContent = 'Loading...';
    try {
        const repo = communityIndex.repo || '';
        const url = `https://raw.githubusercontent.com/${repo}/main/${personaPath}`;
        const res = await fetch(url);
        if (res.ok) {
            const content = await res.text();
            const match = content.match(/\[system_prompt\]\n([\s\S]*?)(?=\n\[(?:voice|tts_style|meta)\]|$)/);
            promptEl.textContent = match ? match[1].trim() : content;
        } else {
            promptEl.textContent = 'Failed to load preview.';
        }
    } catch (e) {
        promptEl.textContent = 'Failed to load preview.';
    }

    // Update install button
    const installBtn = document.getElementById('community-install-btn');
    if (persona.installed) {
        installBtn.textContent = 'Reinstall (Overwrite)';
        installBtn.className = 'outline';
    } else {
        installBtn.textContent = 'Install Persona';
        installBtn.className = '';
    }

    if (tree) tree.style.display = 'none';
    if (search) search.style.display = 'none';
    preview.style.display = 'block';
}

function closeCommunityPreview() {
    const tree = document.getElementById('community-tree');
    const search = document.getElementById('community-search');
    const preview = document.getElementById('community-preview');
    if (preview) preview.style.display = 'none';
    if (tree) tree.style.display = '';
    if (search) search.style.display = '';
    communitySelectedPath = null;
}

async function installCommunityPersona() {
    if (!communitySelectedPath) return;

    const persona = communityIndex?.personas?.find(p => p.path === communitySelectedPath);
    const name = persona?.name || communitySelectedPath;

    if (persona?.installed && !confirm(`Persona "${name}" is already installed. Overwrite with the community version?`)) return;

    const btn = document.getElementById('community-install-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Installing...'; }

    try {
        const res = await fetch(`${BASE}/api/community-personas/install`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: communitySelectedPath, force: persona?.installed || false })
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            if (data.exists && confirm(`Persona "${name}" already exists. Overwrite it?`)) {
                const retryRes = await fetch(`${BASE}/api/community-personas/install`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: communitySelectedPath, force: true })
                });
                if (!retryRes.ok) throw new Error('Failed to install');
            } else if (data.exists) {
                if (btn) { btn.disabled = false; btn.textContent = 'Install Persona'; }
                return;
            } else {
                throw new Error(data.error || 'Failed to install');
            }
        }

        showToast(`Persona "${name}" installed successfully!`, 'success');
        setTimeout(() => location.reload(), 800);
    } catch (e) {
        showToast(e.message || 'Failed to install persona', 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Install Persona'; }
    }
}
