import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createDshHostAdapter, liftEventMessages, liftMessageSource, readHistoryRecords, readSessionSnapshot, SESSION_FORMAT_VERSION_MAX } from '../lib/dsh-host-adapter.mjs'

const gatewaySource = fs.readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8')
assert.doesNotMatch(gatewaySource, /apiProxy|api\.events\.mux|api\.respond\s*\(/)
assert.doesNotMatch(gatewaySource, /typertGateway\.invoke|typertGateway\.stream/)

const packed = {
  type: 'event',
  event: {
    type: 'assistant/message', seq: 5, time: 107,
    data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '你好' }] },
      stream: [{ type: 'text-chunks', time0: 100, index: 0, texts: ['你', '好'], dt: [7] }] },
  },
}
assert.deepEqual(readHistoryRecords([packed]), [packed.event])
assert.throws(() => readHistoryRecords([{ type: 'chunks', event: packed.event }]), /requires event records/)

const calls = []
const gateway = {
  async invoke(call) {
    calls.push(call)
    if (call.namespace === 'session' && call.method === 'page') {
      return { records: [{ type: 'event', event: { type: 'user/message', seq: 1, time: 1, data: {} } }], hasMore: false }
    }
    if (call.namespace === 'session' && call.method === 'modelCatalog') {
      return {
        default: { provider: 'deepseek', model: 'chat' },
        routableProviders: ['deepseek'],
        groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat' }] }],
        failures: [],
      }
    }
    if (call.namespace === 'session' && call.method === 'list') return { items: [{ sessionId: 's1' }] }
    if (call.namespace === 'session' && call.method === 'canOpenWorkspacePath') return true
    if (call.namespace === 'llm' && call.method === 'listConfigurableProviders') return [{ provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'deepseek', settingsPath: [] }]
    if (call.namespace === 'goals' && call.method === 'edit') return { id: 'goal-1', revision: 2 }
    if (call.namespace === 'goals' && call.method === 'clear') return { id: 'goal-1', revision: 3 }
    if (call.namespace === 'commands' && call.method === 'list') return []
    return { accepted: true }
  },
  async stream(call) {
    calls.push(call)
    if (call.namespace === 'workspace') {
      return (async function* () {
        yield { type: 'baseline', value: { items: [{ workspaceId: 'w1' }], archivedSessionIds: [] } }
      })()
    }
    if (call.namespace === 'session' && call.method === 'follow') {
      return (async function* () {
        yield {
          type: 'snapshot',
          header: { version: 3, id: 's1' },
          cursor: 9,
          records: [packed],
          hasMore: true,
          projections: { asOfSeq: 9, values: { modelSelection: { lastUsed: null, next: { provider: 'deepseek', model: 'chat' } } } },
        }
      })()
    }
    throw new Error(`unexpected stream ${call.namespace}/${call.method}`)
  },
}

const host = createDshHostAdapter(gateway)

await host.sessions.list()
const sessionListCall = calls.find((call) => call.namespace === 'session' && call.method === 'list')
assert.deepEqual(sessionListCall.args, { _request: {} })

const history = await host.sessions.history({ sessionId: 's1' })
assert.equal(history.events.length, 1)
assert.equal(history.events[0].event.seq, 5)
assert.equal(history.historyFormatVersion, 3)
assert.equal(history.cursor, 9)
assert.equal(history.projections.asOfSeq, 9)

const older = await host.sessions.history({ sessionId: 's1', beforeSeq: 5, maxMessages: 20 })
assert.equal(older.events[0].event.type, 'user/message')
assert.equal(calls.filter(call => call.namespace === 'session' && call.method === 'follow').at(-1).args.request.maxMessages, 1)
const pageCall = calls.find((call) => call.namespace === 'session' && call.method === 'page')
assert.deepEqual(pageCall.args, {
  request: {
    address: { kind: 'session', sessionId: 's1' },
    throughSeq: 9,
    beforeSeq: 5,
    maxMessages: 20,
  },
})

await host.sessions.prompt({ sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] })
const promptCall = calls.find((call) => call.namespace === 'session' && call.method === 'prompt')
assert.equal(typeof promptCall.args.request.requestId, 'string')
assert.equal(promptCall.args.request.sessionId, 's1')

assert.deepEqual(await host.sessions.cancel({ sessionId: 's1' }), { accepted: true })
const cancelCall = calls.find((call) => call.namespace === 'session' && call.method === 'cancel')
assert.deepEqual(cancelCall.args, { request: { sessionId: 's1' } })

assert.deepEqual(await host.sessions.updateQueue({
  sessionId: 's1',
  itemId: 'message-1',
  action: { kind: 'edit', content: [{ type: 'text', text: '修改后' }] },
}), { accepted: true })
const updateQueueCall = calls.find((call) => call.namespace === 'session' && call.method === 'updateQueue')
assert.deepEqual(updateQueueCall.args, {
  request: {
    sessionId: 's1',
    itemId: 'message-1',
    action: { kind: 'edit', content: [{ type: 'text', text: '修改后' }] },
  },
})

