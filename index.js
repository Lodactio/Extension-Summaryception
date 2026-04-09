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

// ─── Retry Configuration ─────────────────────────────────────────────

const RETRY_CONFIG = {
    maxRetries: 5,
    baseDelay: 2000,
    maxDelay: 60000,
    backoffMultiplier: 2,
    retryableStatuses: [429, 500, 502, 503, 504],
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfter(error) {
    try {
        const retryAfter = error?.response?.headers?.['retry-after']
        || error?.retryAfter
        || error?.data?.retry_after;
        if (!retryAfter) return null;
        const seconds = Number(retryAfter);
        if (!isNaN(seconds)) return seconds * 1000;
        const date = new Date(retryAfter);
        if (!isNaN(date.getTime())) {
            return Math.max(0, date.getTime() - Date.now());
        }
    } catch (e) { /* ignore */ }
    return null;
}

function isRetryableError(error) {
    if (error?.name === 'AbortError') return false;
    if (error?.name === 'TypeError' && error?.message?.includes('fetch')) return true;
    const status = error?.status || error?.response?.status || error?.statusCode;
    if (status && RETRY_CONFIG.retryableStatuses.includes(status)) return true;
    const msg = (error?.message || error?.toString() || '').toLowerCase();
    if (msg.includes('rate limit')) return true;
    if (msg.includes('too many requests')) return true;
    if (msg.includes('server error')) return true;
    if (msg.includes('timeout')) return true;
    if (msg.includes('econnreset')) return true;
    if (msg.includes('econnrefused')) return true;
    if (msg.includes('network')) return true;
    if (msg.includes('overloaded')) return true;
    if (msg.includes('capacity')) return true;
    return false;
}

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
            summarizedUpTo: -1,
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
 * Get the IGNORE symbol from SillyTavern core.
 * This is the official way to exclude messages from the LLM context
 * without removing them from the chat. Uses Symbol.for() so it won't
 * serialize to JSON (ephemeral per session).
 *
 * From PR #3763: generation interceptors set this flag on structuredClone'd
 * messages to exclude them from formatMessageHistoryItem() and
 * setOpenAIMessages().
 *
 * HOWEVER — we need persistent ghosting (survives reload), so we use a
 * two-pronged approach:
 *   1. Set a persistent flag (msg.extra.sc_ghosted = true) saved to chat
 *   2. At generation time, use a generation interceptor to apply the
 *      Symbol-based ignore flag on cloned messages
 */

/**
 * Mark a message as ghosted in persistent storage.
 * The actual context exclusion happens in the generation interceptor.
 */
function ghostMessage(messageIndex) {
    const { chat } = SillyTavern.getContext();
    const msg = chat[messageIndex];
    if (!msg) return;

    // Initialize extra if needed
    if (!msg.extra) msg.extra = {};

    // Already ghosted
    if (msg.extra.sc_ghosted) return;

    // Set persistent flag
    msg.extra.sc_ghosted = true;

    // Visual indicator in the UI
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageIndex}"]`);
    if (messageElement) {
        messageElement.classList.add('sc-ghosted');
    }

    log(`Ghosted message at index ${messageIndex}`);
}

/**
 * Remove ghost status from a message.
 */
function unghostMessage(messageIndex) {
    const { chat } = SillyTavern.getContext();
    const msg = chat[messageIndex];
    if (!msg || !msg.extra) return;

    delete msg.extra.sc_ghosted;

    const messageElement = document.querySelector(`#chat .mes[mesid="${messageIndex}"]`);
    if (messageElement) {
        messageElement.classList.remove('sc-ghosted');
    }

    log(`Unghosted message at index ${messageIndex}`);
}

/**
 * Ghost all messages from index 1 up to and including endIndex.
 * Skips index 0 (greeting/scenario) and already-ghosted messages.
 */
function ghostMessagesUpTo(endIndex) {
    const { chat } = SillyTavern.getContext();

    for (let i = 0; i <= endIndex; i++) {
        const msg = chat[i];
        if (!msg) continue;

        // Skip the first message (greeting)
        if (i === 0) continue;

        // Skip real system messages that aren't ours
        if (msg.is_system && !msg.extra?.sc_ghosted) continue;

        ghostMessage(i);
    }

    log(`Ghosted messages from index 1 to ${endIndex}`);
}

/**
 * Apply ghost visual indicators to all ghosted messages in the current chat.
 * Called on chat load to restore visual state.
 */
