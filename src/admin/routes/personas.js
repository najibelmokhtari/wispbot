const express = require('express');
const router = express.Router();
const path = require('path');
const crypto = require('crypto');
const fs = require('fs').promises;
const logger = require('../../logger');
const config = require('../../config');
const { parsePersonaFile, serializePersona } = require('../../persona-parser');

const PERSONAS_DIR = path.join(__dirname, '..', '..', '..', 'prompts', 'personas');
const TTS_VOICES = require('../../config/gemini-tts-voices.json');

// Helper: list available persona names from files
async function getPersonaNames() {
    const files = await fs.readdir(PERSONAS_DIR);
    const names = files
        .filter(f => f.endsWith('.persona') && f !== 'default.persona')
        .map(f => f.slice(0, -8))
        .sort();
    return ['default', ...names];
}

// Helper: read and parse a .persona file
async function readPersona(name) {
    const filePath = path.join(PERSONAS_DIR, `${name}.persona`);
    const raw = await fs.readFile(filePath, 'utf8');
    return parsePersonaFile(raw);
}

// Helper: read, update a field, and write back a .persona file
async function updatePersonaField(name, field, value) {
    let persona;
    try {
        persona = await readPersona(name);
    } catch {
        persona = { meta: {}, voice: '', systemPrompt: '', ttsStyle: '' };
    }
    // Support dotted paths like "meta.description"
    if (field.includes('.')) {
        const parts = field.split('.');
        let obj = persona;
        for (let i = 0; i < parts.length - 1; i++) {
            if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
            obj = obj[parts[i]];
        }
        obj[parts[parts.length - 1]] = value;
    } else {
        persona[field] = value;
    }
    await fs.writeFile(path.join(PERSONAS_DIR, `${name}.persona`), serializePersona(persona), 'utf8');
}

// Helper: check which personas have been modified from their community source
async function getCommunityModifiedSet(names) {
    const modified = new Set();
    for (const name of names) {
        if (name === 'default') continue;
        try {
            const persona = await readPersona(name);
            if (persona.meta?.community_source && persona.meta?.community_hash) {
                const fingerprint = `${persona.systemPrompt}\0${persona.voice}\0${persona.ttsStyle}`;
                const currentHash = crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 16);
                if (currentHash !== persona.meta.community_hash) {
                    modified.add(name);
                }
            }
        } catch { /* skip unreadable personas */ }
    }
    return modified;
}

// Helper: get descriptions for all personas
async function getPersonaDescriptions(names) {
    const descriptions = {};
    for (const name of names) {
        try {
            const persona = await readPersona(name);
            if (persona.meta?.description) {
                descriptions[name] = persona.meta.description;
            }
        } catch { /* skip unreadable */ }
    }
    return descriptions;
}

// Personas page
router.get('/personas', async (req, res) => {
    try {
        const personas = await getPersonaNames();
        const communityModified = await getCommunityModifiedSet(personas);
        const personaDescriptions = await getPersonaDescriptions(personas);
        res.render('personas', { personas, communityModified, personaDescriptions, ttsVoices: TTS_VOICES, communityRepo: config.communityPersonasRepo });
    } catch (error) {
        logger.error('Admin', 'Error loading personas page: ' + error.message);
        res.status(500).send('Failed to load personas');
    }
});

// API: list personas
router.get('/api/personas', async (req, res) => {
    try {
        const names = await getPersonaNames();
        res.json(names);
    } catch (error) {
        res.status(500).json({ error: 'Failed to list personas' });
    }
});

// API: get persona content
router.get('/api/personas/:name', async (req, res) => {
    try {
        const name = req.params.name;
        if (!/^[a-z0-9_]+$/.test(name)) return res.status(400).json({ error: 'Invalid persona name' });
        if (name === 'default') return res.json({ content: '', description: '' });
        const persona = await readPersona(name);
        const result = { content: persona.systemPrompt, description: persona.meta?.description || '' };

        // Check if this is a community persona that was locally modified
        if (persona.meta?.community_source) {
            result.communitySource = persona.meta.community_source;
            const fingerprint = `${persona.systemPrompt}\0${persona.voice}\0${persona.ttsStyle}`;
            const currentHash = crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 16);
            result.communityModified = currentHash !== persona.meta.community_hash;
        }

        res.json(result);
    } catch (error) {
        res.status(404).json({ error: 'Persona not found' });
    }
});

