// Group folders — a session that has opened several live sessions can gather them into a "Group: <name>" session folder.
// Automatic grouping on `open` is opt-in (CLIM_AUTO_GROUP=1); `clim group` and `open --group <name>` are explicit.
// Runs the real clim.mjs against a fake Control API on 127.0.0.1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIM = join(dirname(fileURLToPath(import.meta.url)), 'clim.mjs')

const PARENT = 'parent-0000'
const child = (n, extra = {}) => ({ id: `child-${n}`, name: `chat ${n}`, state: 'idle', openedBy: null, sessionFolder: null, ...extra })

function startApi({ children = [] } = {}) {
    const requests = []
    const folders = new Set()
    const sessions = [{ id: PARENT, name: 'Lead', state: 'idle', sessionFolder: null }, ...children]
    const server = createServer((req, res) => {
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', () => {
            const url = new URL(req.url, 'http://127.0.0.1')
            requests.push({ method: req.method, path: url.pathname, body: raw ? JSON.parse(raw) : null })
            res.setHeader('content-type', 'application/json')
            if (req.method === 'GET' && url.pathname === '/v1/sessions') return res.end(JSON.stringify(sessions))
            if (req.method === 'GET' && url.pathname === `/v1/sessions/${PARENT}/relations`) {
                // The "opened" Related pairs — counted here even when openedBy is empty (after an app restart)
                return res.end(JSON.stringify({ sessionId: PARENT, relations: children.map((c) => ({ sessionId: c.id, kind: 'opened', direction: 'outgoing' })) }))
            }
            if (req.method === 'POST' && url.pathname === '/v1/session-folders') {
                folders.add(JSON.parse(raw).name)
                return res.end(JSON.stringify({ created: true, folder: { id: 'f', name: JSON.parse(raw).name } }))
            }
            if (req.method === 'POST' && /^\/v1\/sessions\/[^/]+\/session-folder$/.test(url.pathname)) {
                // Like the real app, a folder that does not exist cannot be put into (folder_not_found)
                if (!folders.has(JSON.parse(raw).folder)) { res.statusCode = 404; return res.end(JSON.stringify({ error: { code: 'folder_not_found', message: 'x' } })) }
                return res.end(JSON.stringify({ sessionFolder: { id: 'f', name: JSON.parse(raw).folder } }))
            }
            if (req.method === 'POST' && url.pathname === '/v1/sessions') {
                return res.end(JSON.stringify({ session: { id: 'new-session', name: 'n', workspaceName: 'w', cwd: '/x', command: 'bash', state: 'idle', awaitingInput: false }, promptSent: false }))
            }
            res.statusCode = 404
            res.end(JSON.stringify({ error: { code: 'not_found', message: url.pathname } }))
        })
    })
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ requests, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })))
}

function run(args, apiUrl, env = {}) {
    const full = { ...process.env, CLIM_URL: apiUrl, CLIM_TOKEN: 't', CLIMANAGER_SESSION_ID: PARENT }
    delete full.CLIM_GROUP_AT
    delete full.CLIM_AUTO_GROUP
    Object.assign(full, env)
    return new Promise((resolve) => execFile(process.execPath, [CLIM, ...args], { env: full, encoding: 'utf8' }, (e, stdout, stderr) => resolve({ status: e ? e.code : 0, stdout, stderr })))
}

const posted = (api) => api.requests.find((q) => q.method === 'POST' && q.path === '/v1/sessions')?.body
const moves = (api) => api.requests.filter((q) => q.method === 'POST' && q.path.endsWith('/session-folder')).map((q) => [q.path.split('/')[3], q.body.folder])
const OPEN = ['open', '/w', '--command', 'bash', '--json']

test('automatic grouping is OFF by default — a fifth open does not group anything', async (t) => {
    const api = await startApi({ children: [1, 2, 3, 4].map((n) => child(n)) })
    t.after(api.close)
    const r = await run(OPEN, api.url)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(posted(api).sessionFolder, undefined)
    assert.deepEqual(moves(api), [])
    assert.equal(api.requests.some((q) => q.path === '/v1/session-folders'), false)
})