function applyGhostVisuals() {
    const { chat } = SillyTavern.getContext();
    if (!chat) return;

    for (let i = 0; i < chat.length; i++) {
        if (chat[i]?.extra?.sc_ghosted) {
            const messageElement = document.querySelector(`#chat .mes[mesid="${i}"]`);
            if (messageElement) {
                messageElement.classList.add('sc-ghosted');
            }
        }
    }
}

// ─── Generation Interceptor (the actual context exclusion) ───────────

/**
 * This is where ghosted messages are ACTUALLY excluded from context.
 * We hook into the generation pipeline and set the ignore flag on
 * cloned messages so they're skipped during prompt building.
 *
 * This uses the official SillyTavern mechanism from PR #3763.
 */
function setupGenerationInterceptor() {
    const { eventSource, event_types } = SillyTavern.getContext();

    eventSource.on(event_types.GENERATION_STARTED, (type) => {
        if (type === 'quiet') return; // Don't interfere with our own summarizer calls

        const s = getSettings();
        if (!s.enabled) return;

        const { chat } = SillyTavern.getContext();

        // Get the ignore symbol from SillyTavern core
        const ctx = SillyTavern.getContext();
        const IGNORE_SYMBOL = ctx.symbols?.IGNORE
        || Symbol.for('ignore');  // Fallback

        for (let i = 0; i < chat.length; i++) {
            const msg = chat[i];
            if (msg?.extra?.sc_ghosted) {
                // Clone the message to avoid persisting the symbol
                chat[i] = structuredClone(msg);
                if (!chat[i].extra) chat[i].extra = {};
                chat[i].extra[IGNORE_SYMBOL] = true;
            }
        }

        log('Generation interceptor: applied ignore flags to ghosted messages');
    });
}

// ─── Assistant Turn Utilities ────────────────────────────────────────

function getAssistantTurns(chat) {
    const turns = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        const isOurGhost = m.extra?.sc_ghosted === true;
        const isAssistant = !m.is_user && (!m.is_system || isOurGhost);
        if (isAssistant && m.mes && m.mes.trim().length > 0) {
            turns.push({ index: i, mes: m.mes, name: m.name || 'Assistant' });
        }
    }
    return turns;
}

function getVisibleAssistantTurns(chat) {
    const turns = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m.is_user && !m.is_system && !m.extra?.sc_ghosted && m.mes && m.mes.trim().length > 0) {
            turns.push({ index: i, mes: m.mes, name: m.name || 'Assistant' });
        }
    }
    return turns;
}

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

// ─── Core: LLM Summarization with Retry ──────────────────────────────

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

    const snapshot = snapshotPromptToggles();
    disableAllPromptToggles();

    let lastError = null;

    try {
        for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    log(`Retry attempt ${attempt}/${RETRY_CONFIG.maxRetries}`);
                }

                const result = await generateRaw({
                    systemPrompt: s.summarizerSystemPrompt,
                    prompt: prompt,
                });

                const trimmed = (result || '').trim();

                if (!trimmed) {
                    log('Empty response from LLM, treating as retryable');
                    throw new Error('Empty response from summarizer');
                }

                log('Result:', trimmed);
                return trimmed;

            } catch (err) {
                lastError = err;

                if (!isRetryableError(err)) {
                    console.error(LOG_PREFIX, 'Non-retryable error:', err);
                    break;
                }

                if (attempt >= RETRY_CONFIG.maxRetries) {
                    console.error(LOG_PREFIX, `All ${RETRY_CONFIG.maxRetries} retries exhausted.`);
                    break;
                }

                let delay;
                const retryAfterMs = parseRetryAfter(err);
                if (retryAfterMs) {
                    delay = Math.min(retryAfterMs, RETRY_CONFIG.maxDelay);
                    log(`Server requested retry after ${delay}ms`);
                } else {
                    const exponentialDelay = RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt);
                    const jitter = Math.random() * RETRY_CONFIG.baseDelay;
                    delay = Math.min(exponentialDelay + jitter, RETRY_CONFIG.maxDelay);
                }

                const delaySec = (delay / 1000).toFixed(1);
                const status = err?.status || err?.response?.status || '?';

                console.warn(LOG_PREFIX, `Attempt ${attempt + 1} failed (${status}). Retrying in ${delaySec}s...`, err.message || err);

                toastr.warning(
                    `API error (${status}). Retrying in ${delaySec}s... (${attempt + 1}/${RETRY_CONFIG.maxRetries})`,
                               'Summaryception',
                               { timeOut: delay }
                );

                await sleep(delay);
            }
        }

        const status = lastError?.status || lastError?.response?.status || '';
        console.error(LOG_PREFIX, 'Summarization failed after all retries:', lastError);
        toastr.error(
            `Summarization failed after ${RETRY_CONFIG.maxRetries} retries${status ? ` (${status})` : ''}. Batch skipped — will retry on next trigger.`,
                     'Summaryception',
                     { timeOut: 8000 }
        );
        return '';

    } finally {
        restorePromptToggles(snapshot);
    }
}