// API: save persona content
router.post('/api/personas/:name', async (req, res) => {
    try {
        const name = req.params.name;
        if (!/^[a-z0-9_]+$/.test(name)) return res.status(400).json({ error: 'Invalid persona name' });
        if (name.length > 30) return res.status(400).json({ error: 'Persona name must be 30 characters or less' });
        if (name === 'default') return res.status(400).json({ error: 'Cannot edit the default persona (it uses base instructions only)' });
        await updatePersonaField(name, 'systemPrompt', req.body.content || '');

        // Save description if provided
        if (req.body.description !== undefined) {
            await updatePersonaField(name, 'meta.description', req.body.description);
        }

        // Hot-reload the in-memory prompt so the bot picks up the change immediately
        if (req.sharedState?.messageQueueManager) {
            await req.sharedState.messageQueueManager.reloadPrompt(name);
        }
        res.json({ success: true });
    } catch (error) {
        logger.error('Admin', 'Error saving persona: ' + error.message);
        res.status(500).json({ error: 'Failed to save persona' });
    }
});

// API: save persona description
router.post('/api/personas/:name/description', async (req, res) => {
    try {
        const name = req.params.name;
        if (!/^[a-z0-9_]+$/.test(name)) return res.status(400).json({ error: 'Invalid persona name' });
        if (name === 'default') return res.status(400).json({ error: 'Cannot edit the default persona description' });
        await updatePersonaField(name, 'meta.description', (req.body.description || '').trim());
        res.json({ success: true });
    } catch (error) {
        logger.error('Admin', 'Error saving persona description: ' + error.message);
        res.status(500).json({ error: 'Failed to save description' });
    }
});

// API: delete persona
router.delete('/api/personas/:name', async (req, res) => {
    try {
        const name = req.params.name;
        if (name === 'default') return res.status(400).json({ error: 'Cannot delete the default persona' });
        if (!/^[a-z0-9_]+$/.test(name)) return res.status(400).json({ error: 'Invalid persona name' });
        await fs.unlink(path.join(PERSONAS_DIR, `${name}.persona`));
        res.json({ success: true });
    } catch (error) {
        if (error.code === 'ENOENT') return res.status(404).json({ error: 'Persona not found' });
        logger.error('Admin', 'Error deleting persona: ' + error.message);
        res.status(500).json({ error: 'Failed to delete persona' });
    }
});

// API: get persona TTS settings (voice + style prompt)
router.get('/api/personas/:name/tts', async (req, res) => {
    try {
        const name = req.params.name;
        if (!/^[a-z0-9_]+$/.test(name)) return res.status(400).json({ error: 'Invalid persona name' });
        const persona = await readPersona(name);
        res.json({ voice: persona.voice, stylePrompt: persona.ttsStyle });
    } catch (error) {
        res.json({ voice: '', stylePrompt: '' });
    }
});

// API: save persona TTS voice
router.post('/api/personas/:name/tts/voice', async (req, res) => {
    try {
        const name = req.params.name;
        if (!/^[a-z0-9_]+$/.test(name)) return res.status(400).json({ error: 'Invalid persona name' });
        await updatePersonaField(name, 'voice', (req.body.voice || '').trim());

        if (req.sharedState?.messageQueueManager) {
            await req.sharedState.messageQueueManager.reloadPrompt(name === 'default' ? 'base' : name);
        }
        res.json({ success: true });
    } catch (error) {
        logger.error('Admin', `Error saving persona TTS voice: ${error.message}`);
        res.status(500).json({ error: 'Failed to save TTS voice' });
    }
});

// API: save persona TTS style prompt
router.post('/api/personas/:name/tts/style', async (req, res) => {
    try {
        const name = req.params.name;
        if (!/^[a-z0-9_]+$/.test(name)) return res.status(400).json({ error: 'Invalid persona name' });
        await updatePersonaField(name, 'ttsStyle', req.body.content || '');

        if (req.sharedState?.messageQueueManager) {
            await req.sharedState.messageQueueManager.reloadPrompt(name === 'default' ? 'base' : name);
        }
        res.json({ success: true });
    } catch (error) {
        logger.error('Admin', `Error saving persona TTS style: ${error.message}`);
        res.status(500).json({ error: 'Failed to save TTS style prompt' });
    }
});

// --- Community Personas ---