assert.deepEqual(await host.sessions.rename({ sessionId: 's1', title: '新名称' }), { accepted: true })
const renameCall = calls.find((call) => call.namespace === 'session' && call.method === 'rename')
assert.deepEqual(renameCall.args, { request: { sessionId: 's1', title: '新名称' } })

assert.deepEqual(await host.workspace.archiveSession({ sessionId: 's1' }), { accepted: true })
const archiveCall = calls.find((call) => call.namespace === 'workspace' && call.method === 'archiveSession')
assert.deepEqual(archiveCall.args, { request: { sessionId: 's1' } })

const workspaceStreamAbort = new AbortController()
const workspaceStream = await host.openWorkspaceStream(workspaceStreamAbort.signal)
const workspaceOpening = await workspaceStream[Symbol.asyncIterator]().next()
assert.equal(workspaceOpening.value.type, 'baseline')
assert.ok(calls.some((call) => call.namespace === 'workspace' && call.method === 'follow' && call.signal === workspaceStreamAbort.signal))
workspaceStreamAbort.abort()

await host.settings.update({ ns: 'permission', patch: { defaultPreset: 'ask' } })
const settingsCall = calls.find((call) => call.namespace === 'settings' && call.method === 'update')
assert.deepEqual(settingsCall.args, { ns: 'permission', patch: { defaultPreset: 'ask' } })

assert.deepEqual(
  await host.goals.edit({ sessionId: 's1', ref: { id: 'goal-1', revision: 1 }, objective: '完成重构' }),
  { ref: { id: 'goal-1', revision: 2 } },
)
const goalCall = calls.find((call) => call.namespace === 'goals' && call.method === 'edit')
assert.deepEqual(goalCall.args, {
  agentId: 's1',
  ref: { id: 'goal-1', revision: 1 },
  request: { objective: '完成重构' },
})

assert.deepEqual(await host.workspace.list(), { items: [{ workspaceId: 'w1' }], archivedSessionIds: [] })
assert.deepEqual(await host.llm.providers(), {
  providers: [{ provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'deepseek', settingsPath: [] }],
})

const sessionModels = await host.sessions.models({ sessionId: 's1' })
assert.deepEqual(sessionModels.current, { provider: 'deepseek', model: 'chat' })
assert.equal(sessionModels.routable, true)

await host.commands.execute('s1', '/plan-toggle', [{ type: 'image', mediaType: 'image/png', data: 'AA==' }])
const commandExecuteCall = calls.find((call) => call.namespace === 'commands' && call.method === 'execute')
assert.deepEqual(commandExecuteCall.args, {
  agentId: 's1',
  line: '/plan-toggle',
  submittedAttachments: [{ type: 'image', mediaType: 'image/png', data: 'AA==' }],
})

console.log('DSH HOST ADAPTER TESTS PASSED')

const followAbort = new AbortController()
await host.openSessionStream('s1', followAbort.signal)
assert.deepEqual(calls.at(-1), { namespace: 'session', method: 'follow',
  args: { request: { address: { kind: 'session', sessionId: 's1' }, maxMessages: 12, assistantStream: true } }, signal: followAbort.signal })
followAbort.abort()
const badHost = createDshHostAdapter({ invoke: async () => ({}), stream: async () => (async function* () {
  yield { type: 'snapshot', header: { id: 's1', version: 2 }, cursor: 0, records: [], projections: {} }
})() })
await assert.rejects(() => badHost.sessions.history({ sessionId: 's1' }), { code: 'unsupported-session-format' })

// Reading a snapshot must release its follow even with a caller-owned signal.
{
  const caller = new AbortController()
  let returned = false
  const snapshotHost = createDshHostAdapter({
    invoke: async () => ({}),
    stream: async call => ({
      [Symbol.asyncIterator]() { return this },
      async next() { return { done: false, value: { type: 'snapshot', header: { id: 's1', version: 3 },
        cursor: -1, records: [], projections: { asOfSeq: -1, values: {} } } } },
      async return() {
        assert.equal(call.signal.aborted, true)
        returned = true
        return { done: true }
      },
    }),
  })
  await snapshotHost.sessions.history({ sessionId: 's1' }, caller.signal)
  assert.equal(returned, true)
  assert.equal(caller.signal.aborted, false)
}

// --- Session format 4 ---
//
// DSH 0.1.7 stores format 4. A v3 row keeps the retired `source.kind: "plugin"` wrapper, which the
// v4 decoder refuses outright, and a v3 `tool/result` omits the tool role v4 requires. Both are
// lifted on read; measured against a real Session that carried 3 wrapped sources and 49 role-less
// tool results.

