// clim.mjs — argument parsing, `last`, first-prompt handling, send checks, agent commands, folders, checklists, watch.
// No app needed: clim.mjs is run for real against a fake Control API on 127.0.0.1 (it is a script that executes on import,
// so its functions are not imported — the process is spawned).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIM = join(dirname(fileURLToPath(import.meta.url)), 'clim.mjs');

const FAKE_TEMPLATES = [
    { name: 'claude-code', command: 'claude' },
    { name: 'codex', command: 'codex --dangerously-bypass-approvals-and-sandbox' },
    { name: 'custom-tool', command: 'custom-tool' },
];

function listen(server) {
    return new Promise((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }))
    );
}

function startFakeApi(sessions) {
    const requests = [];
    const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
            const url = new URL(req.url, 'http://127.0.0.1');
            requests.push({ method: req.method, path: url.pathname, body: raw ? JSON.parse(raw) : null });
            res.setHeader('content-type', 'application/json');
            const output = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/output$/);
            if (req.method === 'GET' && url.pathname === '/v1/sessions') return res.end(JSON.stringify(sessions));
            if (req.method === 'GET' && url.pathname === '/v1/templates') return res.end(JSON.stringify(FAKE_TEMPLATES));
            if (req.method === 'GET' && output) {
                return res.end(JSON.stringify({ session: { id: output[1], name: 'n', state: 'idle', awaitingInput: false }, mode: 'screen', lines: [] }));
            }
            if (req.method === 'POST' && url.pathname === '/v1/sessions') {
                return res.end(JSON.stringify({
                    session: { id: 'new-session', name: 'n', workspaceName: 'w', cwd: '/x', command: 'claude', state: 'idle', awaitingInput: false },
                    promptSent: false
                }));
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ error: { code: 'not_found', message: url.pathname } }));
        });
    });
    return listen(server).then((api) => ({ ...api, requests }));
}

// The server runs in this process, so a synchronous spawn would block its replies — spawn asynchronously.
function runClim(args, apiUrl, overrides = {}) {
    const env = { ...process.env, CLIM_URL: apiUrl, CLIM_TOKEN: 'test-token', CLIM_POLICY_FILE: '/nonexistent/policy.md', ...overrides };
    delete env.CLIMANAGER_SESSION_ID;
    delete env.CLIM_AUTO_GROUP;
    return new Promise((resolve) => {
        execFile(process.execPath, [CLIM, ...args], { env, encoding: 'utf8' }, (error, stdout, stderr) => {
            resolve({ status: error ? error.code : 0, stdout, stderr });
        });
    });
}
const runClimFast = (args, apiUrl, overrides = {}) => runClim(args, apiUrl, { CLIM_PROMPT_SETTLE_MS: '20', ...overrides });

const session = (id, connectedAt) => ({ id, name: id, state: 'idle', awaitingInput: false, ...(connectedAt ? { connectedAt } : {}) });

// ---------------------------------------------------------------- argument parsing

test('open --folder <name> reaches the request body as folder', async (t) => {
    const api = await startFakeApi([]);
    t.after(api.close);
    const r = await runClim(['open', '/work/proj', '--folder', 'AI Work', '--json'], api.url);
    assert.equal(r.status, 0, r.stderr);
    const post = api.requests.find((q) => q.method === 'POST' && q.path === '/v1/sessions');
    assert.equal(post.body.folder, 'AI Work');
    assert.equal(post.body.path, '/work/proj'); // when the value leaked into positionals the path survived and only the folder went empty
});

test('open --folder=<name> works too', async (t) => {
    const api = await startFakeApi([]);
    t.after(api.close);
    const r = await runClim(['open', '/work/proj', '--folder=Q queue', '--json'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(api.requests.find((q) => q.method === 'POST' && q.path === '/v1/sessions').body.folder, 'Q queue');
});

test('without --folder the body has no folder (the app setting applies)', async (t) => {
    const api = await startFakeApi([]);
    t.after(api.close);
    const r = await runClim(['open', '/work/proj', '--json'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal('folder' in api.requests.find((q) => q.method === 'POST' && q.path === '/v1/sessions').body, false);
});

test('--folder without a value is a usage error (2), not silently ignored', async (t) => {
    const api = await startFakeApi([]);
    t.after(api.close);
    const r = await runClim(['open', '/work/proj', '--folder'], api.url);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--folder needs a value/);
});

test("'last' is the session with the newest connection time, not the end of the list", async (t) => {
    const api = await startFakeApi([
        session('newest-0001', '2026-10-09T14:48:00.000Z'),
        session('middle-0002', '2026-10-08T09:10:00.000Z'),
        session('old-last-03', '2026-10-07T01:00:00.000Z'),
    ]);
    t.after(api.close);
    const r = await runClim(['read', 'last', '--json'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).session.id, 'newest-0001');
    assert.ok(api.requests.some((q) => q.path === '/v1/sessions/newest-0001/output'));
});

test("'last' falls back to the end of the list when connectedAt is missing or unreadable", async (t) => {
    const api = await startFakeApi([session('first-0001'), session('second-0002', 'not-a-date'), session('third-0003')]);
    t.after(api.close);
    const r = await runClim(['read', 'last', '--json'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).session.id, 'third-0003');
});

test("'last' only compares sessions with a readable connection time", async (t) => {
    const api = await startFakeApi([session('dated-0001', '2026-10-09T00:00:00.000Z'), session('undated-002')]);
    t.after(api.close);
    const r = await runClim(['read', 'last', '--json'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).session.id, 'dated-0001');
});

test("'last' with no open AI session is 'no such session' (4)", async (t) => {
    const api = await startFakeApi([]);
    t.after(api.close);
    assert.equal((await runClim(['read', 'last', '--json'], api.url)).status, 4);
});

// ---------------------------------------------------------------- first prompt stuck in the input box

const RULE = '─'.repeat(40);
const PROMPT = 'Full instructions are in /tmp/brief.md — read it to the end';
const STUCK_SCREEN = ['claude --session-id x', ' ▐▛███▛█   Claude Code', RULE, '❯ Full instructions are in', '  /tmp/brief.md — read it to the end', RULE, '  ~/x | Sonnet'];
// send also checks that the start of the text is visible (exit 6), so the submitted screen holds the whole text.
const SUBMITTED_SCREEN = [`❯ ${PROMPT}`, '⏺ Read 1 file', RULE, '❯ ', RULE, '  ~/x | Sonnet'];

function startPromptApi({ startBusy, stuckLines, flicker = false, submittedLines = SUBMITTED_SCREEN }) {
    const requests = [];
    let state = startBusy || flicker ? 'busy' : 'idle'; // flicker: the text is still in the box but the state only blinks busy
    let lines = startBusy ? submittedLines : (stuckLines ?? STUCK_SCREEN);
    const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
            const url = new URL(req.url, 'http://127.0.0.1');
            const body = raw ? JSON.parse(raw) : null;
            requests.push({ method: req.method, path: url.pathname, body });
            res.setHeader('content-type', 'application/json');
            const s = { id: 'p1', name: 'n', workspaceName: 'w', cwd: '/x', command: 'claude', awaitingInput: false };
            if (req.method === 'POST' && url.pathname === '/v1/sessions') return res.end(JSON.stringify({ session: { ...s, state: 'idle' }, promptSent: true }));
            if (req.method === 'GET' && url.pathname === '/v1/sessions') return res.end(JSON.stringify([{ ...s, state }]));
            if (req.method === 'GET' && url.pathname === '/v1/sessions/p1') return res.end(JSON.stringify({ ...s, state }));
            if (req.method === 'GET' && url.pathname === '/v1/sessions/p1/output') {
                const n = Number(url.searchParams.get('lines') ?? lines.length); // like the real API: only the last n lines
                return res.end(JSON.stringify({ session: { ...s, state }, mode: 'screen', lines: lines.slice(-n) }));
            }
            if (req.method === 'POST' && url.pathname === '/v1/sessions/p1/input') {
                if (body?.keys?.join() === 'enter') { state = 'busy'; lines = submittedLines; }
                return res.end(JSON.stringify({ ok: true }));
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ error: { code: 'not_found', message: url.pathname } }));
        });
    });
    return listen(server).then((api) => ({ ...api, requests }));
}

const enterCount = (api, id = 'p1') => api.requests.filter((q) => q.path === `/v1/sessions/${id}/input` && q.body?.keys?.join() === 'enter').length;
const OPEN_WITH_PROMPT = ['open', '/work/proj', '--prompt', PROMPT, '--no-policy', '--json'];