// ─── Core: Summarization State ───────────────────────────────────────

let isSummarizing = false;
let catchupDismissed = false;

// ─── Core: Summarize Oldest Verbatim Turns ──────────────────────────

async function maybeSummarizeTurns() {
    const s = getSettings();
    if (!s.enabled) return;
    if (isSummarizing) return;

    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    const allAssistantTurns = getAssistantTurns(chat);
    const visibleTurns = allAssistantTurns.filter(t => t.index > 0 && !chat[t.index].extra?.sc_ghosted);

    log(`Visible assistant turns (excluding turn 0): ${visibleTurns.length}, limit: ${s.verbatimTurns}`);

    if (visibleTurns.length <= s.verbatimTurns) return;

    const overflow = visibleTurns.length - s.verbatimTurns;

    // ─── Backlog detection ───────────────────────────────────────
    const backlogThreshold = s.turnsPerSummary * 2;

    if (overflow > backlogThreshold && !catchupDismissed) {
        log(`Large backlog detected: ${overflow} turns over limit`);

        const batchesNeeded = Math.ceil(overflow / s.turnsPerSummary);

        const choice = await showCatchupDialog(overflow, batchesNeeded);

        if (choice === 'skip') {
            const cutoff = visibleTurns[visibleTurns.length - s.verbatimTurns - 1];
            if (cutoff) {
                store.summarizedUpTo = cutoff.index;
                log(`Skipped backlog. summarizedUpTo set to ${store.summarizedUpTo}`);
            }
            catchupDismissed = true;
            await saveChatStore();
            return;

        } else if (choice === 'catchup') {
            await runCatchup(visibleTurns, overflow);
            return;

        } else if (choice === 'partial') {
            await summarizeOneBatch(visibleTurns);
            return;
        }

        return;
    }

    // ─── Normal operation: single batch ──────────────────────────
    await summarizeOneBatch(visibleTurns);

    // Check if there's still a small overflow (not a backlog)
    const remaining = getAssistantTurns(chat).filter(t => t.index > 0 && !chat[t.index].extra?.sc_ghosted);
    if (remaining.length > s.verbatimTurns && remaining.length - s.verbatimTurns <= backlogThreshold) {
        await maybeSummarizeTurns();
    }
}

// ─── Core: Single Batch Summarization ────────────────────────────────

async function summarizeOneBatch(visibleTurns) {
    const s = getSettings();
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    const batchSize = Math.min(s.turnsPerSummary, visibleTurns.length);
    const batch = visibleTurns.slice(0, batchSize);

    if (batch.length === 0) return false;

    isSummarizing = true;

    try {
        const startIdx = batch[0].index;
        const endIdx = batch[batch.length - 1].index;

        log(`Summarizing ${batch.length} assistant turns (indices ${startIdx}–${endIdx})`);

        const storyTxt = buildPassageFromRange(chat, startIdx, endIdx);
        if (!storyTxt.trim()) return false;

        if (!store.layers[0]) store.layers[0] = [];
        const contextStr = store.layers[0].map(sn => sn.text).join(' | ');

        toastr.info(`Summarizing ${batch.length} turn${batch.length > 1 ? 's' : ''}…`, 'Summaryception', {
            timeOut: 3000,
            progressBar: true,
        });

        const summary = await callSummarizer(storyTxt, contextStr);

        if (!summary) {
            log('Summarization failed for batch, leaving turns intact for next attempt.');
            return false;
        }

        store.layers[0].push({
            text: summary,
            turnRange: [startIdx, endIdx],
            timestamp: Date.now(),
        });

        store.summarizedUpTo = Math.max(store.summarizedUpTo, endIdx);
        ghostMessagesUpTo(endIdx);

        log(`Layer 0 now has ${store.layers[0].length} snippets`);

        await maybePromoteLayer(0);
        await saveChatStore();

        try {
            const ctx = SillyTavern.getContext();
            if (ctx.saveChat) await ctx.saveChat();
        } catch (e) {
            log('Could not save chat:', e);
        }

        toastr.success(`Summary saved (Layer 0: ${store.layers[0].length} snippets)`, 'Summaryception', { timeOut: 2000 });
        return true;

    } finally {
        isSummarizing = false;
    }
}

