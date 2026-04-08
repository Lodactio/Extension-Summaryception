/**
 * Summaryception v3 — Layered Recursive Summarization for SillyTavern
 *
 * NON-DESTRUCTIVE: Uses SillyTavern's built-in message hiding (ghosting)
 * to exclude summarized messages from the LLM context while keeping them
 * fully visible and readable in the chat UI.
 *
 * Uses a context-aware summarizer prompt that builds incrementally:
 *   - prior_context = that layer's existing summaries
 *   - passage_in_question = the new content to summarize
 *   - player_name = active persona name
 *
 * AGPL-3.0
 */

const MODULE_NAME = 'summaryception';
const LOG_PREFIX = '[Summaryception]';

// ─── Default Settings ────────────────────────────────────────────────

const defaultSettings = Object.freeze({
    enabled: true,
    verbatimTurns: 7,
    turnsPerSummary: 3,
    snippetsPerLayer: 20,
    snippetsPerPromotion: 2,
    maxLayers: 5,
    injectionTemplate: '[Narrative Memory — oldest → most recent]\n{{summary}}',

    summarizerSystemPrompt:
        'You are a precise narrative-state tracker. You output only the summary line — no preamble, no commentary, no markdown.',

    summarizerUserPrompt:
`<player_name>{{player_name}}</player_name>
<prior_context>{{context_str}}</prior_context>
<passage_in_question>{{story_txt}}</passage_in_question>

Summarize only the necessary elements from the Passage_in_Question to coherently continue the Prior_Context, focusing on story, plot points, plans, tasks, quests, significant changes to player/world/setting.
Exclude anything insubstantial, fluff, atmospheric details, or events already covered in Prior Context.
Skip any passages that are empty, unclear, or lack significant content.
Write in short phrases, no more than 20; output must be a single line:`,

    debugMode: false,
});

// ─── Helpers ─────────────────────────────────────────────────────────

function log(...args) {
    if (getSettings().debugMode) console.log(LOG_PREFIX, ...args);
}

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

function getChatStore() {
    const { chatMetadata } = SillyTavern.getContext();
    if (!chatMetadata[MODULE_NAME]) {
        chatMetadata[MODULE_NAME] = {
            layers: [],
            summarizedUpTo: -1,  // chat index up to which we've already summarized
        };
    }
    return chatMetadata[MODULE_NAME];
}

async function saveChatStore() {
    await SillyTavern.getContext().saveMetadata();
}

function getPlayerName() {
    const ctx = SillyTavern.getContext();
    return ctx.name1 || 'User';
}

// ─── Message Hiding (Ghosting) ───────────────────────────────────────

/**
 * Hide a message from the LLM context using SillyTavern's /hide mechanism.
 * The message remains visible in the UI with a ghost icon.
 *
 * In SillyTavern, hidden messages have is_system = true internally,
 * which excludes them from the prompt context while keeping them in the UI.
 */
function hideMessage(messageIndex) {
    const { chat } = SillyTavern.getContext();
    const msg = chat[messageIndex];
    if (!msg) return;

    // Already hidden
    if (msg.is_system) return;

    // Set the is_system flag — this is how ST hides messages from context
    msg.is_system = true;

    // Update the UI to show the ghost icon
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageIndex}"]`);
    if (messageElement) {
        messageElement.setAttribute('is_system', 'true');
    }

    log(`Hidden (ghosted) message at index ${messageIndex}`);
}

/**
 * Unhide a message, restoring it to the LLM context.
 */
function unhideMessage(messageIndex) {
    const { chat } = SillyTavern.getContext();
    const msg = chat[messageIndex];
    if (!msg) return;

    msg.is_system = false;

    const messageElement = document.querySelector(`#chat .mes[mesid="${messageIndex}"]`);
    if (messageElement) {
        messageElement.setAttribute('is_system', 'false');
    }

    log(`Unhidden message at index ${messageIndex}`);
}

/**
 * Ghost all messages up to and including the given index.
 * Skips messages that are already system messages (narrator, etc.)
 * or that were originally user-hidden.
 */