test('open re-sends Enter once when the first prompt is stuck in the input box', async (t) => {
    const api = await startPromptApi({ startBusy: false });
    t.after(api.close);
    const r = await runClimFast(OPEN_WITH_PROMPT, api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(enterCount(api), 1);
    assert.equal(JSON.parse(r.stdout).promptCheck, 'retried');
});

test('open sends no key when the prompt was already submitted and the session is working', async (t) => {
    const api = await startPromptApi({ startBusy: true });
    t.after(api.close);
    const r = await runClimFast(OPEN_WITH_PROMPT, api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(api.requests.some((q) => q.path === '/v1/sessions/p1/input'), false);
    assert.equal(JSON.parse(r.stdout).promptCheck, 'started');
});

// A long first prompt: the input box is taller than the screen read, so its top rule is pushed out of view.
const LONG_STUCK_SCREEN = [' ▐▛███▛█   Claude Code', RULE, `❯ ${PROMPT}`, ...Array.from({ length: 150 }, (_, i) => `  policy line ${i}`), RULE, '  ~/x | Sonnet'];

test('a long first prompt (input box over 60 lines) is still noticed in the input box', async (t) => {
    const api = await startPromptApi({ startBusy: false, stuckLines: LONG_STUCK_SCREEN });
    t.after(api.close);
    const r = await runClimFast(OPEN_WITH_PROMPT, api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(enterCount(api), 1);
    const firstInput = api.requests.findIndex((q) => q.path.endsWith('/input'));
    // the bottom border tells it is ready even when the top cursor is off screen, so no polling
    assert.equal(api.requests.slice(0, firstInput).filter((q) => q.path.endsWith('/output')).length, 2);
    assert.equal(JSON.parse(r.stdout).promptCheck, 'retried');
});

test('a busy state flicker with the text still in the box is not "started" — Enter is sent', async (t) => {
    const api = await startPromptApi({ startBusy: false, flicker: true });
    t.after(api.close);
    const r = await runClimFast(OPEN_WITH_PROMPT, api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(enterCount(api), 1);
    assert.equal(JSON.parse(r.stdout).promptCheck, 'retried');
});

test('if the text is still in the box after the re-send, busy does not count as started', async (t) => {
    const api = await startPromptApi({ startBusy: false, submittedLines: STUCK_SCREEN });
    t.after(api.close);
    const r = await runClimFast(OPEN_WITH_PROMPT, api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).promptCheck, 'unconfirmed');
    assert.equal(api.requests.filter((q) => q.path.endsWith('/input')).length, 1);
});

// ---------------------------------------------------------------- close

function startCloseApi(state) {
    const requests = [];
    const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        requests.push({ method: req.method, path: url.pathname });
        res.setHeader('content-type', 'application/json');
        const s = { id: 'c1', name: 'n', state, awaitingInput: false };
        if (req.method === 'GET' && url.pathname === '/v1/sessions') return res.end(JSON.stringify([s]));
        if (req.method === 'GET' && url.pathname === '/v1/sessions/c1') return res.end(JSON.stringify(s));
        if (req.method === 'DELETE' && url.pathname === '/v1/sessions/c1') return res.end(JSON.stringify({ ok: true }));
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: 'not_found', message: url.pathname } }));
    });
    return listen(server).then((api) => ({ ...api, requests }));
}
const deletes = (api) => api.requests.filter((q) => q.method === 'DELETE');

test('close: a busy session is refused with exit code 7 and not closed', async (t) => {
    const api = await startCloseApi('busy');
    t.after(api.close);
    const r = await runClim(['close', 'c1'], api.url);
    assert.equal(r.status, 7);
    assert.equal(deletes(api).length, 0);
});

test('close --force closes a busy session', async (t) => {
    const api = await startCloseApi('busy');
    t.after(api.close);
    const r = await runClim(['close', 'c1', '--force'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(deletes(api).length, 1);
});

test('close: an idle session is simply closed', async (t) => {
    const api = await startCloseApi('idle');
    t.after(api.close);
    const r = await runClim(['close', 'c1'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(deletes(api).length, 1);
});

// ---------------------------------------------------------------- send

test('send: text left in the input box of an idle session gets one more Enter', async (t) => {
    const api = await startPromptApi({ startBusy: false });
    t.after(api.close);
    const r = await runClimFast(['send', 'p1', PROMPT, '--json'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(enterCount(api), 1);
    assert.equal(JSON.parse(r.stdout).submitCheck, 'retried');
});

test('send: a working session may be queueing, so no extra Enter is sent', async (t) => {
    const api = await startPromptApi({ startBusy: true });
    t.after(api.close);
    const r = await runClimFast(['send', 'p1', PROMPT, '--json'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(api.requests.some((q) => q.body?.keys), false);
    assert.equal(JSON.parse(r.stdout).submitCheck, 'busy');
});

test('send --keys does no submit check and reads no screen', async (t) => {
    const api = await startPromptApi({ startBusy: false });
    t.after(api.close);
    const r = await runClimFast(['send', 'p1', '--keys', 'down,enter', '--json'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).submitCheck, undefined);
    assert.equal(api.requests.filter((q) => q.method === 'GET' && q.path.endsWith('/output')).length, 0);
});

const sendJson = (api, extra = []) => runClimFast(['send', 'p1', PROMPT, '--json', ...extra], api.url);

test('send: exit 0 and visible=true when the start of the text is on screen (read with tail, scrollback included)', async (t) => {
    const api = await startPromptApi({ startBusy: true });
    t.after(api.close);
    const r = await sendJson(api);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).visible, true);
    assert.equal(api.requests.some((q) => q.method === 'GET' && q.path === '/v1/sessions/p1/output'), true);
});

test('send: the start missing from the screen (typed from the middle) warns and exits 6', async (t) => {
    const truncated = ['❯ read it to the end', '⏺ Read 1 file', RULE, '❯ ', RULE, '  ~/x | Sonnet'];
    const api = await startPromptApi({ startBusy: true, submittedLines: truncated });
    t.after(api.close);
    const r = await sendJson(api);
    assert.equal(r.status, 6);
    assert.match(r.stderr, /may have been cut off/);
    assert.equal(JSON.parse(r.stdout).visible, false);
    assert.equal(JSON.parse(r.stdout).sent, true); // it was sent — only the exit code tells
});

test('send: the start is found even when the screen wrapped it over lines (whitespace ignored)', async (t) => {
    const wrapped = ['❯ Full instructions are', '  in /tmp/brief.md — read it', '  to the end', '⏺ Read 1 file'];
    const api = await startPromptApi({ startBusy: true, submittedLines: wrapped });
    t.after(api.close);
    assert.equal((await sendJson(api)).status, 0);
});

test('send: a Codex "[Pasted Content N chars]" fold passes when the count matches', async (t) => {
    const long = 'instruction '.repeat(500).trim();
    const ok = await startPromptApi({ startBusy: true, submittedLines: [`› [Pasted Content ${[...long].length} chars]`, '• Working (3s)'] });
    t.after(ok.close);
    const pass = await runClimFast(['send', 'p1', long, '--json'], ok.url);
    assert.equal(pass.status, 0, pass.stderr);
    assert.equal(JSON.parse(pass.stdout).visible, true);

    // a different count means a different text was folded — that does not pass
    const other = await startPromptApi({ startBusy: true, submittedLines: ['› [Pasted Content 12 chars]', '• Working (3s)'] });
    t.after(other.close);
    assert.equal((await runClimFast(['send', 'p1', long, '--json'], other.url)).status, 6);
});

test('send: CRLF text is compared by its LF length', async (t) => {
    const crlf = 'first line\r\nsecond line\r\n'.repeat(100);
    const lfLength = [...crlf.replace(/\r\n/g, '\n')].length;
    const api = await startPromptApi({ startBusy: true, submittedLines: [`› [Pasted Content ${lfLength} chars]`, '• Working (3s)'] });
    t.after(api.close);
    const r = await runClimFast(['send', 'p1', crlf, '--json'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).visible, true);
});

test('send: a fold marker split over several lines on a narrow screen is still recognised', async (t) => {
    const long = 'instruction '.repeat(500).trim();
    const n = [...long].length;
    const ok = await startPromptApi({ startBusy: true, submittedLines: ['› [Pasted', `  Content ${n}`, '  chars]', '• Working (3s)'] });
    t.after(ok.close);
    const pass = await runClimFast(['send', 'p1', long, '--json'], ok.url);
    assert.equal(pass.status, 0, pass.stderr);
    assert.equal(JSON.parse(pass.stdout).visible, true);

    const other = await startPromptApi({ startBusy: true, submittedLines: ['› [Pasted', '  Content 12', '  chars]'] });
    t.after(other.close);
    assert.equal((await runClimFast(['send', 'p1', long, '--json'], other.url)).status, 6);
});

test('send: text shorter than 24 characters is compared in full', async (t) => {
    const api = await startPromptApi({ startBusy: true, submittedLines: ['❯ please carry on now', '⏺ ok'] });
    t.after(api.close);
    assert.equal((await runClimFast(['send', 'p1', 'please carry on now', '--json'], api.url)).status, 0);
    const missing = await startPromptApi({ startBusy: true, submittedLines: ['❯ please carry on', '⏺ ok'] });
    t.after(missing.close);
    assert.equal((await runClimFast(['send', 'p1', 'please carry on now', '--json'], missing.url)).status, 6);
});

test('send --no-submit-check does not look at the screen again', async (t) => {
    const api = await startPromptApi({ startBusy: true, submittedLines: ['⏺ nothing here'] });
    t.after(api.close);
    const r = await sendJson(api, ['--no-submit-check']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).visible, undefined);
    assert.equal(api.requests.filter((q) => q.method === 'GET' && q.path.endsWith('/output')).length, 0);
});

test('send --file: sends one pointer line, never the body', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clim-send-'));
    const file = join(dir, 'brief.md');
    writeFileSync(file, '# A very long brief\n' + 'body '.repeat(1000));
    const line = `Full instructions are in ${file} — read it to the end and carry it out.`;
    const api = await startPromptApi({ startBusy: true, submittedLines: [`❯ ${line}`, '⏺ Read 1 file'] });
    t.after(api.close);
    const r = await runClimFast(['send', 'p1', '--file', file, '--json'], api.url);
    assert.equal(r.status, 0, r.stderr);
    const posts = api.requests.filter((q) => q.method === 'POST' && q.path === '/v1/sessions/p1/input');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.text, line);
});

test('send --file: a missing file, or text given together with it, is a usage error (2) and sends nothing', async (t) => {
    const api = await startPromptApi({ startBusy: true });
    t.after(api.close);
    assert.equal((await runClimFast(['send', 'p1', '--file', '/tmp/clim-no-such-file.md'], api.url)).status, 2);
    assert.equal((await runClimFast(['send', 'p1', 'extra text', '--file', '/tmp'], api.url)).status, 2);
    assert.equal(api.requests.some((q) => q.path === '/v1/sessions/p1/input'), false);
});

// ---------------------------------------------------------------- session folders, relations, hand-over (app 1.21+)

// Records every request and answers per route, so what was sent can be inspected.
function startRoutedApi(routes) {
    const requests = [];
    const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
            const url = new URL(req.url, 'http://127.0.0.1');
            requests.push({ method: req.method, path: url.pathname, search: url.search, body: raw ? JSON.parse(raw) : null });
            res.setHeader('content-type', 'application/json');
            const key = `${req.method} ${url.pathname}`;
            const answer = routes[key];
            if (answer === undefined) {
                res.statusCode = 404;
                return res.end(JSON.stringify({ error: { code: 'not_found', message: key } }));
            }
            res.end(JSON.stringify(typeof answer === 'function' ? answer() : answer));
        });
    });
    return listen(server).then((api) => ({ ...api, requests }));
}