assert.equal(typeof SESSION_FORMAT_VERSION_MAX, 'number')
assert.ok(SESSION_FORMAT_VERSION_MAX >= 4, 'the adapter must read the current Session format')

// A plugin source becomes the producer's own kind, and the retired key is dropped.
assert.deepEqual(
  liftMessageSource({ role: 'system', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } }),
  { role: 'system', source: { kind: 'system-prompt' } },
)
// The same plugin on a non-system role is the runtime context it actually emitted.
assert.deepEqual(
  liftMessageSource({ role: 'user', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' } }),
  { role: 'user', source: { kind: 'runtime-context', form: 'snapshot' } },
)
// A plugin whose name is already the producer kind keeps it.
assert.deepEqual(
  liftMessageSource({ role: 'user', source: { kind: 'plugin', plugin: 'dsh-session-title-llm' } }),
  { role: 'user', source: { kind: 'dsh-session-title-llm' } },
)
// A direct producer kind is returned unchanged, identity included.
const direct = { role: 'assistant', source: { kind: 'model' } }
assert.equal(liftMessageSource(direct), direct)
// An unrecognized plugin still yields a producer-owned kind rather than the refused wrapper.
assert.deepEqual(
  liftMessageSource({ source: { kind: 'plugin', plugin: 'some-other-plugin' } }),
  { source: { kind: 'plugin:some-other-plugin' } },
)

// A released wrapper result becomes the first-class tool message v4 requires: the nested block is
// unpacked, the wrapper's fields are hoisted, and everything else survives under a plugin prefix.
// Measured against a real Session whose 49 wrapper results all converted.
assert.deepEqual(
  liftEventMessages({
    type: 'tool/result',
    data: {
      message: {
        id: 'm1',
        role: 'user',
        source: { kind: 'tool', callId: 'c1' },
        content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }],
      },
    },
  }),
  {
    type: 'tool/result',
    data: {
      message: {
        role: 'tool',
        id: 'm1',
        source: { kind: 'tool', callId: 'c1' },
        toolCallId: 'c1',
        content: [{ type: 'text', text: 'ok' }],
      },
    },
  },
)
// A result already in the v4 shape is returned by identity.
const firstClass = { type: 'tool/result', data: { message: { role: 'tool', id: 'm1', source: { kind: 'tool' }, toolCallId: 'c1', content: [] } } }
assert.equal(liftEventMessages(firstClass), firstClass)
// A wrapper whose block does not match its source call id is left alone rather than mis-hoisted.
const mismatched = { type: 'tool/result', data: { message: { role: 'user', source: { kind: 'tool', callId: 'a' }, content: [{ type: 'tool-result', toolCallId: 'b', content: [] }] } } }
assert.equal(liftEventMessages(mismatched), mismatched)
// isError hoists when present.
const errored = liftEventMessages({
  type: 'tool/result',
  data: { message: { id: 'm2', role: 'user', source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'tool-result', toolCallId: 'c2', content: [], isError: true }] } },
})
assert.equal(errored.data.message.isError, true)
assert.equal(errored.data.message.role, 'tool')

// An event with nothing to lift is returned by identity, so a steady-state read allocates nothing.
const clean = { type: 'assistant/message', data: { message: { role: 'assistant', source: { kind: 'model' } } } }
assert.equal(liftEventMessages(clean), clean)

// An inbox carries a message array; every entry is lifted.
const inbox = liftEventMessages({
  type: 'agent/inbox/spliced',
  data: { inserted: [{ source: { kind: 'plugin', plugin: 'dsh-session-title-llm' } }] },
})
assert.deepEqual(inbox.data.inserted, [{ source: { kind: 'dsh-session-title-llm' } }])

// A snapshot at format 4 is accepted, and its records arrive lifted.
const snapshot4 = readSessionSnapshot({
  type: 'snapshot',
  cursor: 10,
  hasMore: false,
  header: { id: 's1', version: 4 },
  projections: {},
  records: [{ type: 'event', event: { type: 'tool/result', seq: 3, data: { message: { id: 'm3', role: 'user', source: { kind: 'tool', callId: 'c3' }, content: [{ type: 'tool-result', toolCallId: 'c3', content: [] }] } } } }],
}, 's1')
assert.equal(snapshot4.historyFormatVersion, 4)
assert.equal(snapshot4.events[0].event.data.message.role, 'tool')

// A format above the supported ceiling is refused rather than misread.
assert.throws(
  () => readSessionSnapshot({
    type: 'snapshot', cursor: 0, hasMore: false, header: { id: 's1', version: SESSION_FORMAT_VERSION_MAX + 1 },
    projections: {}, records: [],
  }, 's1'),
  /unsupported-session-format|reads Session format/,
)

console.log('SESSION FORMAT 4 TESTS PASSED')