function ghostMessagesUpTo(endIndex) {
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    for (let i = 0; i <= endIndex; i++) {
        const msg = chat[i];
        if (!msg) continue;

        // Skip the first message (greeting) — usually best to keep it
        if (i === 0) continue;

        // Skip already-system messages (narrator messages, etc.)
        // We only want to ghost regular user/assistant messages
        if (msg.is_system && !msg._sc_ghosted) continue;

        // Mark as ghosted by us so we can unghost later if needed
        msg._sc_ghosted = true;
        hideMessage(i);
    }

    log(`Ghosted messages from index 1 to ${endIndex}`);
}

// ─── Assistant Turn Utilities ────────────────────────────────────────

/**
 * Returns all assistant (character) turns as { index, mes, name } in order.
 * Counts both visible and ghosted assistant turns.
 */
function getAssistantTurns(chat) {
    const turns = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        // Include ghosted messages that we ghosted (they were originally assistant messages)
        const isOurGhost = m._sc_ghosted === true;
        const isAssistant = !m.is_user && (!m.is_system || isOurGhost);

        if (isAssistant && m.mes && m.mes.trim().length > 0) {
            turns.push({ index: i, mes: m.mes, name: m.name || 'Assistant' });
        }
    }
    return turns;
}

/**
 * Returns only non-ghosted (visible to LLM) assistant turns.
 */
function getVisibleAssistantTurns(chat) {
    const turns = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m.is_user && !m.is_system && m.mes && m.mes.trim().length > 0) {
            turns.push({ index: i, mes: m.mes, name: m.name || 'Assistant' });
        }
    }
    return turns;
}

/**
 * Given a range of chat indices, build a readable passage including both
 * user and assistant messages for context.
 */
function buildPassageFromRange(chat, startIdx, endIdx) {
    const lines = [];
    for (let i = startIdx; i <= endIdx; i++) {
        const m = chat[i];
        if (m && m.mes && m.mes.trim()) {
            const speaker = m.is_user ? (m.name || getPlayerName()) : (m.name || 'Assistant');
            lines.push(`${speaker}: ${m.mes.trim()}`);
        }
    }
    return lines.join('\n');
}

// ─── Prompt Toggle Management ────────────────────────────────────────

/**
 * Get all prompt manager entries (the toggleable items in Chat Completion presets).
 * Returns the array of prompt entries from the active preset.
 */
function getPromptManagerEntries() {
    try {
        const ctx = SillyTavern.getContext();
        // The prompt manager stores entries in the active preset's prompt_manager_settings
        if (ctx.promptManager) {
            return ctx.promptManager.getPromptCollection()?.collection || [];
        }
        // Fallback: access via oai_settings
        if (ctx.oai_settings?.prompt_manager_settings?.prompts) {
            return ctx.oai_settings.prompt_manager_settings.prompts;
        }
    } catch (e) {
        log('Could not access prompt manager entries:', e);
    }
    return [];
}

/**
 * Snapshot the current enabled/disabled state of all prompt toggles.
 * Returns a Map of identifier → boolean.
 */
function snapshotPromptToggles() {
    const snapshot = new Map();
    try {
        const ctx = SillyTavern.getContext();
        const promptManager = ctx.promptManager;

        if (!promptManager) {
            log('No prompt manager available, skipping toggle snapshot.');
            return snapshot;
        }

        const collection = promptManager.getPromptCollection();
        if (!collection?.collection) return snapshot;

        for (const entry of collection.collection) {
            // Each entry has an `identifier` and the toggle state is tracked
            // via the prompt order list with `enabled` flags
            const orderList = promptManager.getPromptOrderEntries();
            if (orderList) {
                for (const orderEntry of orderList) {
                    if (orderEntry.identifier === entry.identifier) {
                        snapshot.set(entry.identifier, orderEntry.enabled);
                    }
                }
            }
        }

        log(`Snapshot captured: ${snapshot.size} prompt toggles`);
    } catch (e) {
        log('Error capturing snapshot:', e);
    }
    return snapshot;
}

/**
 * Disable all prompt toggles (set enabled = false).
 */