// ─── Core: Inner Batch for Catchup (no isSummarizing toggle) ─────────

async function summarizeOneBatchFromTurns(visibleTurns) {
    const s = getSettings();
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    const batchSize = Math.min(s.turnsPerSummary, visibleTurns.length);
    const batch = visibleTurns.slice(0, batchSize);

    if (batch.length === 0) return false;

    const startIdx = batch[0].index;
    const endIdx = batch[batch.length - 1].index;

    const storyTxt = buildPassageFromRange(chat, startIdx, endIdx);
    if (!storyTxt.trim()) return false;

    if (!store.layers[0]) store.layers[0] = [];
    const contextStr = store.layers[0].map(sn => sn.text).join(' | ');

    const summary = await callSummarizer(storyTxt, contextStr);

    if (!summary) {
        log('Summarization failed for batch, leaving turns intact for next attempt.');
        return false;
    }

    store.layers[0].push({
        text: summary,
        turnRange: [startIdx, endIdx],
        timestamp: Date.now(),
    });

    store.summarizedUpTo = Math.max(store.summarizedUpTo, endIdx);
    ghostMessagesUpTo(endIdx);

    await maybePromoteLayer(0);
    await saveChatStore();

    try {
        const ctx = SillyTavern.getContext();
        if (ctx.saveChat) await ctx.saveChat();
    } catch (e) {
        log('Could not save chat:', e);
    }

    return true;
}

// ─── Core: Catchup Processing ────────────────────────────────────────

async function runCatchup(visibleTurns, overflow) {
    const s = getSettings();
    const totalBatches = Math.ceil(overflow / s.turnsPerSummary);
    let completed = 0;
    let failed = 0;
    let cancelled = false;

    const progressToast = toastr.info(
        `Processing backlog: 0 / ${totalBatches} batches (0%)`,
                                      'Summaryception Catch-Up',
                                      {
                                          timeOut: 0,
                                          extendedTimeOut: 0,
                                          tapToDismiss: false,
                                          closeButton: true,
                                          onCloseClick: () => { cancelled = true; },
                                      }
    );

    isSummarizing = true;

    try {
        let consecutiveFailures = 0;

        while (!cancelled) {
            const { chat } = SillyTavern.getContext();
            const allAssistantTurns = getAssistantTurns(chat);
            const currentVisible = allAssistantTurns.filter(t => t.index > 0 && !chat[t.index]._sc_ghosted);

            if (currentVisible.length <= s.verbatimTurns) break;

            const success = await summarizeOneBatchFromTurns(currentVisible);

            if (success) {
                completed++;
                consecutiveFailures = 0;
            } else {
                failed++;
                consecutiveFailures++;

                if (consecutiveFailures >= 3) {
                    toastr.error(
                        `3 consecutive failures — API may be down. Pausing catch-up. Progress saved; will resume on next message.`,
                        'Summaryception',
                        { timeOut: 8000 }
                    );
                    break;
                }
            }

            const pct = Math.round((completed / totalBatches) * 100);
            const failStr = failed > 0 ? ` | ${failed} failed` : '';
            $(progressToast).find('.toast-message').text(
                `Processing: ${completed} / ${totalBatches} batches (${pct}%)${failStr}\nClick ✕ to pause`
            );

            await new Promise(r => setTimeout(r, 200));
        }

        toastr.clear(progressToast);

        if (cancelled) {
            toastr.warning(
                `Catch-up paused at ${completed}/${totalBatches}. Progress saved — will continue on next message.`,
                'Summaryception',
                { timeOut: 5000 }
            );
        } else if (failed === 0) {
            toastr.success(
                `Catch-up complete! ${completed} batches processed.`,
                'Summaryception',
                { timeOut: 4000 }
            );
        } else {
            toastr.warning(
                `Catch-up finished. ${completed} succeeded, ${failed} failed (will retry on next trigger).`,
                           'Summaryception',
                           { timeOut: 6000 }
            );
        }

        updateUI();

    } finally {
        isSummarizing = false;
    }
}

// ─── Catch-Up Dialog ─────────────────────────────────────────────────

