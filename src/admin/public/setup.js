// Setup Wizard — Frontend Logic

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

const TOTAL_STEPS = 10;
let currentStep = 0;
let apiKeyValidated = false;
let connectedPushname = '';
let selectedPersona = 'default';
let qrPollInterval = null;

// --- Step Navigation ---

function showStep(n) {
    document.querySelectorAll('.wizard-step').forEach(el => el.classList.remove('active'));
    const step = document.querySelector(`.wizard-step[data-step="${n}"]`);
    if (step) step.classList.add('active');
    currentStep = n;
    updateStepIndicator();

    // Trigger per-step actions
    if (n === 3) startQrPolling();
    if (n === 5) loadPersonas();
    if (n === 6) updateMentionExample();
    if (n === 9) updateSummary();

    // Auto-focus the first input in the new step
    const firstInput = step?.querySelector('input:not([type="radio"]):not([type="checkbox"])');
    if (firstInput) setTimeout(() => firstInput.focus(), 50);
}

function wizardNext() {
    if (currentStep < TOTAL_STEPS - 1) {
        showStep(currentStep + 1);
    }
}

function wizardBack() {
    if (currentStep > 0) {
        showStep(currentStep - 1);
    }
}

function updateStepIndicator() {
    const container = document.getElementById('step-indicator');
    container.innerHTML = '';
    for (let i = 0; i < TOTAL_STEPS; i++) {
        const dot = document.createElement('div');
        dot.className = 'step-dot';
        if (i < currentStep) dot.classList.add('done');
        if (i === currentStep) dot.classList.add('current');
        container.appendChild(dot);
    }
}

// --- Step 2: Validate API Key ---

async function validateApiKey() {
    const input = document.getElementById('api-key');
    const status = document.getElementById('api-key-status');
    const btn = document.getElementById('validate-key-btn');
    const key = input.value.trim();

    if (!key) {
        status.innerHTML = '<span class="status-badge error">Please enter an API key</span>';
        return;
    }

    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    status.innerHTML = '<span class="status-badge waiting">Validating...</span>';

    try {
        const res = await fetch(`${BASE}/api/setup/validate-key`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey: key })
        });
        const data = await res.json();
        if (data.valid) {
            status.innerHTML = '<span class="status-badge success">Valid! API key works.</span>';
            apiKeyValidated = true;
            // Auto-advance after brief delay
            setTimeout(() => wizardNext(), 800);
        } else {
            status.innerHTML = `<span class="status-badge error">${data.error || 'Invalid key'}</span>`;
            apiKeyValidated = false;
        }
    } catch (err) {
        status.innerHTML = '<span class="status-badge error">Network error. Please try again.</span>';
    } finally {
        btn.removeAttribute('aria-busy');
        btn.disabled = false;
    }
}

// --- Step 3: Save Credentials ---

async function saveCredentials() {
    const password = document.getElementById('admin-password').value;
    const confirm = document.getElementById('admin-password-confirm').value;
    const status = document.getElementById('password-status');
    const btn = document.getElementById('save-creds-btn');
    const apiKey = document.getElementById('api-key').value.trim();

    if (!apiKey) {
        status.innerHTML = '<span class="status-badge error">Go back and enter your API key first.</span>';
        return;
    }
    if (password.length < 8) {
        status.innerHTML = '<span class="status-badge error">Password must be at least 8 characters.</span>';
        return;
    }
    if (password !== confirm) {
        status.innerHTML = '<span class="status-badge error">Passwords don\'t match.</span>';
        return;
    }

    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    status.innerHTML = '<span class="status-badge waiting">Saving...</span>';

    try {
        // Save credentials to .env
        const res = await fetch(`${BASE}/api/setup/save-credentials`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey, adminPassword: password })
        });
        const data = await res.json();
        if (!res.ok) {
            status.innerHTML = `<span class="status-badge error">${data.error || 'Failed to save'}</span>`;
            return;
        }

        status.innerHTML = '<span class="status-badge success">Saved! Starting WhatsApp connection...</span>';

        // Trigger WhatsApp connection (fallback — backend also starts it on save-credentials)
        try {
            const connRes = await fetch(`${BASE}/api/connection/connect`, { method: 'POST' });
            console.log('[Setup] Connect response:', connRes.status, await connRes.clone().text());
        } catch (e) {
            console.warn('[Setup] Connect call failed (connection may already be starting):', e.message);
        }

        // Move to QR step
        setTimeout(() => wizardNext(), 500);
    } catch (err) {
        status.innerHTML = '<span class="status-badge error">Network error. Please try again.</span>';
    } finally {
        btn.removeAttribute('aria-busy');
        btn.disabled = false;
    }
}