function disableAllPromptToggles() {
    try {
        const ctx = SillyTavern.getContext();
        const promptManager = ctx.promptManager;
        if (!promptManager) return;

        const orderList = promptManager.getPromptOrderEntries();
        if (!orderList) return;

        let count = 0;
        for (const entry of orderList) {
            if (entry.enabled) {
                entry.enabled = false;
                count++;
            }
        }

        log(`Disabled ${count} prompt toggles`);
    } catch (e) {
        log('Error disabling prompt toggles:', e);
    }
}

/**
 * Restore prompt toggles from a previous snapshot.
 */
function restorePromptToggles(snapshot) {
    if (!snapshot || snapshot.size === 0) return;

    try {
        const ctx = SillyTavern.getContext();
        const promptManager = ctx.promptManager;
        if (!promptManager) return;

        const orderList = promptManager.getPromptOrderEntries();
        if (!orderList) return;

        let count = 0;
        for (const entry of orderList) {
            if (snapshot.has(entry.identifier)) {
                entry.enabled = snapshot.get(entry.identifier);
                count++;
            }
        }

        log(`Restored ${count} prompt toggles`);
    } catch (e) {
        log('Error restoring prompt toggles:', e);
    }
}

// ─── Core: LLM Summarization ────────────────────────────────────────

/**
 * Call the LLM with our context-aware summarizer prompt.
 * Disables all Chat Completion prompt toggles for the duration of the call,
 * then restores them afterward — so only our system prompt + user prompt are sent.
 */
async function callSummarizer(storyTxt, contextStr) {
    const { generateRaw } = SillyTavern.getContext();
    const s = getSettings();

    const prompt = s.summarizerUserPrompt
    .replace('{{player_name}}', getPlayerName())
    .replace('{{context_str}}', contextStr || '(none yet)')
    .replace('{{story_txt}}', storyTxt);

    log('── Summarizer Call ──');
    log('Context str length:', contextStr.length, 'chars');
    log('Story txt length:', storyTxt.length, 'chars');

    // *** Snapshot and disable all prompt toggles ***
    const snapshot = snapshotPromptToggles();
    disableAllPromptToggles();

    try {
        const result = await generateRaw({
            systemPrompt: s.summarizerSystemPrompt,
            prompt: prompt,
        });
        const trimmed = (result || '').trim();
        log('Result:', trimmed);
        return trimmed;
    } catch (err) {
        console.error(LOG_PREFIX, 'Summarization failed:', err);
        toastr.error('Summaryception: summarization failed — check console.', '', { timeOut: 5000 });
        return '';
    } finally {
        // *** ALWAYS restore, even if the call fails ***
        restorePromptToggles(snapshot);
    }
}

// ─── Core: Summarize Oldest Verbatim Turns ──────────────────────────