test('CLIM_AUTO_GROUP=1: the fifth open gathers the new session and the four earlier ones into "Group: <opener>" (counted via Related when openedBy is empty)', async (t) => {
    const api = await startApi({ children: [1, 2, 3, 4].map((n) => child(n)) })
    t.after(api.close)
    const r = await run(OPEN, api.url, { CLIM_AUTO_GROUP: '1' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(posted(api).sessionFolder, 'Group: Lead')
    assert.deepEqual(moves(api), [1, 2, 3, 4].map((n) => [`child-${n}`, 'Group: Lead']))
    assert.match(r.stderr, /opened 5 sessions.*"Group: Lead"/)
})

test('CLIM_AUTO_GROUP=1: fewer than five do not group, and exited sessions are not counted', async (t) => {
    const api = await startApi({ children: [child(1), child(2), child(3), child(4, { state: 'exited' })] })
    t.after(api.close)
    const r = await run(OPEN, api.url, { CLIM_AUTO_GROUP: '1' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(posted(api).sessionFolder, undefined)
    assert.deepEqual(moves(api), [])
})

test('CLIM_AUTO_GROUP=1: a session already in another folder is not moved — one folder per session', async (t) => {
    const api = await startApi({ children: [child(1), child(2, { sessionFolder: { id: 'c', name: 'Release' } }), child(3), child(4)] })
    t.after(api.close)
    const r = await run(OPEN, api.url, { CLIM_AUTO_GROUP: '1' })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(moves(api).map(([id]) => id), ['child-1', 'child-3', 'child-4'])
})

test('CLIM_GROUP_AT changes the threshold', async (t) => {
    const api = await startApi({ children: [child(1), child(2)] })
    t.after(api.close)
    const r = await run(OPEN, api.url, { CLIM_AUTO_GROUP: '1', CLIM_GROUP_AT: '3' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(posted(api).sessionFolder, 'Group: Lead')
    assert.equal(moves(api).length, 2)
})

test('--no-group and --session-folder win; outside an app terminal (no session id) nothing is grouped', async (t) => {
    const api = await startApi({ children: [1, 2, 3, 4].map((n) => child(n)) })
    t.after(api.close)
    const env = { CLIM_AUTO_GROUP: '1' }
    for (const extra of [['--no-group'], ['--session-folder', 'Elsewhere']]) {
        const r = await run([...OPEN, ...extra], api.url, env)
        assert.equal(r.status, 0, r.stderr)
    }
    const outside = await run(OPEN, api.url, { ...env, CLIMANAGER_SESSION_ID: '' })
    assert.equal(outside.status, 0, outside.stderr)
    assert.deepEqual(moves(api), [])
    const folders = api.requests.filter((q) => q.method === 'POST' && q.path === '/v1/sessions').map((q) => q.body.sessionFolder)
    assert.deepEqual(folders, [undefined, 'Elsewhere', undefined])
})

test('--group <name> forces grouping for this open even below the threshold and without CLIM_AUTO_GROUP', async (t) => {
    const api = await startApi({ children: [child(1), child(2)] })
    t.after(api.close)
    const r = await run([...OPEN, '--group', 'review batch'], api.url)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(posted(api).sessionFolder, 'review batch')
    assert.deepEqual(moves(api), [[ 'child-1', 'review batch' ], [ 'child-2', 'review batch' ]])
})

test('--group <name> outside an app terminal only names the new session\'s folder', async (t) => {
    const api = await startApi({ children: [child(1)] })
    t.after(api.close)
    const r = await run([...OPEN, '--group', 'solo'], api.url, { CLIMANAGER_SESSION_ID: '' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(posted(api).sessionFolder, 'solo')
    assert.deepEqual(moves(api), [])
})

test('clim group: gathers the sessions opened so far; below the threshold only with --force', async (t) => {
    const api = await startApi({ children: [1, 2, 3].map((n) => child(n)) })
    t.after(api.close)
    const refused = await run(['group'], api.url)
    assert.equal(refused.status, 2)
    assert.deepEqual(moves(api), [])
    const forced = await run(['group', '--force', '--name', 'my batch'], api.url)
    assert.equal(forced.status, 0, forced.stderr)
    assert.deepEqual(moves(api), [1, 2, 3].map((n) => [`child-${n}`, 'my batch']))
})