// --- Step 4: QR Code Polling ---

function startQrPolling() {
    if (qrPollInterval) clearInterval(qrPollInterval);

    // If we resumed at the QR step, the connection may not have been started yet — kick it off
    fetch(`${BASE}/api/setup/ensure-connection`, { method: 'POST' }).catch(() => {});

    const qrImg = document.getElementById('qr-img-setup');
    const badge = document.getElementById('connection-status-badge');
    const qrSection = document.getElementById('qr-section');
    const connectedSection = document.getElementById('connected-section');

    async function poll() {
        try {
            const res = await fetch(`${BASE}/api/connection/status`);
            if (!res.ok) {
                console.warn('[Setup] Connection status poll failed:', res.status, await res.text());
                return;
            }
            const data = await res.json();
            console.log('[Setup] Connection status:', data.status, data.qrDataUrl ? '(QR available)' : '');

            if (data.status === 'qr' && data.qrDataUrl) {
                badge.className = 'status-badge waiting';
                badge.textContent = 'Scan the QR code with WhatsApp';
                qrImg.src = data.qrDataUrl;
                qrImg.style.display = 'block';
            } else if (data.status === 'loading') {
                badge.className = 'status-badge waiting';
                badge.textContent = 'Connecting...';
            } else if (data.status === 'ready') {
                clearInterval(qrPollInterval);
                qrPollInterval = null;

                // Show connected state
                qrSection.style.display = 'none';
                connectedSection.style.display = 'block';

                const pushname = data.info?.pushname || 'Bot';
                const phone = data.info?.phone || '';
                connectedPushname = pushname;
                document.getElementById('connected-name').textContent = pushname;
                document.getElementById('connected-phone').textContent = phone ? `+${phone}` : '';

                // Pre-fill bot name with WhatsApp pushname
                const botNameInput = document.getElementById('bot-name');
                if (botNameInput.value === 'Wisp' || !botNameInput.value) {
                    botNameInput.value = pushname;
                }
            } else if (data.status === 'waiting') {
                badge.className = 'status-badge waiting';
                badge.textContent = 'Waiting for QR code...';
            }
        } catch {
            // Silently ignore poll errors
        }
    }

    poll();
    qrPollInterval = setInterval(poll, 3000);
}

// --- Step 6: Load Personas ---

let personasLoaded = false;

async function loadPersonas() {
    if (personasLoaded) return;

    const grid = document.getElementById('persona-grid');
    try {
        const res = await fetch(`${BASE}/api/setup/personas`);
        const data = await res.json();

        if (data.personas && data.personas.length > 0) {
            grid.innerHTML = '';
            for (const p of data.personas) {
                const card = document.createElement('div');
                card.className = 'persona-card' + (p.name === selectedPersona ? ' selected' : '');
                card.dataset.persona = p.name;
                card.innerHTML = `<h6>${p.name}</h6><small>${p.description || 'No description'}</small>`;
                card.addEventListener('click', () => selectPersona(p.name));
                grid.appendChild(card);
            }
            personasLoaded = true;
        }
    } catch {
        // Keep the default card on error
    }
}

function selectPersona(name) {
    selectedPersona = name;
    document.querySelectorAll('.persona-card').forEach(card => {
        card.classList.toggle('selected', card.dataset.persona === name);
    });
}

// --- Bot Trigger: update mention example and TTS sections ---

function updateMentionExample() {
    const botName = document.getElementById('bot-name').value || 'YourBot';
    const mentionExample = document.getElementById('mention-example');
    if (mentionExample) mentionExample.textContent = '@' + botName;
}

function updateTtsSections() {
    const listening = document.querySelector('input[name="active-listening"]:checked')?.value;
    const sectionMention = document.getElementById('tts-section-mention');
    const sectionActive = document.getElementById('tts-section-active');
    if (listening === 'on') {
        sectionMention.style.display = 'none';
        sectionActive.style.display = 'block';
    } else {
        sectionMention.style.display = 'block';
        sectionActive.style.display = 'none';
    }
}

function updateTtsTriggerExample() {
    const trigger = document.getElementById('tts-trigger').value || '$audio';
    const example = document.getElementById('tts-trigger-example');
    if (example) example.textContent = `"${trigger} what's the weather?"`;
}