async function maybeSummarizeTurns() {
    const s = getSettings();
    if (!s.enabled) return;

    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    // Get ALL assistant turns (including ones we've already ghosted)
    const allAssistantTurns = getAssistantTurns(chat);

    // Get only the ones still visible to LLM
    const visibleAssistantTurns = getVisibleAssistantTurns(chat);

    log(`Visible assistant turns: ${visibleAssistantTurns.length}, limit: ${s.verbatimTurns}`);

    if (visibleAssistantTurns.length <= s.verbatimTurns) return;

    // Find turns that haven't been summarized yet (beyond summarizedUpTo)
    const unsummarized = allAssistantTurns.filter(t => t.index > store.summarizedUpTo);
    const unsummarizedVisible = unsummarized.filter(t => {
        const msg = chat[t.index];
        return !msg.is_system || msg._sc_ghosted; // not yet ghosted
    }).filter(t => !chat[t.index]._sc_ghosted); // truly visible

    if (unsummarizedVisible.length <= s.verbatimTurns) {
        log('All overflow already summarized and ghosted.');
        return;
    }

    const overflow = unsummarizedVisible.length - s.verbatimTurns;
    const batchSize = Math.min(overflow, s.turnsPerSummary);
    const batch = unsummarizedVisible.slice(0, batchSize);

    if (batch.length === 0) return;

    const startIdx = batch[0].index;
    const endIdx = batch[batch.length - 1].index;

    log(`Summarizing turns at indices ${startIdx}–${endIdx} (${batch.length} assistant turns)`);

    const storyTxt = buildPassageFromRange(chat, startIdx, endIdx);
    if (!storyTxt.trim()) return;

    // Build prior_context from Layer 0's existing snippets
    if (!store.layers[0]) store.layers[0] = [];
    const contextStr = store.layers[0].map(sn => sn.text).join(' | ');

    toastr.info(`Summarizing ${batch.length} turn${batch.length > 1 ? 's' : ''}…`, 'Summaryception', {
        timeOut: 3000,
        progressBar: true,
    });

    const summary = await callSummarizer(storyTxt, contextStr);
    if (!summary) return;

    // Store the snippet
    store.layers[0].push({
        text: summary,
        turnRange: [startIdx, endIdx],
        timestamp: Date.now(),
    });

    store.summarizedUpTo = Math.max(store.summarizedUpTo, endIdx);

    // *** GHOST the summarized messages instead of removing them ***
    ghostMessagesUpTo(endIdx);

    log(`Layer 0 now has ${store.layers[0].length} snippets`);

    // Check for layer promotion
    await maybePromoteLayer(0);

    await saveChatStore();

    // Save the chat to persist the ghosted state
    const { saveChat } = SillyTavern.getContext();
    if (typeof saveChat === 'function') {
        // Use the conditional save from context
        const ctx = SillyTavern.getContext();
        if (ctx.saveChat) await ctx.saveChat();
    }

    toastr.success(`Summary saved (Layer 0: ${store.layers[0].length} snippets)`, 'Summaryception', { timeOut: 2000 });

    // Recurse if there's still overflow
    await maybeSummarizeTurns();
}

// ─── Core: Layer Promotion ("ception") ──────────────────────────────

async function maybePromoteLayer(layerIndex) {
    const s = getSettings();
    const store = getChatStore();

    if (layerIndex >= s.maxLayers - 1) {
        log(`Max layer depth (${s.maxLayers}) reached.`);
        return;
    }

    const layer = store.layers[layerIndex];
    if (!layer || layer.length <= s.snippetsPerLayer) return;

    log(`Layer ${layerIndex}: ${layer.length} snippets > limit ${s.snippetsPerLayer} → promoting`);

    const toMerge = layer.splice(0, s.snippetsPerPromotion);
    const storyTxt = toMerge.map(sn => sn.text).join(' | ');

    if (!store.layers[layerIndex + 1]) store.layers[layerIndex + 1] = [];
    const contextStr = store.layers[layerIndex + 1].map(sn => sn.text).join(' | ');

    toastr.info(
        `Promoting ${toMerge.length} snippets: Layer ${layerIndex} → Layer ${layerIndex + 1}`,
        'Summaryception',
        { timeOut: 3000, progressBar: true }
    );

    const metaSummary = await callSummarizer(storyTxt, contextStr);
    if (!metaSummary) {
        layer.unshift(...toMerge);
        return;
    }

    store.layers[layerIndex + 1].push({
        text: metaSummary,
        fromLayer: layerIndex,
        mergedCount: toMerge.length,
        timestamp: Date.now(),
    });

    log(`Layer ${layerIndex + 1} now has ${store.layers[layerIndex + 1].length} snippets`);

    await maybePromoteLayer(layerIndex + 1);
}

// ─── Core: Assemble Full Summary Block ──────────────────────────────

function assembleSummaryBlock() {
    const s = getSettings();
    const store = getChatStore();

    if (!store.layers || store.layers.every(l => !l || l.length === 0)) return '';

    const parts = [];

    for (let i = store.layers.length - 1; i >= 0; i--) {
        const layer = store.layers[i];
        if (!layer || layer.length === 0) continue;

        const layerLabel = i === 0
            ? 'Recent Events'
            : `Deep Memory L${i}`;
        const snippets = layer.map(sn => sn.text).join(' | ');
        parts.push(`[${layerLabel}]: ${snippets}`);
    }

    if (parts.length === 0) return '';

    const summaryText = parts.join('\n');
    return s.injectionTemplate.replace('{{summary}}', summaryText);
}

// ─── Injection via setExtensionPrompt ────────────────────────────────

