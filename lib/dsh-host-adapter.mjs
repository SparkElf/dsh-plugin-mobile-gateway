import crypto from 'node:crypto'
import os from 'node:os'

function requireRecord(value, endpoint) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${endpoint} returned an invalid object`)
  }
  return value
}

function requireArray(value, endpoint) {
  if (!Array.isArray(value)) throw new Error(`${endpoint} returned an invalid array`)
  return value
}

export const DSH_VERSION = '0.1.7-rc.2'
/**
 * Oldest Session format this adapter reads.
 *
 * A DSH deployment writes the current format, but a Session persisted earlier keeps its own
 * version: v3 rows carry the retired `source.kind: "plugin"` wrapper and omit the tool role on
 * `tool/result`. Both are lifted on read (see {@link liftMessageSource}), so one adapter serves
 * every generation the harness still stores.
 */
export const SESSION_FORMAT_VERSION = 3
/** Current Session format. Rows above this version are refused rather than misread. */
export const SESSION_FORMAT_VERSION_MAX = 4
/** Producer kinds that replace the retired plugin wrapper, keyed by the plugin it named. */
const LIFTED_PRODUCER_KINDS = Object.freeze({
  '@deepseek-ai/dsh-system-prompt': 'runtime-context',
  'dsh-session-title-llm': 'dsh-session-title-llm',
})

/**
 * Lift one message's retired v3 source into the current producer-owned shape.
 *
 * v4 refuses `source.kind: "plugin"` outright, so a v3 row that still carries it fails decoding
 * with "format v4 message requires a producer-owned source kind". The mapping mirrors the harness's
 * own v3→v4 migration: a system-prompt plugin that produced a system role becomes `system-prompt`,
 * anything else it produced becomes `runtime-context`, and a plugin whose name is already the
 * producer kind keeps it. The `plugin` key is dropped either way.
 *
 * @param message - message whose source may still be the v3 plugin wrapper.
 * @returns the same message, or a copy whose source is producer-owned.
 */
export function liftMessageSource(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return message
  const source = message.source
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return message
  if (source.kind !== 'plugin') return message
  const plugin = source.plugin
  if (typeof plugin !== 'string' || plugin.length === 0) return message
  const lifted = plugin === '@deepseek-ai/dsh-system-prompt' && message.role === 'system'
    ? 'system-prompt'
    : LIFTED_PRODUCER_KINDS[plugin] ?? `plugin:${plugin}`
  const { plugin: _dropped, ...rest } = source
  return { ...message, source: { ...rest, kind: lifted } }
}

/** Fields that belong to the released wrapper block rather than the enclosing message. */
const TOOL_WRAPPER_FIELDS = new Set(['type', 'toolCallId', 'content', 'isError'])
/** Fields of the v4 tool message; every other key is preserved under a `plugin:` prefix. */
const TOOL_MESSAGE_FIELDS = new Set(['id', 'role', 'source', 'content'])

/**
 * Promote one released-v3 wrapper tool result to the first-class v4 tool message.
 *
 * v3 carries a tool result as a `user` message whose single content block is a `tool-result`
 * wrapper; v4 makes the message itself the tool role and hoists the wrapper's `toolCallId`,
 * `content`, and `isError` onto it. Unknown keys survive under a `plugin:` prefix so a
 * third-party extension is not silently dropped. A row already in the v4 shape is returned by
 * identity.
 *
 * @param message - message carried by a `tool/result` event.
 * @returns the first-class tool message, or the input when it is already one.
 */
function liftToolResultMessage(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return message
  if (message.role !== 'user') return message
  const source = message.source
  const sourceCallId = source !== null && typeof source === 'object' && !Array.isArray(source) ? source.callId : undefined
  const content = message.content
  const block = Array.isArray(content) && content.length === 1 ? content[0] : undefined
  if (block === null || typeof block !== 'object' || Array.isArray(block) || block.type !== 'tool-result') return message
  const callId = block.toolCallId
  if (typeof callId !== 'string' || typeof sourceCallId !== 'string' || sourceCallId !== callId) return message
  const hoisted = {
    role: 'tool',
    source,
    toolCallId: callId,
    content: Array.isArray(block.content) ? block.content : [],
    // v4 requires a first-class message with a string id; the wrapper already carries one.
    ...(typeof message.id === 'string' && message.id.length > 0 ? { id: message.id } : {}),
  }
  if (typeof block.isError === 'boolean') hoisted.isError = block.isError
  for (const [key, value] of Object.entries(message)) {
    if (!TOOL_MESSAGE_FIELDS.has(key)) hoisted['plugin:message:' + key] = value
  }
  for (const [key, value] of Object.entries(block)) {
    if (!TOOL_WRAPPER_FIELDS.has(key)) hoisted['plugin:result:' + key] = value
  }
  return hoisted
}

/** Message-bearing slots of one Session event, mirroring the harness's declared traversal. */
function messageSlots(data, type) {
  if (type === 'user/message') return [data]
  if (type === 'developer/message' || type === 'system/message' || type === 'assistant/message' || type === 'tool/result') {
    return data.message === undefined ? [] : [data.message]
  }
  if (type === 'agent/inbox/spliced') return Array.isArray(data.inserted) ? data.inserted : []
  if (type === 'session/title-llm-request') return Array.isArray(data.messages) ? data.messages : []
  return []
}

/**
 * Rewrite every message an event carries into the current source shape.
 *
 * `tool/result` additionally gains the tool role the v4 decoder requires; a v3 row left it to the
 * enclosing event type.
 *
 * @param event - decoded Session event.
 * @returns the event, or a copy whose messages carry producer-owned sources.
 */
export function liftEventMessages(event) {
  const data = event?.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return event
  const slots = messageSlots(data, event.type)
  if (slots.length === 0) return event
  const lifted = slots.map(message => {
    const withSource = liftMessageSource(message)
    // v3 wraps a tool result as a user-role message around one nested `tool-result` block; v4
    // promotes it to a first-class tool message. Only the wrapper is converted, so a row already
    // in the v4 shape passes through untouched.
    if (event.type === 'tool/result') return liftToolResultMessage(withSource)
    return withSource
  })
  if (lifted.every((message, index) => message === slots[index])) return event
  if (event.type === 'user/message') return { ...event, data: lifted[0] }
  if (event.type === 'agent/inbox/spliced') return { ...event, data: { ...data, inserted: lifted } }
  if (event.type === 'session/title-llm-request') return { ...event, data: { ...data, messages: lifted } }
  return { ...event, data: { ...data, message: lifted[0] } }
}

export function readHistoryRecords(records) {
  return requireArray(records, 'session history').map(record => {
    const value = requireRecord(record, 'session history record')
    if (value.type !== 'event') throw new Error('DSH 0.1.5-rc.2 history requires event records')
    const event = requireRecord(value.event, 'session history event')
    if (!Number.isSafeInteger(event.seq) || event.seq < 0) throw new Error('invalid history sequence')
    return liftEventMessages(event)
  })
}

export function readSessionSnapshot(frame, sessionId) {
  requireRecord(frame, 'session/follow')
  if (frame.type !== 'snapshot' || !Number.isSafeInteger(frame.cursor) || frame.cursor < -1
    || frame.header?.id !== sessionId) throw new Error('session/follow returned an invalid snapshot')
  // Accept every format this adapter can read rather than one exact number: the harness stores
  // Sessions written by earlier versions, and each row is lifted to the current shape on read.
  const version = frame.header.version
  if (!Number.isSafeInteger(version) || version < SESSION_FORMAT_VERSION || version > SESSION_FORMAT_VERSION_MAX) {
    throw Object.assign(new Error(`mobile-gateway reads Session format ${SESSION_FORMAT_VERSION}-${SESSION_FORMAT_VERSION_MAX}, got ${version}`), {
      code: 'unsupported-session-format',
    })
  }
  return {
    events: readHistoryRecords(frame.records).map(event => ({ event })),
    hasMore: frame.hasMore === true,
    projections: requireRecord(frame.projections, 'session/follow projections'),
    historyFormatVersion: frame.header.version,
    cursor: frame.cursor,
  }
}

async function firstStreamFrame(gateway, namespace, method, args, signal) {
  const ownedAbort = new AbortController()
  const streamSignal = signal ? AbortSignal.any([signal, ownedAbort.signal]) : ownedAbort.signal
  let iterator
  try {
    const iterable = await gateway.stream({ namespace, method, args, signal: streamSignal })
    const iteratorFactory = iterable?.[Symbol.asyncIterator] ?? iterable?.[Symbol.iterator]
    if (typeof iteratorFactory !== 'function') throw new Error(`${namespace}/${method} returned an invalid stream`)
    iterator = iteratorFactory.call(iterable)
    const first = await iterator.next()
    if (first.done) throw new Error(`${namespace}/${method} ended before its opening frame`)
    return first.value
  } finally {
    ownedAbort.abort()
    if (typeof iterator?.return === 'function') await iterator.return()
  }
}

function requestArgs(request) {
  return { request }
}

// The 0.1.5-rc.2 SessionController names its reserved list argument
// `_request`. Typert descriptors preserve that source parameter name exactly,
// so this endpoint cannot share the normal `{ request }` wrapper.
function sessionListArgs(request) {
  return { _request: request }
}

/**
 * The only module allowed to know DSH Remote endpoint names and argument
 * descriptors. Its public methods intentionally match mobile-gateway domain
 * operations, not the upstream transport envelope.
 */
export function createDshHostAdapter(typertGateway) {
  if (!typertGateway || typeof typertGateway.invoke !== 'function' || typeof typertGateway.stream !== 'function') {
    throw new Error('mobile-gateway requires the DSH Remote Gateway host service')
  }

  const invoke = (namespace, method, args, signal) => typertGateway.invoke({
    namespace,
    method,
    args,
    ...(signal === undefined ? {} : { signal }),
  })

  const sessionSnapshot = async (request, signal) => {
    const frame = requireRecord(await firstStreamFrame(
      typertGateway,
      'session',
      'follow',
      requestArgs(request),
      signal,
    ), 'session/follow')
    return readSessionSnapshot(frame, request.address.sessionId)
  }

  const history = async (payload, signal) => {
    const request = {
      address: { kind: 'session', sessionId: payload.sessionId },
      // Older-page requests need only the opening cursor/projections, not another large latest page.
      ...(payload.beforeSeq !== undefined ? { maxMessages: 1 }
        : payload.maxMessages === undefined ? {} : { maxMessages: payload.maxMessages }),
    }
    const snapshot = await sessionSnapshot(request, signal)
    let events = snapshot.events
    let hasMore = snapshot.hasMore
    if (payload.beforeSeq !== undefined) {
      const page = requireRecord(await invoke('session', 'page', requestArgs({
        address: request.address,
        throughSeq: snapshot.cursor,
        beforeSeq: payload.beforeSeq,
        ...(payload.maxMessages === undefined ? {} : { maxMessages: payload.maxMessages }),
      }), signal), 'session/page')
      events = readHistoryRecords(page.records).map(event => ({ event }))
      hasMore = page.hasMore === true
    }
    return {
      ...snapshot,
      events,
      hasMore,
    }
  }

  const modelCatalog = async (signal) => requireRecord(
    await invoke('session', 'modelCatalog', {}, signal),
    'session/modelCatalog',
  )

  // Control and conversation sockets share this adapter. Admit a prompt only
  // after an earlier preset switch finishes, and re-check later switches.
  const sessionOperations = new Map()
  const admittedPrompts = new Set()
  const serializeSession = (sessionId, operation) => {
    const task = (sessionOperations.get(sessionId) ?? Promise.resolve()).then(operation)
    const guard = task.catch(() => {})
    sessionOperations.set(sessionId, guard)
    return task.finally(() => {
      if (sessionOperations.get(sessionId) === guard) sessionOperations.delete(sessionId)
    })
  }
  const sessionPreset = async (sessionId, signal) => {
    const snapshot = await sessionSnapshot({ address: { kind: 'session', sessionId }, maxMessages: 1 }, signal)
    const values = snapshot.projections.values
    const metadata = values?.sessionListMetadata
    if (typeof values?.agentPreset !== 'string' || !metadata || typeof metadata.blank !== 'boolean'
      || !(metadata.lastPromptAt === null || Number.isFinite(metadata.lastPromptAt))) {
      throw Object.assign(new Error('session preset state is unavailable'), { code: 'agent-preset/unavailable' })
    }
    const durableLock = !metadata.blank || metadata.lastPromptAt !== null
    if (durableLock) admittedPrompts.delete(sessionId)
    return { sessionId, agentPreset: values.agentPreset, locked: durableLock || admittedPrompts.has(sessionId) }
  }

  const commands = {
    list: (sessionId, signal) => invoke('commands', 'list', { agentId: sessionId }, signal),
    // DSH 0.1.5-rc.2 accepts `submittedAttachments`. The parsed
    // wire images already carry the { type: 'image', ... } shape it expects, so
    // only the field name changes.
    execute: (sessionId, line, attachments, signal) => invoke(
      'commands',
      'execute',
      { agentId: sessionId, line, submittedAttachments: attachments },
      signal,
    ),
  }

  const goalRefValue = (value, endpoint) => {
    const goal = requireRecord(value, endpoint)
    if (typeof goal.id !== 'string' || !Number.isSafeInteger(goal.revision)) {
      throw new Error(`${endpoint} returned an invalid goal`)
    }
    return { ref: { id: goal.id, revision: goal.revision } }
  }

  const describeHost = async (signal) => {
    const [sessions, catalog, canOpenPath] = await Promise.all([
      invoke('session', 'list', sessionListArgs({}), signal),
      modelCatalog(signal),
      invoke('session', 'canOpenWorkspacePath', {}, signal).catch(() => false),
    ])
    return {
      version: 'remote-gateway',
      dshVersion: DSH_VERSION,
      historyFormatVersion: SESSION_FORMAT_VERSION,
      cwd: os.homedir(),
      attachedSessions: Array.isArray(sessions?.items) ? sessions.items.length : 0,
      canOpenPath: canOpenPath === true,
      defaultProvider: catalog.default?.provider,
      defaultModel: catalog.default?.model,
    }
  }

  return {
    sessions: {
      list: (payload = {}, signal) => invoke('session', 'list', sessionListArgs(payload), signal),
      search: (payload, signal) => invoke('session', 'search', requestArgs(payload), signal),
      create: (payload, signal) => invoke('session', 'create', requestArgs(payload), signal),
      prompt: (payload, signal) => serializeSession(payload.sessionId, async () => {
        // Accepted input may not have reached turn/start yet. Keep that gap
        // locked; the persistent event or a subsequent read retires the marker.
        const alreadyAdmitted = admittedPrompts.has(payload.sessionId)
        admittedPrompts.add(payload.sessionId)
        try {
          return await invoke('session', 'prompt', requestArgs({ requestId: crypto.randomUUID(), ...payload }), signal)
        } catch (error) {
          if (!alreadyAdmitted) admittedPrompts.delete(payload.sessionId)
          throw error
        }
      }),
      attachment: (payload, signal) => invoke('session', 'attachment', requestArgs(payload), signal),
      fork: (payload, signal) => invoke('session', 'fork', requestArgs(payload), signal),
      cancel: (payload, signal) => invoke('session', 'cancel', requestArgs(payload), signal),
      updateQueue: (payload, signal) => invoke('session', 'updateQueue', requestArgs(payload), signal),
      rename: (payload, signal) => invoke('session', 'rename', requestArgs(payload), signal),
      selectModel: (payload, signal) => invoke('session', 'selectModel', requestArgs(payload), signal),
      history,
      async models(payload, signal) {
        const [catalog, snapshot] = await Promise.all([
          modelCatalog(signal),
          sessionSnapshot({ address: { kind: 'session', sessionId: payload.sessionId }, maxMessages: 1 }, signal),
        ])
        const current = snapshot.projections?.values?.modelSelection?.next ?? catalog.default
        return {
          current,
          routable: typeof current?.provider === 'string'
            && requireArray(catalog.routableProviders, 'session/modelCatalog routableProviders').includes(current.provider),
          groups: requireArray(catalog.groups, 'session/modelCatalog groups'),
          failures: requireArray(catalog.failures, 'session/modelCatalog failures'),
        }
      },
    },
    workspace: {
      async list(_payload = {}, signal) {
        const frame = requireRecord(await firstStreamFrame(typertGateway, 'workspace', 'follow', {}, signal), 'workspace/follow')
        if (frame.type !== 'baseline') throw new Error('workspace/follow returned an invalid opening baseline')
        return requireRecord(frame.value, 'workspace/follow baseline')
      },
      create: (payload, signal) => invoke('workspace', 'create', requestArgs(payload), signal),
      archiveSession: (payload, signal) => invoke('workspace', 'archiveSession', requestArgs(payload), signal),
    },
    settings: {
      describe: (_payload = {}, signal) => invoke('settings', 'describe', {}, signal),
      update: (payload, signal) => invoke('settings', 'update', {
        ns: payload.ns,
        patch: payload.patch,
        ...(payload.expectedRevision === undefined ? {} : { expectedRevision: payload.expectedRevision }),
      }, signal),
    },
    skills: {
      list: (payload, signal) => invoke('skills', 'list', requestArgs(payload), signal),
    },
    agentPresets: {
      list: (_payload = {}, signal) => invoke('agentPresets', 'list', {}, signal),
      session: (payload, signal) => serializeSession(payload.sessionId, () => sessionPreset(payload.sessionId, signal)),
      select: (payload, signal) => serializeSession(payload.sessionId, async () => {
        const state = await sessionPreset(payload.sessionId, signal)
        if (state.locked) {
          throw Object.assign(new Error('session has already started; its agent preset is fixed'), { code: 'agent-preset/locked' })
        }
        // Host validates the live catalog, mounts the composition, checks its
        // own turn boundary and persists agent-preset/selected on this ID.
        const selected = await invoke('agentPresets', 'select', {
          agentId: payload.sessionId, agentPreset: payload.agentPreset,
        }, signal)
        if (typeof selected !== 'string' || !selected) throw new Error('agentPresets/select returned an invalid preset')
        return { sessionId: payload.sessionId, agentPreset: selected }
      }),
    },
    llm: {
      async models(_payload = {}, signal) {
        const catalog = await modelCatalog(signal)
        return { groups: catalog.groups, failures: catalog.failures }
      },
      async providers(_payload = {}, signal) {
        const providers = await invoke('llm', 'listConfigurableProviders', {}, signal)
        return { providers: requireArray(providers, 'llm/listConfigurableProviders') }
      },
    },
    goals: {
      async edit(payload) {
        return goalRefValue(await invoke('goals', 'edit', {
          agentId: payload.sessionId,
          ref: payload.ref,
          request: {
            ...(payload.objective === undefined ? {} : { objective: payload.objective }),
            ...(payload.maxGoalRounds === undefined ? {} : { maxGoalRounds: payload.maxGoalRounds }),
          },
        }), 'goals/edit')
      },
      async pause(payload) {
        return goalRefValue(
          await invoke('goals', 'pause', { agentId: payload.sessionId, ref: payload.ref }),
          'goals/pause',
        )
      },
      async resume(payload) {
        return goalRefValue(
          await invoke('goals', 'resume', { agentId: payload.sessionId, ref: payload.ref }),
          'goals/resume',
        )
      },
      clear: async payload => {
        await invoke('goals', 'clear', { agentId: payload.sessionId, ref: payload.ref })
        return { cleared: true }
      },
    },
    commands,
    host: {
      describe: (_payload = {}, signal) => describeHost(signal),
    },
    describeHost,
    observeSessionEvent(sessionId, event) {
      if (event.type === 'turn/start') admittedPrompts.delete(sessionId)
    },
    openSessionStream(sessionId, signal) {
      return typertGateway.stream({
        namespace: 'session', method: 'follow',
        // Bound the opening window at the Host; older records remain available via session.page.
        args: requestArgs({ address: { kind: 'session', sessionId }, maxMessages: 12, assistantStream: true }),
        signal,
      })
    },
    openControlStream(signal) {
      return typertGateway.stream({ namespace: 'session', method: 'control', args: {}, signal })
    },
    openWorkspaceStream(signal) {
      return typertGateway.stream({ namespace: 'workspace', method: 'follow', args: {}, signal })
    },
  }
}