const listing = [session('aaaa1111'), session('bbbb2222')];

test('folders: lists folders with their sessions', async (t) => {
    const api = await startRoutedApi({
        'GET /v1/session-folders': { folders: [{ id: 'f0f0f0f0-1', name: 'Release', createdAt: 'x', sessions: [{ id: 'aaaa1111', name: 'A', workspaceName: 'W' }] }] }
    });
    t.after(api.close);
    const r = await runClim(['folders'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Release {2}\(1\)/);
    assert.match(r.stdout, /aaaa1111 {2}A {2}\[W\]/);
});

test('folder new / rename / rm send the right requests', async (t) => {
    const api = await startRoutedApi({
        'POST /v1/session-folders': { folder: { id: 'fid-1', name: 'Ship' }, created: false },
        'POST /v1/session-folders/Ship/rename': { id: 'fid-1', name: 'Done' },
        'DELETE /v1/session-folders/Done': { removed: true, releasedSessions: 2 }
    });
    t.after(api.close);
    const made = await runClim(['folder', 'new', 'Ship'], api.url);
    assert.equal(made.status, 0, made.stderr);
    assert.match(made.stdout, /already exists/);
    assert.deepEqual(api.requests[0].body, { name: 'Ship' });
    assert.equal((await runClim(['folder', 'rename', 'Ship', 'Done'], api.url)).status, 0);
    assert.deepEqual(api.requests[1].body, { name: 'Done' });
    const removed = await runClim(['folder', 'rm', 'Done'], api.url);
    assert.match(removed.stdout, /2 sessions stay open/);
});

test('folder put / out resolve the session and post to session-folder (out sends null)', async (t) => {
    const api = await startRoutedApi({
        'GET /v1/sessions': listing,
        'POST /v1/sessions/aaaa1111/session-folder': () => ({ sessionFolder: { id: 'f', name: 'Ship' } })
    });
    t.after(api.close);
    assert.equal((await runClim(['folder', 'put', 'aaaa', 'Ship'], api.url)).status, 0);
    assert.equal((await runClim(['folder', 'out', 'aaaa'], api.url)).status, 0);
    const posts = api.requests.filter((q) => q.path.endsWith('/session-folder'));
    assert.deepEqual(posts.map((q) => q.body), [{ folder: 'Ship' }, { folder: null }]);
});

test('folder: an unknown action or a missing argument is a usage error (2)', async (t) => {
    const api = await startRoutedApi({});
    t.after(api.close);
    assert.equal((await runClim(['folder', 'nope'], api.url)).status, 2);
    assert.equal((await runClim(['folder', 'new'], api.url)).status, 2);
    assert.equal((await runClim(['folder', 'rm'], api.url)).status, 2);
});

test('open --session-folder reaches the body as sessionFolder', async (t) => {
    const api = await startFakeApi([]);
    t.after(api.close);
    const r = await runClim(['open', '/tmp/x', '--session-folder', 'Ship'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(api.requests.find((q) => q.method === 'POST' && q.path === '/v1/sessions').body.sessionFolder, 'Ship');
});

test('relations: shows direction and kind', async (t) => {
    const api = await startRoutedApi({
        'GET /v1/sessions': listing,
        'GET /v1/sessions/aaaa1111/relations': {
            sessionId: 'aaaa1111',
            relations: [{ sessionId: 'bbbb2222', name: 'B', workspaceName: 'W', kind: 'opened', direction: 'outgoing', at: '2026-10-27T00:00:00.000Z' }]
        }
    });
    t.after(api.close);
    const r = await runClim(['relations', 'aaaa'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /→ bbbb2222 {2}opened {2}B/);
});

test('fork: resolves the session, sends scope/message/turnIndex and prints the new session link', async (t) => {
    const api = await startRoutedApi({
        'GET /v1/sessions': listing,
        'POST /v1/sessions/aaaa1111/fork': { session: session('cccc3333'), scope: 'excerpt', messageSent: true }
    });
    t.after(api.close);
    const r = await runClim(['fork', 'aaaa', '--excerpt', '--message', 'docs only', '--turn', '4'], api.url);
    assert.equal(r.status, 0, r.stderr);
    const sent = api.requests.find((q) => q.method === 'POST' && q.path === '/v1/sessions/aaaa1111/fork').body;
    assert.deepEqual(sent, { scope: 'excerpt', message: 'docs only', turnIndex: 4 });
    assert.match(r.stdout, /excerpt · first message typed/);
    assert.match(r.stdout, /climanager:\/\/session\/cccc3333/);
});

test('fork: no session means the current one (CLIMANAGER_SESSION_ID); the default scope is the whole conversation', async (t) => {
    const api = await startRoutedApi({
        'GET /v1/sessions': listing,
        'POST /v1/sessions/aaaa1111/fork': { session: session('cccc3333'), scope: 'whole', messageSent: false }
    });
    t.after(api.close);
    // runClim deletes CLIMANAGER_SESSION_ID — call as if inside an app terminal, with that value set
    const env = { ...process.env, CLIM_URL: api.url, CLIM_TOKEN: 'test-token', CLIMANAGER_SESSION_ID: 'aaaa1111' };
    const r = await new Promise((resolve) => {
        execFile(process.execPath, [CLIM, 'fork'], { env, encoding: 'utf8' }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }));
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(api.requests.find((q) => q.path === '/v1/sessions/aaaa1111/fork').body, { scope: 'whole' });
});

test('close --hand-to: resolves the heir, sends handTo and reports how many pairs moved', async (t) => {
    const api = await startRoutedApi({
        'GET /v1/sessions': listing,
        'GET /v1/sessions/aaaa1111': session('aaaa1111'),
        'DELETE /v1/sessions/aaaa1111': { ok: true, handedOver: 3 }
    });
    t.after(api.close);
    const r = await runClim(['close', 'aaaa', '--hand-to', 'bbbb'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /handed 3 Related pairs to bbbb2222/);
    assert.equal(api.requests.find((q) => q.method === 'DELETE').search, '?handTo=bbbb2222');
});

test('close --hand-to: if the heir cannot be found nothing is closed (4)', async (t) => {
    const api = await startRoutedApi({
        'GET /v1/sessions': listing,
        'GET /v1/sessions?scope=all': listing,
        'GET /v1/sessions/aaaa1111': session('aaaa1111')
    });
    t.after(api.close);
    const r = await runClim(['close', 'aaaa', '--hand-to', 'zzzz'], api.url);
    assert.equal(r.status, 4);
    assert.equal(api.requests.filter((q) => q.method === 'DELETE').length, 0);
});

test('open prints the session folder and the memo page count', async (t) => {
    const api = await startRoutedApi({
        'POST /v1/sessions': () => ({
            session: { id: 'new-session', name: 'n', workspaceName: 'w', cwd: '/x', command: 'claude', state: 'idle', awaitingInput: false, sessionFolder: { id: 'f', name: 'Ship' }, memoPages: ['a', 'b', 'c'] },
            promptSent: false
        })
    });
    t.after(api.close);
    const r = await runClim(['open', '/tmp/x'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /session folder {2}Ship/);
    assert.match(r.stdout, /memo {5}3 pages/);
});

// ---------------------------------------------------------------- inbox (app 1.18+)

test('inbox: sends kind, text, url and the session; --session is resolved to an id', async (t) => {
    const api = await startRoutedApi({
        'GET /v1/sessions': listing,
        'POST /v1/inbox': { created: true, request: { id: 'req-12345678', kind: 'login', sessionId: 'aaaa1111', sessionName: 'A' } }
    });
    t.after(api.close);
    const r = await runClim(['inbox', 'login', 'Sign in to the dashboard', '--url', 'https://example.com/login', '--session', 'aaaa'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(api.requests.find((q) => q.method === 'POST').body, { kind: 'login', text: 'Sign in to the dashboard', url: 'https://example.com/login', sessionId: 'aaaa1111' });
    assert.match(r.stdout, /sent to the inbox/);
});

test('inbox: a bad kind, a missing line, or no session to attribute it to is a usage error (2)', async (t) => {
    const api = await startRoutedApi({});
    t.after(api.close);
    assert.equal((await runClim(['inbox', 'nonsense', 'x'], api.url)).status, 2);
    assert.equal((await runClim(['inbox', 'login'], api.url)).status, 2);
    assert.equal((await runClim(['inbox', 'login', 'x'], api.url)).status, 2); // outside an app terminal and without --session
});

test('inbox list --unread and inbox read (by id prefix)', async (t) => {
    const request = { id: 'req-12345678', kind: 'review', sessionId: 'aaaa1111', sessionName: 'A', text: 'look at this', read: false, at: '2026-11-01T00:00:00.000Z' };
    const api = await startRoutedApi({
        'GET /v1/inbox': { unreadCount: 1, requests: [request] },
        'POST /v1/inbox/req-12345678/read': { ...request, read: true }
    });
    t.after(api.close);
    const listed = await runClim(['inbox', 'list', '--unread'], api.url);
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(api.requests[0].search, '?unread=1');
    assert.match(listed.stdout, /req-1234 {2}unread {2}review {2}A {2}look at this/);
    const read = await runClim(['inbox', 'read', 'req-12'], api.url);
    assert.equal(read.status, 0, read.stderr);
    assert.match(read.stdout, /marked read: req-1234/);
});

// ---------------------------------------------------------------- checklists (app 1.24+)

const CL_ID = 'c0ffee12-3456-7890-abcd-ef0123456789';
const checklistOf = (items, extra = {}) => ({
    id: CL_ID, title: 'release', workspaceId: null, workspaceName: null, due: null, overdue: false,
    done: items.filter((i) => i.done).length, total: items.length, complete: items.length > 0 && items.every((i) => i.done),
    items: items.map((i, n) => ({ id: `item-${n + 1}`, n: n + 1, text: i.text, done: Boolean(i.done), doneAt: null })),
    client: 'clim', createdBy: null, createdByName: null, createdAt: 'x', updatedAt: 'x', ...extra
});
const twoItems = checklistOf([{ text: 'build', done: true }, { text: 'publish' }], { due: '2026-11-02' });

test('checklists: unfinished by default (status=open); --all and --project go into the query', async (t) => {
    const api = await startRoutedApi({ 'GET /v1/checklists': { checklists: [twoItems] } });
    t.after(api.close);
    const r = await runClim(['checklists'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /c0ffee12 {2}release {2}1\/2 · due 2026-11-02/);
    assert.equal(api.requests[0].search, '?status=open');
    assert.equal((await runClim(['checklists', '--all', '--project', 'myproj'], api.url)).status, 0);
    assert.equal(api.requests[1].search, '?status=all&project=myproj');
    assert.equal((await runClim(['checklists', '--all', '--done'], api.url)).status, 2);
});

test('checklist new: words after the title become items; --due and --project go into the body', async (t) => {
    const api = await startRoutedApi({ 'POST /v1/checklists': { checklist: twoItems, created: true } });
    t.after(api.close);
    const r = await runClim(['checklist', 'new', 'release', 'build', 'publish', '--due', '2026-11-02', '--project', 'myproj'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(api.requests[0].body, { title: 'release', items: ['build', 'publish'], due: '2026-11-02', project: 'myproj' });
    assert.match(r.stdout, /created/);
    assert.match(r.stdout, / {3}1 \[x\] build\n {3}2 \[ \] publish/);
    assert.equal((await runClim(['checklist', 'new'], api.url)).status, 2);
});

test('checklist check: an id prefix is resolved to the full id, and each number gets its own done (--undo is false)', async (t) => {
    const api = await startRoutedApi({
        'GET /v1/checklists': { checklists: [twoItems] },
        [`POST /v1/checklists/${CL_ID}/items/1`]: { checklist: twoItems },
        [`POST /v1/checklists/${CL_ID}/items/2`]: { checklist: twoItems }
    });
    t.after(api.close);
    const r = await runClim(['checklist', 'check', 'c0ffee', '1', '2'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(api.requests[0].search, '?status=all');
    const posts = api.requests.filter((q) => q.method === 'POST');
    assert.deepEqual(posts.map((q) => [q.path, q.body.done]), [[`/v1/checklists/${CL_ID}/items/1`, true], [`/v1/checklists/${CL_ID}/items/2`, true]]);
    assert.equal((await runClim(['checklist', 'check', 'c0ffee', '2', '--undo'], api.url)).status, 0);
    assert.equal(api.requests.at(-1).body.done, false);
    assert.equal((await runClim(['checklist', 'check', 'c0ffee'], api.url)).status, 2);
});

test('checklist: a title is passed on as is, without reading the list', async (t) => {
    const api = await startRoutedApi({ 'GET /v1/checklists/release': { checklist: twoItems } });
    t.after(api.close);
    const r = await runClim(['checklist', 'show', 'release'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(api.requests.map((q) => `${q.method} ${q.path}`), ['GET /v1/checklists/release']);
});

test('checklist edit: --due none sends null (clears); nothing to change is a usage error (2)', async (t) => {
    const api = await startRoutedApi({ 'POST /v1/checklists/release': { checklist: twoItems } });
    t.after(api.close);
    assert.equal((await runClim(['checklist', 'edit', 'release', '--due', 'none', '--title', 'ship'], api.url)).status, 0);
    assert.deepEqual(api.requests[0].body, { title: 'ship', due: null });
    assert.equal((await runClim(['checklist', 'edit', 'release'], api.url)).status, 2);
});

test('checklist add / rm-item / rm; an unknown action is a usage error (2)', async (t) => {
    const api = await startRoutedApi({
        'POST /v1/checklists/release/items': { checklist: twoItems, added: 1 },
        'DELETE /v1/checklists/release/items/2': { checklist: twoItems },
        'DELETE /v1/checklists/release': { ok: true }
    });
    t.after(api.close);
    const added = await runClim(['checklist', 'add', 'release', 'build', 'verify'], api.url);
    assert.equal(added.status, 0, added.stderr);
    assert.deepEqual(api.requests[0].body, { items: ['build', 'verify'] });
    assert.match(added.stdout, /added 1 \(1 skipped, already there\)/);
    assert.equal((await runClim(['checklist', 'rm-item', 'release', '2'], api.url)).status, 0);
    const removed = await runClim(['checklist', 'rm', 'release'], api.url);
    assert.equal(removed.status, 0, removed.stderr);
    assert.match(removed.stdout, /checklist deleted: release/);
    assert.equal((await runClim(['checklist', 'nope'], api.url)).status, 2);
});

// A real old app answers an unknown route with no_route (the fake's 404 is not_found, which means "no such session").
async function startOldApp(t) {
    const oldApp = createServer((req, res) => {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { code: 'no_route', message: `No route for ${req.method} ${req.url}` } }));
    });
    const api = await listen(oldApp);
    t.after(api.close);
    return api;
}

test('an old app (no_route) gives exit 1 and a hint listing the app versions that have each command', async (t) => {
    const api = await startOldApp(t);
    const r = await runClim(['checklists'], api.url);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /checklist: app 1\.24\+/);
    assert.match(r.stderr, /inbox: app 1\.18\+/);
    assert.match(r.stderr, /cron: app 1\.34\+/);
});

// ---------------------------------------------------------------- Autocron (app 1.34+)

const cronOf = (extra = {}) => ({
    id: 'abcd1234-0000', name: 'morning check', schedule: '0 9 * * 1-5', mode: 'new', agent: 'claude', cwd: '/work', prompt: 'check it',
    enabled: true, nextRunAt: Date.UTC(2026, 10, 3, 0, 0), createdBy: 'clim', missed: { policy: 'once', withinMinutes: 30 }, ...extra
});

test('cron new: flags become the body (cwd resolved, --missed/--within nested); schedule and prompt are required', async (t) => {
    const api = await startRoutedApi({ 'POST /v1/crons': { cron: cronOf(), created: true } });
    t.after(api.close);
    const r = await runClim(['cron', 'new', 'morning check', '--schedule', '0 9 * * 1-5', '--cwd', '/work', '--agent', 'claude', '--prompt', 'check it', '--missed', 'once', '--within', '30', '--off'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(api.requests[0].body, {
        name: 'morning check', schedule: '0 9 * * 1-5', cwd: '/work', agent: 'claude', prompt: 'check it', missed: { policy: 'once', withinMinutes: 30 }, enabled: false
    });
    assert.match(r.stdout, /abcd1234 {2}morning check {2}\[0 9 \* \* 1-5\]/);
    assert.equal((await runClim(['cron', 'new', 'x', '--prompt', 'p'], api.url)).status, 2);
    assert.equal((await runClim(['cron', 'new', 'x', '--schedule', '@daily'], api.url)).status, 2);
});

test('cron: an id prefix is resolved; pause/resume/run/runs/rm hit the right routes', async (t) => {
    const api = await startRoutedApi({
        'GET /v1/crons': { crons: [cronOf()] },
        'POST /v1/crons/abcd1234-0000/pause': { cron: cronOf({ enabled: false }) },
        'POST /v1/crons/abcd1234-0000/run': { run: { at: 0, status: 'started', trigger: 'manual', sessionId: 'sess1234-5' } },
        'GET /v1/crons/abcd1234-0000/runs': { runs: [] },
        'DELETE /v1/crons/abcd1234-0000': { ok: true }
    });
    t.after(api.close);
    assert.equal((await runClim(['cron', 'pause', 'abcd'], api.url)).status, 0);
    const ran = await runClim(['cron', 'run', 'abcd'], api.url);
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /started · manual · session sess1234/);
    assert.match((await runClim(['cron', 'runs', 'abcd'], api.url)).stdout, /No run history/);
    assert.match((await runClim(['cron', 'rm', 'abcd'], api.url)).stdout, /job deleted/);
    assert.equal((await runClim(['cron', 'nope'], api.url)).status, 2);
});

test('cron run: a failed run exits 1', async (t) => {
    const api = await startRoutedApi({ 'POST /v1/crons/morning/run': { run: { at: 0, status: 'failed', trigger: 'manual', note: 'no cwd' } } });
    t.after(api.close);
    assert.equal((await runClim(['cron', 'run', 'morning'], api.url)).status, 1);
});

// ---------------------------------------------------------------- agents, models, effort

async function openAndGetBody(args) {
    const api = await startFakeApi([]);
    try {
        const r = await runClim(['open', '/work/proj', ...args, '--json'], api.url);
        const post = api.requests.find((q) => q.method === 'POST' && q.path === '/v1/sessions');
        return { r, body: post?.body };
    } finally {
        api.close();
    }
}

test('--agent codex --model --effort builds a codex command with the update menu turned off', async () => {
    const { r, body } = await openAndGetBody(['--agent', 'codex', '--model', 'model-a', '--effort', 'high']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(body.command, 'codex -c check_for_update_on_startup=false --dangerously-bypass-approvals-and-sandbox -m model-a -c model_reasoning_effort="high"');
    assert.equal('template' in body, false);
});

test('Codex effort is passed through as given — low and medium are not raised', async () => {
    const a = await openAndGetBody(['--agent', 'codex', '--model', 'model-a', '--effort', 'medium']);
    assert.equal(a.r.status, 0, a.r.stderr);
    assert.match(a.body.command, /-m model-a -c model_reasoning_effort="medium"$/);
    assert.equal(a.r.stderr, '');
    const b = await openAndGetBody(['--command', 'codex -m model-a -c model_reasoning_effort="low"']);
    assert.match(b.body.command, /model_reasoning_effort="low"/);
});

test('--agent claude --model sonnet --effort low becomes claude flags', async () => {
    const { r, body } = await openAndGetBody(['--agent', 'claude', '--model', 'sonnet', '--effort', 'low']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(body.command, 'claude --dangerously-skip-permissions --model sonnet --effort low');
});

test('--agent codex-research is the sandboxed search preset with the update menu off', async () => {
    const { r, body } = await openAndGetBody(['--agent', 'codex-research', '--model', 'model-a']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(body.command, 'codex -c check_for_update_on_startup=false -s workspace-write -a never --search -m model-a');
});

test('--template codex without a model is turned into a command so the update menu is still off', async () => {
    const { r, body } = await openAndGetBody(['--template', 'codex']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(body.command, 'codex -c check_for_update_on_startup=false --dangerously-bypass-approvals-and-sandbox');
    assert.equal('template' in body, false);
});

test('--template claude-code --model sonnet appends to the template command', async () => {
    const { r, body } = await openAndGetBody(['--template', 'claude-code', '--model', 'sonnet']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(body.command, 'claude --model sonnet');
});

test('a Claude template without a model goes out by template name', async () => {
    const { r, body } = await openAndGetBody(['--template', 'claude-code']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(body.template, 'claude-code');
    assert.equal('command' in body, false);
});

test('a codex given with --command also gets the update menu off, and it is not added twice', async () => {
    const a = await openAndGetBody(['--command', 'codex -m model-a']);
    assert.equal(a.body.command, 'codex -c check_for_update_on_startup=false -m model-a');
    const b = await openAndGetBody(['--command', 'codex -c check_for_update_on_startup=false']);
    assert.equal(b.body.command, 'codex -c check_for_update_on_startup=false');
});

test('words that merely contain codex (codex-runner) are left alone', async () => {
    const { body } = await openAndGetBody(['--command', 'codex-runner --x']);
    assert.equal(body.command, 'codex-runner --x');
});

test('bad combinations are usage errors (2), with a hint for --template plus --command', async () => {
    assert.equal((await openAndGetBody(['--agent', 'gemini'])).r.status, 2);
    assert.equal((await openAndGetBody(['--agent', 'codex', '--template', 'codex'])).r.status, 2);
    assert.equal((await openAndGetBody(['--model', 'sonnet'])).r.status, 2);
    assert.equal((await openAndGetBody(['--template', 'custom-tool', '--model', 'x'])).r.status, 2);
    assert.equal((await openAndGetBody(['--template', 'nope', '--model', 'x'])).r.status, 2);
    const both = await openAndGetBody(['--template', 'claude-code', '--command', 'claude --model sonnet']);
    assert.equal(both.r.status, 2);
    assert.match(both.r.stderr, /drop --template/);
});

for (const command of ['codex -m a', 'codex --model a', 'codex --model=a', 'codex --model "old model" -m duplicate']) {
    test(`an existing model option is replaced, not duplicated: ${command}`, async () => {
        const { r, body } = await openAndGetBody(['--command', command, '--model', 'b']);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(body.command, 'codex -c check_for_update_on_startup=false -m b');
    });
}

for (const command of ['codex -c model_reasoning_effort="high"', 'codex -c "model_reasoning_effort=high"', "codex -c 'model_reasoning_effort=high'"]) {
    test(`a Codex effort option is replaced and other settings kept: ${command}`, async () => {
        const { r, body } = await openAndGetBody(['--command', `${command} -c other=true`, '--effort', 'xhigh']);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(body.command, 'codex -c check_for_update_on_startup=false -c other=true -c model_reasoning_effort="xhigh"');
    });
}

test('Claude model and effort replace the existing options in place, one each', async () => {
    const { r, body } = await openAndGetBody(['--command', 'claude --model=opus --effort high', '--model', 'sonnet', '--effort', 'low']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(body.command, 'claude --model sonnet --effort low');
});

// ---------------------------------------------------------------- Codex start-up screens

// "Trust this folder? … › 1. Trust and continue" is answered with Enter; "Hooks need review" is not answered and stops with exit 3.
const CODEX_TRUST_SCREEN = ['  Trust this folder? Codex can read, edit, and run files here.', '› 1. Trust and continue', '  2. Quit', '  enter continue · esc quit'];
const CODEX_HOOKS_SCREEN = ['  Hooks need review', '  1 hook is new or changed.', '› 1. Review hooks', '  2. Trust all and continue', '  3. Continue without trusting (hooks won\'t run)'];
const CODEX_READY_SCREEN = ['› Ask Codex to do anything', '  model-a medium · Context 100% left'];

function startStartupApi(firstScreen) {
    const requests = [];
    let lines = firstScreen;
    let awaiting = true;
    const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
            const url = new URL(req.url, 'http://127.0.0.1');
            const body = raw ? JSON.parse(raw) : null;
            requests.push({ method: req.method, path: url.pathname, body });
            res.setHeader('content-type', 'application/json');
            const s = () => ({ id: 'cx-1', name: 'n', workspaceName: 'w', cwd: '/x', command: 'codex', state: 'idle', awaitingInput: awaiting });
            if (req.method === 'POST' && url.pathname === '/v1/sessions') return res.end(JSON.stringify({ session: s(), promptSent: false }));
            if (req.method === 'GET' && url.pathname === '/v1/sessions/cx-1/output') return res.end(JSON.stringify({ session: s(), mode: 'screen', lines }));
            if (req.method === 'POST' && url.pathname === '/v1/sessions/cx-1/input') {
                if (lines === CODEX_TRUST_SCREEN) { lines = CODEX_READY_SCREEN; awaiting = false; }
                return res.end(JSON.stringify({ ok: true }));
            }
            if (req.method === 'GET' && url.pathname === '/v1/sessions/cx-1') return res.end(JSON.stringify(s()));
            res.statusCode = 404;
            res.end(JSON.stringify({ error: { code: 'not_found', message: url.pathname } }));
        });
    });
    return listen(server).then((api) => ({ ...api, requests }));
}

test('Codex 0.164+ "Trust this folder?" is answered with Enter ("Trust and continue")', async (t) => {
    const api = await startStartupApi(CODEX_TRUST_SCREEN);
    t.after(api.close);
    const r = await runClim(['open', '/work/proj', '--agent', 'codex', '--json'], api.url);
    assert.equal(r.status, 0, r.stderr);
    const input = api.requests.find((q) => q.method === 'POST' && q.path === '/v1/sessions/cx-1/input');
    assert.deepEqual(input.body.keys, ['enter']);
    assert.equal(JSON.parse(r.stdout).trustedFolder, true);
});

test('"Hooks need review" is not answered on your behalf — it stays a question (exit 3) with no input sent', async (t) => {
    const api = await startStartupApi(CODEX_HOOKS_SCREEN);
    t.after(api.close);
    const r = await runClim(['open', '/work/proj', '--agent', 'codex'], api.url);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.equal(api.requests.some((q) => q.path === '/v1/sessions/cx-1/input'), false);
});

// Codex has no rule-bounded input box — if no work lines (• or ◦) follow the "› <text>" line, it was not submitted yet.
const CODEX_STUCK = ['  >_ OpenAI Codex (v0.166.0)', '› Full instructions are in /tmp/brief.md — read it to the end', '  and carry it out. · policy …', '  model-a medium · Context 100% left · 0 in · 0 out'];
const CODEX_WORKING = ['› Full instructions are in /tmp/brief.md — read it to the end', '• Explored', '◦ Working (5s • esc to interrupt)', '› Ask Codex to do anything', '  model-a medium · 12K in'];
const OPEN_CODEX_WITH_PROMPT = ['open', '/work/proj', '--agent', 'codex', '--prompt', PROMPT, '--no-policy', '--json'];

test('a first prompt stuck in the Codex input box gets one more Enter', async (t) => {
    const api = await startPromptApi({ startBusy: false, stuckLines: CODEX_STUCK });
    t.after(api.close);
    const r = await runClimFast(OPEN_CODEX_WITH_PROMPT, api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(enterCount(api), 1);
    assert.equal(JSON.parse(r.stdout).promptCheck, 'retried');
});

test('a Codex screen that is already working (• or ◦ after the › line) gets no Enter', async (t) => {
    const api = await startPromptApi({ startBusy: false, stuckLines: CODEX_WORKING });
    t.after(api.close);
    const r = await runClimFast(OPEN_CODEX_WITH_PROMPT, api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(enterCount(api), 0);
});

test('a first prompt folded into "[Pasted Content N chars]" and left in the Codex box gets Enter again', async (t) => {
    const api = await startPromptApi({ startBusy: false, stuckLines: ['  >_ OpenAI Codex (v0.166.0)', '› [Pasted Content 1534 chars]', '', '  model-a medium · Context 100% left · 0 in · 0 out'] });
    t.after(api.close);
    const r = await runClimFast(OPEN_CODEX_WITH_PROMPT, api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(enterCount(api), 1);
    assert.equal(JSON.parse(r.stdout).promptCheck, 'retried');
});

test('Codex trust menu choice rows drawn before the question sentence are not read as the input box', async (t) => {
    const requests = [];
    let reads = 0;
    let trusted = false;
    const partial = ['  Folder access', '› 1. Trust and continue', '  2. Quit'];
    const full = ['  Folder access', '  /work/new', '  Trust this folder? Codex can read, edit, and run files here.', '› 1. Trust and continue', '  2. Quit', '  enter continue · esc quit'];
    const ready = ['› Ask Codex to do anything', '  model-a high'];
    const screen = () => ({ session: { id: 'cx-1', name: 'n', state: 'idle', awaitingInput: !trusted && reads > 2 }, lines: trusted ? ready : reads <= 2 ? partial : full });
    const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
            const url = new URL(req.url, 'http://127.0.0.1');
            const body = raw ? JSON.parse(raw) : null;
            requests.push({ method: req.method, path: url.pathname, body });
            res.setHeader('content-type', 'application/json');
            if (req.method === 'POST' && url.pathname === '/v1/sessions') return res.end(JSON.stringify({ session: screen().session, promptSent: false }));
            if (url.pathname.endsWith('/output')) { reads++; return res.end(JSON.stringify(screen())); }
            if (url.pathname === '/v1/sessions/cx-1') return res.end(JSON.stringify(screen().session));
            if (url.pathname.endsWith('/wait')) return res.end(JSON.stringify(screen()));
            if (url.pathname.endsWith('/input')) {
                if (body.keys && !trusted && reads > 2) trusted = true;
                return res.end(JSON.stringify({ ok: true }));
            }
            res.statusCode = 404; res.end('{}');
        });
    });
    const api = await listen(server);
    t.after(api.close);
    const r = await runClimFast(['open', '/work/new', '--agent', 'codex', '--model', 'model-a', '--effort', 'high', '--prompt', 'hello agent', '--no-policy', '--json'], api.url);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const inputs = requests.filter((q) => q.path.endsWith('/input')).map((q) => q.body);
    assert.ok(inputs[0].keys, `first input must answer the trust menu, got ${JSON.stringify(inputs)}`);
    assert.ok(inputs.some((b) => b.text === 'hello agent'), JSON.stringify(inputs));
    assert.equal(JSON.parse(r.stdout).trustedFolder, true);
});

// ---------------------------------------------------------------- wait must not end on "quiet" alone

// While Claude runs a long shell its spinner line has no "esc to interrupt" and the app returned idle.
// If a spinner is still on the returned screen, wait again.
function startWaitApi(screens) {
    const requests = [];
    let n = 0;
    const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
            const url = new URL(req.url, 'http://127.0.0.1');
            requests.push({ method: req.method, path: url.pathname, body: raw ? JSON.parse(raw) : null });
            res.setHeader('content-type', 'application/json');
            const s = { id: 'w1', name: 'n', state: 'idle', awaitingInput: false };
            if (req.method === 'GET' && url.pathname === '/v1/sessions') return res.end(JSON.stringify([s]));
            if (req.method === 'POST' && url.pathname === '/v1/sessions/w1/wait') {
                const lines = screens[Math.min(n, screens.length - 1)]; n++;
                return res.end(JSON.stringify({ session: s, mode: 'screen', lines, timedOut: false, waitedMs: 10 }));
            }
            res.statusCode = 404; res.end(JSON.stringify({ error: { code: 'not_found', message: url.pathname } }));
        });
    });
    return listen(server).then((api) => ({ ...api, requests }));
}
const runClimBusy = (args, apiUrl) => runClim(args, apiUrl, { CLIM_BUSY_RECHECK_MS: '10' });
const waitCalls = (api) => api.requests.filter((q) => q.path === '/v1/sessions/w1/wait').length;
const CLAUDE_BUSY = ['⏺ Bash(node --test …)', '  ⎿  (1m 16s)', '✽ Catapulting… (1m 33s · ↓ 817 tokens)', '❯ ', '  ~/x | Sonnet'];
const CLAUDE_DONE = ['⏺ All done.', '✻ Crunched for 4m 22s · done 1:18 AM', '❯ ', '  ~/x | Sonnet'];

test('wait: a Claude spinner still on screen is not "finished" — it waits again', async (t) => {
    const api = await startWaitApi([CLAUDE_BUSY, CLAUDE_BUSY, CLAUDE_DONE]);
    t.after(api.close);
    const r = await runClimBusy(['wait', 'w1', '--timeout', '30', '--json'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(waitCalls(api), 3);
    assert.match(JSON.parse(r.stdout).lines.join('\n'), /Crunched for/);
});

for (const [name, line] of [
    ['a spinner before the token count', '✽ Thinking… (5s)'],
    ['the run-in-background hint', '(ctrl+b to run in background)'],
]) {
    test(`wait: ${name} on screen means wait again`, async (t) => {
        const api = await startWaitApi([[line, '❯ '], CLAUDE_DONE]);
        t.after(api.close);
        const r = await runClimBusy(['wait', 'w1', '--json'], api.url);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(waitCalls(api), 2);
    });
}

test('wait: finished screens ("Crunched for", "Worked for") end in one call', async (t) => {
    for (const screen of [['✻ Crunched for 1m 40s', '❯ '], CLAUDE_DONE]) {
        const api = await startWaitApi([screen]);
        t.after(api.close);
        const r = await runClimBusy(['wait', 'w1', '--json'], api.url);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(waitCalls(api), 1);
    }
});

test('wait: Codex "Working (… • esc to interrupt)" counts as working; --no-busy-check waits once', async (t) => {
    const busy = ['• Ran tests', '◦ Working (38s • esc to interrupt)', '› Ask Codex to do anything'];
    const done = ['• done', '  Worked for 5m 19s • 12:52 AM', '› Ask Codex to do anything'];
    const a = await startWaitApi([busy, done]);
    t.after(a.close);
    const r = await runClimBusy(['wait', 'w1', '--json'], a.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(waitCalls(a), 2);
    const b = await startWaitApi([busy, done]);
    t.after(b.close);
    const r2 = await runClimBusy(['wait', 'w1', '--no-busy-check', '--json'], b.url);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(waitCalls(b), 1);
});

test('wait: a spinner right to the end ends as a timeout (7)', async (t) => {
    const api = await startWaitApi([CLAUDE_BUSY]);
    t.after(api.close);
    const r = await runClimBusy(['wait', 'w1', '--timeout', '2'], api.url);
    assert.equal(r.status, 7, r.stdout + r.stderr);
});

// ---------------------------------------------------------------- start-up: slow or late questions

// The open response is a shell screen, and Claude's trust question is drawn 1.2 s later.
function startDelayedTrustApi({ delayMs = 1_200, ready = false, promptSent = false, readyAfterMs = null, prefilled = false, partialTrust = false } = {}) {
    const requests = [];
    let openedAt = 0;
    let trusted = ready;
    let submitted = false;
    let stuck = prefilled;
    let outputReads = 0;
    const trustLines = partialTrust
        ? ['Quick safety check: Is this a project you created or one you trust?', '❯ No, exit', '  Yes, I trust this folder']
        : ['Do you trust the files in this folder?', '  Yes, I trust this folder', '❯ No, exit'];
    const readyLines = ['Claude Code', RULE, '❯ ', RULE];
    const current = () => {
        if (readyAfterMs !== null && Date.now() - openedAt >= readyAfterMs) trusted = true;
        const awaitingInput = readyAfterMs === null && !trusted && Date.now() - openedAt >= delayMs;
        return { session: { id: 'delay-1', name: 'n', state: submitted || stuck ? 'busy' : 'idle', awaitingInput },
            lines: awaitingInput ? (partialTrust && outputReads <= 1 ? [RULE, trustLines[0], '❯ No, exit'] : trustLines)
                : !trusted ? ['$ claude --model haiku'] : stuck ? STUCK_SCREEN : submitted ? SUBMITTED_SCREEN : readyLines };
    };
    const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
            const url = new URL(req.url, 'http://127.0.0.1');
            const body = raw ? JSON.parse(raw) : null;
            requests.push({ method: req.method, path: url.pathname, body, at: Date.now() });
            res.setHeader('content-type', 'application/json');
            if (req.method === 'GET' && url.pathname === '/v1/templates') return res.end(JSON.stringify(FAKE_TEMPLATES));
            if (req.method === 'POST' && url.pathname === '/v1/sessions') {
                openedAt = Date.now();
                return res.end(JSON.stringify({ session: current().session, promptSent }));
            }
            if (req.method === 'GET' && url.pathname.endsWith('/output')) {
                outputReads++;
                return res.end(JSON.stringify(current()));
            }
            if (req.method === 'GET' && url.pathname === '/v1/sessions/delay-1') return res.end(JSON.stringify(current().session));
            if (req.method === 'POST' && url.pathname.endsWith('/wait')) return res.end(JSON.stringify(current()));
            if (req.method === 'POST' && url.pathname.endsWith('/input')) {
                if (body.keys?.join() === (partialTrust ? 'down,enter' : 'up,enter') && current().session.awaitingInput) trusted = true;
                else if (body.text && trusted) stuck = true;
                else if (body.keys?.join() === 'enter' && stuck) { stuck = false; submitted = true; }
                return res.end(JSON.stringify({ ok: true }));
            }
            res.statusCode = 404;
            res.end('{}');
        });
    });
    return listen(server).then((api) => ({ ...api, requests }));
}

const DELAYED_OPEN = ['open', '/work/new-folder', '--command', 'claude --model haiku', '--prompt', PROMPT, '--no-policy', '--json'];

test('the cursor of a half-drawn trust menu is not the input box — it waits for the options, answers, then sends the prompt', async (t) => {
    const api = await startDelayedTrustApi({ delayMs: 0, partialTrust: true });
    t.after(api.close);
    const r = await runClimFast(DELAYED_OPEN, api.url);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.trustedFolder, true);
    assert.equal(result.promptSent, true);
    const firstInput = api.requests.findIndex((q) => q.path.endsWith('/input'));
    assert.ok(api.requests.slice(0, firstInput).filter((q) => q.path.endsWith('/output')).length >= 2);
    assert.deepEqual(api.requests.filter((q) => q.path.endsWith('/input')).map((q) => q.body), [
        { keys: ['down', 'enter'] }, { text: PROMPT }, { keys: ['enter'] }
    ]);
});

for (const promptSent of [false, true]) {
    test(`a late Claude trust question is answered, then the first prompt is submitted (open promptSent=${promptSent})`, async (t) => {
        const api = await startDelayedTrustApi({ promptSent });
        t.after(api.close);
        const r = await runClimFast(DELAYED_OPEN, api.url);
        assert.equal(r.status, 0, r.stderr);
        const result = JSON.parse(r.stdout);
        assert.equal(result.trustedFolder, true);
        assert.equal(api.requests[0].body.prompt, undefined); // the first prompt is not pre-typed into a shell
        assert.equal(result.promptSent, true);
        assert.equal(result.promptCheck, 'retried');
        assert.deepEqual(api.requests.filter((q) => q.path.endsWith('/input')).map((q) => q.body), [
            { keys: ['up', 'enter'] }, { text: PROMPT }, { keys: ['enter'] }
        ]);
    });
}

test('a ready Claude screen without a trust question sends the prompt with no extra waiting', async (t) => {
    const api = await startDelayedTrustApi({ ready: true });
    t.after(api.close);
    const r = await runClimFast(DELAYED_OPEN, api.url);
    assert.equal(r.status, 0, r.stderr);
    const firstInput = api.requests.findIndex((q) => q.path.endsWith('/input'));
    assert.ok(firstInput >= 0, r.stdout);
    assert.equal(api.requests.slice(0, firstInput).filter((q) => q.path.endsWith('/output')).length, 2); // readiness check + duplicate-input check
    assert.equal(JSON.parse(r.stdout).trustedFolder, false);
    assert.equal(JSON.parse(r.stdout).promptCheck, 'retried');
});

test('a screen that becomes ready after 6 seconds is waited for before the first prompt', async (t) => {
    const delayMs = 6_000;
    const api = await startDelayedTrustApi({ readyAfterMs: delayMs });
    t.after(api.close);
    const r = await runClimFast(DELAYED_OPEN, api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).promptSent, true);
    const opened = api.requests.find((q) => q.path === '/v1/sessions');
    const firstInput = api.requests.find((q) => q.path.endsWith('/input'));
    assert.ok(firstInput.at - opened.at >= delayMs);
    assert.equal(firstInput.body.text, PROMPT);
});

test('when the start-up wait expires, the prompt is not typed into a quiet shell and a note is left', async (t) => {
    const api = await startDelayedTrustApi({ readyAfterMs: Infinity });
    t.after(api.close);
    const r = await runClimFast(DELAYED_OPEN, api.url, { CLIM_STARTUP_RENDER_MS: '100' });
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.promptSent, false);
    assert.equal(result.note, 'Could not confirm the start-up screen, so the first prompt was not sent — read it with clim read and send it with clim send');
    assert.equal(api.requests.some((q) => /\/(input|wait)$/.test(q.path)), false);
});

test('when the API says promptSent:false but the text is already in the input box, only Enter is sent', async (t) => {
    const api = await startDelayedTrustApi({ ready: true, prefilled: true });
    t.after(api.close);
    const r = await runClimFast(['open', '/work/proj', '--template', 'claude-code', '--prompt', PROMPT, '--no-policy', '--json'], api.url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).promptSent, true);
    assert.deepEqual(api.requests.filter((q) => q.path.endsWith('/input')).map((q) => q.body), [{ keys: ['enter'] }]);
});

test('--no-trust stops at exit 3 on a late trust question, with no keys and no prompt sent', async (t) => {
    const api = await startDelayedTrustApi();
    t.after(api.close);
    const r = await runClimFast([...DELAYED_OPEN, '--no-trust'], api.url);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.equal(api.requests.some((q) => q.path.endsWith('/input')), false);
    assert.equal(JSON.parse(r.stdout).session.awaitingInput, true);
});

// ---------------------------------------------------------------- session policy file (off unless the file exists)

test('policy: off without the file; with the file it is appended to the first prompt on one line, {S} becoming / or $', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clim-policy-'));
    const policyFile = join(dir, 'session-policy.md');
    writeFileSync(policyFile, 'Rules:\n- use {S}skill\n- be brief\n');

    const off = await startFakeApi([]);
    t.after(off.close);
    const none = await runClim(['policy'], off.url);
    assert.match(none.stdout, /No session policy/);
    await runClim(['open', '/work/proj', '--prompt', 'hello', '--no-submit-check', '--json'], off.url);
    assert.equal(off.requests.find((q) => q.method === 'POST' && q.path === '/v1/sessions').body.prompt, 'hello');

    const on = await startFakeApi([]);
    t.after(on.close);
    const shown = await runClim(['policy', '--command', 'codex'], on.url, { CLIM_POLICY_FILE: policyFile });
    assert.equal(shown.stdout.trim(), 'Rules: - use $skill - be brief');
    await runClim(['open', '/work/proj', '--prompt', 'hello', '--no-submit-check', '--json'], on.url, { CLIM_POLICY_FILE: policyFile });
    assert.equal(on.requests.find((q) => q.method === 'POST' && q.path === '/v1/sessions').body.prompt, 'hello · Rules: - use /skill - be brief');
    await runClim(['open', '/work/proj', '--prompt', 'hello', '--no-policy', '--json'], on.url, { CLIM_POLICY_FILE: policyFile });
    assert.equal(on.requests.filter((q) => q.method === 'POST' && q.path === '/v1/sessions').at(-1).body.prompt, 'hello');
});

// ---------------------------------------------------------------- watch: an idle must be confirmed on N consecutive polls

// `states` is the state seen on each successive GET /v1/sessions (the first call is the initial snapshot); the last one repeats.
function startWatchApi(states, screen = []) {
    const requests = [];
    let n = 0;
    const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        requests.push({ method: req.method, path: url.pathname });
        res.setHeader('content-type', 'application/json');
        const s = (state) => ({ id: 'w1', name: 'job', state, awaitingInput: false });
        if (req.method === 'GET' && url.pathname === '/v1/sessions') return res.end(JSON.stringify([s(states[Math.min(n++, states.length - 1)])]));
        if (req.method === 'GET' && url.pathname === '/v1/sessions/w1/output') return res.end(JSON.stringify({ session: s('idle'), mode: 'screen', lines: screen }));
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: 'not_found', message: url.pathname } }));
    });
    return listen(server).then((api) => ({ ...api, requests }));
}
const polls = (api) => api.requests.filter((q) => q.path === '/v1/sessions').length;
const watchEnv = () => ({ CLIM_WATCH_STATE: join(mkdtempSync(join(tmpdir(), 'clim-watch-')), 'state.json') });