let communityIndexCache = null;
let communityIndexCacheTime = 0;
const COMMUNITY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getGitHubHeaders() {
    const headers = { 'Accept': 'application/json', 'User-Agent': 'wispbot' };
    if (config.communityPersonasToken) {
        headers['Authorization'] = `token ${config.communityPersonasToken}`;
    }
    return headers;
}

// API: get community personas index
router.get('/api/community-personas', async (req, res) => {
    try {
        const repo = config.communityPersonasRepo;
        if (!repo) {
            return res.status(404).json({ error: 'Community personas repo not configured' });
        }

        // Return cached if fresh
        if (communityIndexCache && (Date.now() - communityIndexCacheTime) < COMMUNITY_CACHE_TTL) {
            return res.json(communityIndexCache);
        }

        const url = `https://raw.githubusercontent.com/${repo}/main/index.json`;
        const response = await fetch(url, { headers: getGitHubHeaders() });
        if (!response.ok) {
            throw new Error(`GitHub returned ${response.status}`);
        }
        const data = await response.json();

        // Enrich with local install status
        let localPersonas;
        try {
            localPersonas = new Set(await getPersonaNames());
        } catch {
            localPersonas = new Set();
        }
        if (data.personas) {
            for (const p of data.personas) {
                p.installed = localPersonas.has(p.name);
            }
        }

        communityIndexCache = data;
        communityIndexCacheTime = Date.now();
        res.json(data);
    } catch (error) {
        logger.error('Admin', 'Error fetching community personas index: ' + error.message);
        res.status(502).json({ error: 'Failed to fetch community personas. Check your internet connection and repo configuration.' });
    }
});

// API: install a community persona
router.post('/api/community-personas/install', async (req, res) => {
    try {
        const { path: personaPath } = req.body;
        if (!personaPath || typeof personaPath !== 'string') {
            return res.status(400).json({ error: 'Missing persona path' });
        }

        // Extract name from path (e.g. "english/professor.persona" -> "professor")
        const basename = personaPath.split('/').pop();
        if (!basename || !basename.endsWith('.persona')) {
            return res.status(400).json({ error: 'Invalid persona file path' });
        }
        const name = basename.slice(0, -8);
        if (!/^[a-z0-9_]+$/.test(name)) {
            return res.status(400).json({ error: 'Invalid persona name' });
        }
        if (name === 'default') {
            return res.status(400).json({ error: 'Cannot overwrite the default persona' });
        }

        // Check if already exists
        const localPath = path.join(PERSONAS_DIR, `${name}.persona`);
        try {
            await fs.access(localPath);
            // File exists — check if force flag is set
            if (!req.body.force) {
                return res.status(409).json({ error: `Persona "${name}" already exists. Set force=true to overwrite.`, exists: true });
            }
        } catch {
            // File doesn't exist, good
        }

        // Fetch the raw persona file from GitHub
        const repo = config.communityPersonasRepo;
        const url = `https://raw.githubusercontent.com/${repo}/main/${personaPath}`;
        const response = await fetch(url, { headers: getGitHubHeaders() });
        if (!response.ok) {
            throw new Error(`GitHub returned ${response.status} for ${personaPath}`);
        }
        const content = await response.text();

        // Validate: must be parseable
        const parsed = parsePersonaFile(content);
        if (!parsed.systemPrompt && !parsed.voice && !parsed.ttsStyle) {
            return res.status(400).json({ error: 'Persona file appears to be empty or invalid' });
        }

        // Stamp community origin into meta so we can detect local modifications
        parsed.meta.community_source = personaPath;
        const fingerprint = `${parsed.systemPrompt}\0${parsed.voice}\0${parsed.ttsStyle}`;
        parsed.meta.community_hash = crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 16);

        // Save to local personas directory
        await fs.writeFile(localPath, serializePersona(parsed), 'utf8');

        // Invalidate community cache so install status updates
        communityIndexCache = null;

        // Hot-reload the in-memory prompt so the bot picks up the new persona immediately
        if (req.sharedState?.messageQueueManager) {
            await req.sharedState.messageQueueManager.reloadPrompt(name);
        }

        logger.info('Admin', `Community persona "${name}" installed from ${personaPath}`);
        res.json({ success: true, name });
    } catch (error) {
        logger.error('Admin', 'Error installing community persona: ' + error.message);
        res.status(500).json({ error: 'Failed to install community persona' });
    }
});

module.exports = router;