/**
 * Instead of manipulating the chat array at generation time, we use
 * SillyTavern's setExtensionPrompt to cleanly inject the summary block
 * into the prompt at a configurable depth. This is the recommended
 * approach for extensions.
 */
function updateInjection() {
    const { setExtensionPrompt } = SillyTavern.getContext();
    const s = getSettings();

    if (!s.enabled) {
        setExtensionPrompt(MODULE_NAME, '', 1, 0, false, 0);
        return;
    }

    const summaryBlock = assembleSummaryBlock();
    if (!summaryBlock) {
        setExtensionPrompt(MODULE_NAME, '', 1, 0, false, 0);
        return;
    }

    // Inject in-chat (position=1) at a depth just behind the verbatim turns
    // depth = verbatimTurns means it goes right before the oldest kept message
    const depth = s.verbatimTurns;

    // position: 1 = IN_CHAT, role: 0 = SYSTEM
    setExtensionPrompt(MODULE_NAME, summaryBlock, 1, depth, false, 0);

    log(`Injection updated: ${summaryBlock.length} chars at depth ${depth}`);
}

// ─── Event Handlers ──────────────────────────────────────────────────

function onMessageReceived(messageIndex) {
    const { chat } = SillyTavern.getContext();
    const msg = chat[messageIndex];
    if (msg && !msg.is_user && !msg.is_system) {
        log('New assistant message at index', messageIndex);
        setTimeout(async () => {
            await maybeSummarizeTurns();
            updateInjection();
            updateUI();
        }, 500);
    }
}

function onChatChanged() {
    log('Chat changed.');
    setTimeout(() => {
        updateInjection();
        updateUI();
    }, 100);
}

function onGenerationStarted() {
    // Refresh the injection right before generation
    updateInjection();
}

// ─── Slash Commands ──────────────────────────────────────────────────

function registerSlashCommands() {
    try {
        const { SlashCommandParser, SlashCommand } = SillyTavern.getContext();

        if (!SlashCommandParser?.addCommandObject) {
            log('SlashCommandParser not available, skipping command registration.');
            return;
        }

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-status',
            callback: () => {
                const store = getChatStore();
                const lines = ['**Summaryception Status**'];
                lines.push(`Summarized up to index: ${store.summarizedUpTo}`);
                if (store.layers) {
                    for (let i = 0; i < store.layers.length; i++) {
                        const l = store.layers[i];
                        if (l && l.length > 0) {
                            lines.push(`Layer ${i}: ${l.length} snippets`);
                        }
                    }
                }
                return lines.join('\n');
            },
            helpString: 'Show Summaryception layer status',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-clear',
            callback: async () => {
                const store = getChatStore();
                // Unghost all messages we ghosted
                const { chat } = SillyTavern.getContext();
                for (let i = 0; i < chat.length; i++) {
                    if (chat[i]._sc_ghosted) {
                        unhideMessage(i);
                        delete chat[i]._sc_ghosted;
                    }
                }
                store.layers = [];
                store.summarizedUpTo = -1;
                await saveChatStore();
                updateInjection();
                updateUI();
                return 'Summaryception memory cleared and messages unghosted.';
            },
            helpString: 'Clear all Summaryception memory and unghost messages for this chat',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-preview',
            callback: () => {
                return assembleSummaryBlock() || '(No summaries yet)';
            },
            helpString: 'Preview the summary block that would be injected',
        }));
    } catch (e) {
        log('Could not register slash commands:', e);
    }
}

// ─── Settings UI ─────────────────────────────────────────────────────