test('watch: a busy/idle flicker does not fire — IDLE needs two idle polls in a row', async (t) => {
    // initial=busy, then idle, busy again (the flicker), then idle twice → fires only on the last poll
    const api = await startWatchApi(['busy', 'idle', 'busy', 'idle', 'idle']);
    t.after(api.close);
    const r = await runClim(['watch', '--interval', '0.05', '--timeout', '20'], api.url, watchEnv());
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'IDLE w1');
    assert.equal(polls(api), 5);
});

test('watch --idle-polls 1 fires on the first idle after busy', async (t) => {
    const api = await startWatchApi(['busy', 'idle', 'idle']);
    t.after(api.close);
    const r = await runClim(['watch', '--interval', '0.05', '--timeout', '20', '--idle-polls', '1'], api.url, watchEnv());
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'IDLE w1');
    assert.equal(polls(api), 2);
});

test('watch: a session that was already idle never fires; it ends with TIMEOUT (7)', async (t) => {
    const api = await startWatchApi(['idle']);
    t.after(api.close);
    const r = await runClim(['watch', '--interval', '0.05', '--timeout', '0.5'], api.url, watchEnv());
    assert.equal(r.status, 7);
    assert.equal(r.stdout.trim(), 'TIMEOUT');
});

test('watch: an agent resting on its own background shell is skipped, not reported as IDLE', async (t) => {
    const api = await startWatchApi(['busy', 'idle', 'idle', 'idle'], ['⏺ waiting', '  1 shell still running']);
    t.after(api.close);
    const r = await runClim(['watch', '--interval', '0.05', '--timeout', '0.6'], api.url, watchEnv());
    assert.equal(r.status, 7);
    assert.equal(r.stdout.trim(), 'TIMEOUT');
});

test('watch: --idle-polls must be a positive whole number (2)', async (t) => {
    const api = await startWatchApi(['idle']);
    t.after(api.close);
    assert.equal((await runClim(['watch', '--idle-polls', '0'], api.url, watchEnv())).status, 2);
});