async function showCatchupDialog(overflowCount, estimatedCalls) {
    return new Promise((resolve) => {
        const s = getSettings();

        const overlay = document.createElement('div');
        overlay.className = 'sc-catchup-overlay';
        overlay.innerHTML = `
        <div class="sc-catchup-modal">
        <h3>🧠 Summaryception — Backlog Detected</h3>
        <div class="sc-catchup-dialog">
        <p>Summaryception detected <strong>${overflowCount} unsummarized turns</strong>
        in this chat (beyond your ${s.verbatimTurns} verbatim limit).</p>
        <p>This will require approximately <strong>${estimatedCalls} summarizer calls</strong> to process.</p>
        <hr>
        <div class="sc-catchup-options">
        <button id="sc_catchup_full" class="menu_button">
        <i class="fa-solid fa-forward-fast"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Process Entire Backlog</span>
        <span class="sc-btn-desc">Summarize all ${overflowCount} turns — cancelable at any time</span>
        </div>
        </button>
        <button id="sc_catchup_skip" class="menu_button">
        <i class="fa-solid fa-forward-step"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Skip Backlog</span>
        <span class="sc-btn-desc">Ignore old turns, only summarize new ones going forward</span>
        </div>
        </button>
        <button id="sc_catchup_partial" class="menu_button">
        <i class="fa-solid fa-play"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Just One Batch</span>
        <span class="sc-btn-desc">Summarize ${s.turnsPerSummary} turns now, deal with the rest later</span>
        </div>
        </button>
        </div>
        </div>
        </div>
        `;
        document.body.appendChild(overlay);

        overlay.querySelector('#sc_catchup_full').addEventListener('click', () => {
            overlay.remove();
            resolve('catchup');
        });
        overlay.querySelector('#sc_catchup_skip').addEventListener('click', () => {
            overlay.remove();
            resolve('skip');
        });
        overlay.querySelector('#sc_catchup_partial').addEventListener('click', () => {
            overlay.remove();
            resolve('partial');
        });
    });
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

    // Ensure destination layer exists
    if (!store.layers[layerIndex + 1]) store.layers[layerIndex + 1] = [];
    const destLayer = store.layers[layerIndex + 1];

    // ─── Seed promotion ──────────────────────────────────────────
    // If the destination layer is EMPTY, the oldest snippet from the
    // source layer is promoted directly as a seed — no LLM call.
    // This preserves maximum information as the foundational context
    // for all future summaries in that layer.
    if (destLayer.length === 0) {
        const seed = layer.shift();

        seed.promoted = true;
        seed.seedFromLayer = layerIndex;

        destLayer.push(seed);

        log(`Seeded Layer ${layerIndex + 1} with oldest snippet from Layer ${layerIndex} (no LLM call)`);

        toastr.info(
            `Seeded Layer ${layerIndex + 1} from Layer ${layerIndex} (free promotion)`,
                    'Summaryception',
                    { timeOut: 2000 }
        );

        // Check if source layer STILL exceeds the limit after removing the seed
        // (e.g. if multiple messages came in at once)
        if (layer.length > s.snippetsPerLayer) {
            await maybePromoteLayer(layerIndex);
        }

        // Check if destination layer now needs promotion too
        if (destLayer.length > s.snippetsPerLayer) {
            await maybePromoteLayer(layerIndex + 1);
        }

        return;
    }

    // ─── Normal promotion: summarize oldest N snippets ───────────
    const toMerge = layer.splice(0, s.snippetsPerPromotion);
    const storyTxt = toMerge.map(sn => sn.text).join(' | ');

    // Prior context = destination layer's existing snippets (includes the seed)
    const contextStr = destLayer.map(sn => sn.text).join(' | ');

    toastr.info(
        `Promoting ${toMerge.length} snippets: Layer ${layerIndex} → Layer ${layerIndex + 1}`,
        'Summaryception',
        { timeOut: 3000, progressBar: true }
    );

    const metaSummary = await callSummarizer(storyTxt, contextStr);
    if (!metaSummary) {
        // Restore on failure
        layer.unshift(...toMerge);
        return;
    }

    destLayer.push({
        text: metaSummary,
        fromLayer: layerIndex,
        mergedCount: toMerge.length,
        timestamp: Date.now(),
    });

    log(`Layer ${layerIndex + 1} now has ${destLayer.length} snippets`);

    // Cascade: check both layers
    if (layer.length > s.snippetsPerLayer) {
        await maybePromoteLayer(layerIndex);
    }
    if (destLayer.length > s.snippetsPerLayer) {
        await maybePromoteLayer(layerIndex + 1);
    }
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

    const depth = s.verbatimTurns;
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
    catchupDismissed = false;
    setTimeout(() => {
        applyGhostVisuals();
        updateInjection();
        updateUI();
    }, 100);
}