function updateUI() {
    const s = getSettings();
    const store = getChatStore();

    $('#sc_enabled').prop('checked', s.enabled);
    $('#sc_verbatim_turns').val(s.verbatimTurns);
    $('#sc_verbatim_turns_val').text(s.verbatimTurns);
    $('#sc_turns_per_summary').val(s.turnsPerSummary);
    $('#sc_turns_per_summary_val').text(s.turnsPerSummary);
    $('#sc_snippets_per_layer').val(s.snippetsPerLayer);
    $('#sc_snippets_per_layer_val').text(s.snippetsPerLayer);
    $('#sc_snippets_per_promotion').val(s.snippetsPerPromotion);
    $('#sc_snippets_per_promotion_val').text(s.snippetsPerPromotion);
    $('#sc_max_layers').val(s.maxLayers);
    $('#sc_max_layers_val').text(s.maxLayers);
    $('#sc_injection_template').val(s.injectionTemplate);
    $('#sc_summarizer_system_prompt').val(s.summarizerSystemPrompt);
    $('#sc_summarizer_user_prompt').val(s.summarizerUserPrompt);
    $('#sc_debug_mode').prop('checked', s.debugMode);

    // Count ghosted messages
    let ghostedCount = 0;
    try {
        const { chat } = SillyTavern.getContext();
        ghostedCount = chat.filter(m => m._sc_ghosted).length;
    } catch (e) { /* no chat loaded */ }

    // Layer stats
    let statsHtml = '';
    statsHtml += `<div class="sc-layer-stat">👻 <strong>${ghostedCount}</strong> messages ghosted (hidden from LLM, visible to you)</div>`;
    if (store.layers) {
        for (let i = store.layers.length - 1; i >= 0; i--) {
            const layer = store.layers[i];
            if (layer && layer.length > 0) {
                const label = i === 0 ? 'Layer 0 (turn summaries)' : `Layer ${i} (depth ${i} meta)`;
                statsHtml += `<div class="sc-layer-stat">
                    <span class="sc-layer-label">${label}:</span>
                    <strong>${layer.length}</strong> / ${s.snippetsPerLayer} snippets
                </div>`;
            }
        }
    }
    statsHtml += `<div class="sc-layer-stat sc-muted">Summarized up to chat index: ${store.summarizedUpTo ?? -1}</div>`;
    if (!store.layers?.length || store.layers.every(l => !l || l.length === 0)) {
        statsHtml = '<div class="sc-layer-stat sc-muted">No summaries yet for this chat.</div>';
    }
    $('#sc_layer_stats').html(statsHtml);

    // Preview
    const preview = assembleSummaryBlock();
    $('#sc_preview').val(preview || '(empty — no summaries yet)');

    // Snippet browser
    updateSnippetBrowser();
}