document.addEventListener('DOMContentLoaded', async () => {
    updateStepIndicator();

    // Check if we can resume from a previous session
    try {
        const res = await fetch(`${BASE}/api/setup/progress`);
        const progress = await res.json();
        if (progress.resumeStep > 0) {
            // Pre-fill bot name if we have it
            if (progress.botName) {
                document.getElementById('bot-name').value = progress.botName;
            }
            if (progress.persona && progress.persona !== 'default') {
                selectedPersona = progress.persona;
            }
            // Mark API key as validated if it exists
            if (progress.hasApiKey) {
                apiKeyValidated = true;
            }
            showStep(progress.resumeStep);
        }
    } catch {
        // Ignore — start from step 0
    }

    // Active listening radio toggle — switch TTS sections
    document.querySelectorAll('input[name="active-listening"]').forEach(radio => {
        radio.addEventListener('change', updateTtsSections);
    });

    // TTS trigger input — update example
    const ttsTriggerInput = document.getElementById('tts-trigger');
    if (ttsTriggerInput) {
        ttsTriggerInput.addEventListener('input', updateTtsTriggerExample);
    }

    // Spending limit radio toggle
    document.querySelectorAll('input[name="spending-limit"]').forEach(radio => {
        radio.addEventListener('change', () => {
            const row = document.getElementById('spending-limit-row');
            const hasLimit = (radio.value === 'monthly' || radio.value === 'manual') && radio.checked;
            row.style.display = hasLimit ? 'block' : 'none';
            if (hasLimit) {
                setTimeout(() => document.getElementById('spending-limit-amount').focus(), 50);
            }
        });
    });
});

// --- Step 10: Summary ---

function updateSummary() {
    const botName = document.getElementById('bot-name').value || 'Wisp';
    const listening = document.querySelector('input[name="active-listening"]:checked')?.value;
    const memories = document.querySelector('input[name="memories"]:checked')?.value;

    document.getElementById('summary-name').textContent = botName;
    document.getElementById('summary-persona').textContent = selectedPersona;
    document.getElementById('summary-listening').textContent = listening === 'on' ? 'On' : 'Off (mention only)';
    document.getElementById('summary-memories').textContent = memories === 'on' ? 'On' : 'Off';

    const spendingRadio = document.querySelector('input[name="spending-limit"]:checked')?.value;
    let spendingText = 'No limit';
    if (spendingRadio === 'monthly' || spendingRadio === 'manual') {
        const val = document.getElementById('spending-limit-amount').value;
        if (val) {
            spendingText = spendingRadio === 'monthly' ? `$${val}/month (auto-reset)` : `$${val} (manual reset)`;
        } else {
            spendingText = spendingRadio === 'monthly' ? 'Monthly (not set)' : 'Hard cap (not set)';
        }
    }
    document.getElementById('summary-spending').textContent = spendingText;
    document.getElementById('summary-mention').textContent = '@' + botName;
}

// --- Finish Setup ---

async function finishSetup() {
    const botName = document.getElementById('bot-name').value || 'Wisp';
    const listening = document.querySelector('input[name="active-listening"]:checked')?.value === 'on';
    const memories = document.querySelector('input[name="memories"]:checked')?.value === 'on';
    const spendingMode = document.querySelector('input[name="spending-limit"]:checked')?.value;
    const spendingLimit = (spendingMode === 'monthly' || spendingMode === 'manual')
        ? (parseFloat(document.getElementById('spending-limit-amount').value) || null)
        : null;
    const ttsTrigger = document.getElementById('tts-trigger')?.value?.trim() || '$audio';

    try {
        // Save settings
        await fetch(`${BASE}/api/setup/save-settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                botName,
                persona: selectedPersona,
                activeListening: listening,
                memories,
                spendingLimit,
                spendingMode: spendingLimit ? spendingMode : null,
                ttsTrigger: listening ? null : ttsTrigger
            })
        });

        // Mark setup as complete
        await fetch(`${BASE}/api/setup/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        // Start the WhatsApp connection now that setup is done
        await fetch(`${BASE}/api/connection/connect`, { method: 'POST' }).catch(() => {});

        showToast('Setup complete! Opening admin panel...', 'success');
        setTimeout(() => {
            window.open(`${BASE}/login`, '_blank');
        }, 1500);
    } catch (err) {
        showToast('Error completing setup. Please try again.', 'error');
    }
}

// --- Toast ---

function showToast(message, type) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    setTimeout(() => toast.classList.remove('show'), 3000);
}