function onGenerationStarted() {
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
                const { chat } = SillyTavern.getContext();
                for (let i = 0; i < chat.length; i++) {
                    if (chat[i]?.extra?.sc_ghosted) {
                        unghostMessage(i);
                    }
                }
                store.layers = [];
                store.summarizedUpTo = -1;
                await saveChatStore();
                try {
                    const ctx = SillyTavern.getContext();
                    if (ctx.saveChat) await ctx.saveChat();
                } catch (e) {
                    log('Could not save chat:', e);
                }
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

    let ghostedCount = 0;
    try {
        const { chat } = SillyTavern.getContext();
        ghostedCount = chat.filter(m => m.extra?.sc_ghosted).length;
    } catch (e) { /* no chat loaded */ }

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

    const preview = assembleSummaryBlock();
    $('#sc_preview').val(preview || '(empty — no summaries yet)');

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

/**
 * Apply ghost visual indicators to all ghosted messages.
 * Uses a short delay loop to catch dynamically rendered messages.
 */
function applyGhostVisuals() {
    const { chat } = SillyTavern.getContext();
    if (!chat) return;

    for (let i = 0; i < chat.length; i++) {
        const isGhosted = chat[i]?.extra?.sc_ghosted === true;
        const messageElement = document.querySelector(`#chat .mes[mesid="${i}"]`);
        if (!messageElement) continue;

        if (isGhosted) {
            messageElement.classList.add('sc-ghosted');
        } else {
            messageElement.classList.remove('sc-ghosted');
        }
    }
}

/**
 * Set up a MutationObserver on the chat container to catch
 * newly rendered messages and apply ghost visuals.
 */
function setupGhostObserver() {
    const chatContainer = document.querySelector('#chat');
    if (!chatContainer) {
        // Chat container not ready yet, retry
        setTimeout(setupGhostObserver, 500);
        return;
    }

    const observer = new MutationObserver((mutations) => {
        // Only react to added nodes (new messages rendered)
        let hasNewMessages = false;
        for (const mutation of mutations) {
            if (mutation.addedNodes.length > 0) {
                hasNewMessages = true;
                break;
            }
        }
        if (hasNewMessages) {
            applyGhostVisuals();
        }
    });

    observer.observe(chatContainer, {
        childList: true,
        subtree: false,
    });

    log('Ghost visual observer attached to #chat');
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
            updateInjection();
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
        const { chat } = SillyTavern.getContext();
        for (let i = 0; i < chat.length; i++) {
            if (chat[i]?.extra?.sc_ghosted) {
                unghostMessage(i);
            }
        }
        store.layers = [];
        store.summarizedUpTo = -1;
        await saveChatStore();
        // Save the chat to persist the unghosted state
        try {
            const ctx = SillyTavern.getContext();
            if (ctx.saveChat) await ctx.saveChat();
        } catch (e) {
            log('Could not save chat:', e);
        }
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

                const { chat } = SillyTavern.getContext();
                const store = getChatStore();

                // First, unghost everything from the current state
                for (let i = 0; i < chat.length; i++) {
                    if (chat[i]?.extra?.sc_ghosted) {
                        unghostMessage(i);
                    }
                }

                // Load the imported data
                store.layers = data.layers;
                store.summarizedUpTo = data.summarizedUpTo ?? -1;

                // Now ghost messages up to the imported summarizedUpTo
                if (store.summarizedUpTo >= 0) {
                    ghostMessagesUpTo(store.summarizedUpTo);
                }

                await saveChatStore();

                try {
                    const ctx = SillyTavern.getContext();
                    if (ctx.saveChat) await ctx.saveChat();
                } catch (e) {
                    log('Could not save chat:', e);
                }

                updateInjection();
                updateUI();
                toastr.success(
                    `Memory imported. ${store.layers.reduce((sum, l) => sum + (l?.length || 0), 0)} snippets loaded, messages ghosted up to index ${store.summarizedUpTo}.`,
                               'Summaryception',
                               { timeOut: 4000 }
                );
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

    setupGenerationInterceptor();
    registerSlashCommands();

    eventSource.on(event_types.APP_READY, () => {
        setupGhostObserver();
        applyGhostVisuals();
        updateInjection();
        updateUI();
        console.log(LOG_PREFIX, 'v3 loaded. Ghost mode — non-destructive layered summarization.');
    });
})();