function updateSnippetBrowser() {
    const store = getChatStore();
    let html = '';

    if (!store.layers || store.layers.every(l => !l || l.length === 0)) {
        html = '<div class="sc-muted">No snippets to display.</div>';
    } else {
        for (let i = store.layers.length - 1; i >= 0; i--) {
            const layer = store.layers[i];
            if (!layer || layer.length === 0) continue;
            const label = i === 0 ? 'Layer 0 (Turn Summaries)' : `Layer ${i} (Meta-Summary)`;
            html += `<div class="sc-browser-layer"><div class="sc-browser-layer-title">${label}</div>`;
            for (let j = 0; j < layer.length; j++) {
                const sn = layer[j];
                const rangeStr = sn.turnRange
                    ? `turns ${sn.turnRange[0]}–${sn.turnRange[1]}`
                    : sn.mergedCount
                        ? `merged ${sn.mergedCount} from L${sn.fromLayer}`
                        : '';
                html += `<div class="sc-snippet" data-layer="${i}" data-idx="${j}">
                    <span class="sc-snippet-text">${escapeHtml(sn.text)}</span>
                    <span class="sc-snippet-meta">${rangeStr}</span>
                    <button class="sc-snippet-delete menu_button fa-solid fa-xmark" title="Delete this snippet"></button>
                </div>`;
            }
            html += '</div>';
        }
    }

    $('#sc_snippet_browser').html(html);

    $('.sc-snippet-delete').off('click').on('click', async function () {
        const layerIdx = parseInt($(this).closest('.sc-snippet').data('layer'));
        const snippetIdx = parseInt($(this).closest('.sc-snippet').data('idx'));
        const layer = store.layers[layerIdx];
        if (layer) {
            layer.splice(snippetIdx, 1);
            await saveChatStore();
            updateInjection();
            updateUI();
            toastr.info(`Snippet removed from Layer ${layerIdx}`, 'Summaryception');
        }
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function bindUIEvents() {
    $('#sc_enabled').on('change', function () {
        getSettings().enabled = $(this).prop('checked');
        saveSettings();
        updateInjection();
    });

    const sliders = [
        { id: '#sc_verbatim_turns', key: 'verbatimTurns', display: '#sc_verbatim_turns_val' },
        { id: '#sc_turns_per_summary', key: 'turnsPerSummary', display: '#sc_turns_per_summary_val' },
        { id: '#sc_snippets_per_layer', key: 'snippetsPerLayer', display: '#sc_snippets_per_layer_val' },
        { id: '#sc_snippets_per_promotion', key: 'snippetsPerPromotion', display: '#sc_snippets_per_promotion_val' },
        { id: '#sc_max_layers', key: 'maxLayers', display: '#sc_max_layers_val' },
    ];

    for (const sl of sliders) {
        $(sl.id).on('input', function () {
            const val = parseInt($(this).val(), 10);
            getSettings()[sl.key] = val;
            $(sl.display).text(val);
            saveSettings();
            updateInjection(); // Re-inject at new depth if verbatimTurns changed
        });
    }

    const textareas = [
        { id: '#sc_injection_template', key: 'injectionTemplate' },
        { id: '#sc_summarizer_system_prompt', key: 'summarizerSystemPrompt' },
        { id: '#sc_summarizer_user_prompt', key: 'summarizerUserPrompt' },
    ];

    for (const ta of textareas) {
        $(ta.id).on('change', function () {
            getSettings()[ta.key] = $(this).val();
            saveSettings();
        });
    }

    $('#sc_debug_mode').on('change', function () {
        getSettings().debugMode = $(this).prop('checked');
        saveSettings();
    });

    $('#sc_clear_memory').on('click', async function () {
        if (!confirm('Clear ALL Summaryception memory for this chat and unghost all messages?')) return;
        const store = getChatStore();
        // Unghost everything
        const { chat } = SillyTavern.getContext();
        for (let i = 0; i < chat.length; i++) {
            if (chat[i]._sc_ghosted) {
                unhideMessage(i);
                delete chat[i]._sc_ghosted;
            }
        }
        store.layers = [];
        store.summarizedUpTo = -1;
        await saveChatStore();
        updateInjection();
        updateUI();
        toastr.success('Memory cleared & messages unghosted', 'Summaryception');
    });

    $('#sc_force_summarize').on('click', async function () {
        const s = getSettings();
        if (!s.enabled) {
            toastr.warning('Enable Summaryception first.');
            return;
        }
        $(this).prop('disabled', true).text(' Working…');
        try {
            await maybeSummarizeTurns();
            updateInjection();
        } finally {
            $(this).prop('disabled', false).html('<i class="fa-solid fa-bolt"></i> Force Summarize Now');
            updateUI();
        }
    });

    $('#sc_refresh_preview').on('click', () => updateUI());

    // Export / Import
    $('#sc_export').on('click', function () {
        const store = getChatStore();
        const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `summaryception_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toastr.success('Memory exported', 'Summaryception');
    });

    $('#sc_import').on('click', function () {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                if (!data.layers || !Array.isArray(data.layers)) {
                    toastr.error('Invalid file format.');
                    return;
                }
                const store = getChatStore();
                store.layers = data.layers;
                store.summarizedUpTo = data.summarizedUpTo ?? -1;
                await saveChatStore();
                updateInjection();
                updateUI();
                toastr.success('Memory imported', 'Summaryception');
            } catch (err) {
                console.error(LOG_PREFIX, err);
                toastr.error('Import failed — check console.');
            }
        };
        input.click();
    });
}

// ─── Initialization ──────────────────────────────────────────────────

(async function init() {
    const {
        eventSource,
        event_types,
        renderExtensionTemplateAsync,
    } = SillyTavern.getContext();

    getSettings();

    const html = await renderExtensionTemplateAsync(
        'third-party/Extension-Summaryception',
        'settings',
        {}
    );
    $('#extensions_settings2').append(html);

    bindUIEvents();

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);

    registerSlashCommands();

    eventSource.on(event_types.APP_READY, () => {
        updateInjection();
        updateUI();
        console.log(LOG_PREFIX, 'v3 loaded. Ghost mode — non-destructive layered summarization.');
    });
})();