import crypto from 'crypto'

const createId = () => crypto.randomBytes(16).toString('hex')

const TaskState = {
  PENDING: 'PENDING',
  READY: 'READY',
  WAITING_FOR_PERMISSION: 'WAITING_FOR_PERMISSION',
  RUNNING: 'RUNNING',
  OBSERVING: 'OBSERVING',
  VERIFYING: 'VERIFYING',
  VERIFIED: 'VERIFIED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
  CANCELLED: 'CANCELLED',
  ROLLED_BACK: 'ROLLED_BACK',
  UNCERTAIN: 'UNCERTAIN',
  TIMED_OUT: 'TIMED_OUT'
}

// Default hard ceiling for a single capability phase (execute/observe/verify)
// when the capability declares no timeout. This is a backstop against a hung
// capability, distinct from the capability's own cooperative timeout.
const DEFAULT_HARD_TIMEOUT_MS = 120000

// Race an async phase against a hard wall-clock deadline. On timeout the
// returned promise rejects with a TimeoutError and the AbortController is
// aborted so a cooperative capability can stop promptly; a non-cooperative
// capability is abandoned (its result is ignored) so the scheduler is never
// blocked by a hung capability.
function runWithHardTimeout(phase, timeoutMs, controller) {
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_HARD_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { controller?.abort() } catch { /* abort is best-effort */ }
      const error = new Error(`Capability phase exceeded hard timeout of ${limit}ms`)
      error.name = 'TimeoutError'
      error.timedOut = true
      reject(error)
    }, limit)
    Promise.resolve()
      .then(() => phase(controller?.signal))
      .then((value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      })
      .catch((error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })
  })
}

class TaskGraphScheduler {
  constructor(options = {}) {
    this.taskGraph = null
    this.taskStates = new Map() // taskId -> state
    this.taskResults = new Map() // taskId -> result
    this.observations = new Map() // taskId -> observation
    this.verifications = new Map() // taskId -> verification
    this.transitions = [] // array of { taskId, oldState, newState, timestamp }
    this.capabilityRegistry = options.capabilityRegistry || null
    this.recoveryEngine = options.recoveryEngine || null
    this.troubleshootingEngine = options.troubleshootingEngine || null
    this.observationEngine = options.observationEngine || null
    this.verificationEngine = options.verificationEngine || null
    this.adapter = options.adapter || null
  }

  // Initialize (or re-initialize during replanning) the scheduler with a task
  // graph. When replanning, pass options.preserveStates: a Map of taskId ->
  // { state, result, observation, verification } for tasks that were already
  // VERIFIED. Those tasks are restored as VERIFIED and are never re-executed,
  // guaranteeing completed (and non-idempotent) work is not repeated.
  initialize(taskGraph, options = {}) {
    this.taskGraph = taskGraph
    this.taskStates.clear()
    this.taskResults.clear()
    this.observations.clear()
    this.verifications.clear()
    this.transitions = []

    const preserveStates = options.preserveStates instanceof Map ? options.preserveStates : null

    for (const task of taskGraph.tasks) {
      const preserved = preserveStates?.get(task.taskId)
      if (preserved && preserved.state === TaskState.VERIFIED) {
        this._setTaskState(task.taskId, TaskState.VERIFIED)
        if (preserved.result !== undefined) this.taskResults.set(task.taskId, preserved.result)
        if (preserved.observation !== undefined) this.observations.set(task.taskId, preserved.observation)
        if (preserved.verification !== undefined) this.verifications.set(task.taskId, preserved.verification)
      } else {
        this._setTaskState(task.taskId, TaskState.PENDING)
      }
    }
  }

  // Snapshot the current per-task state so a replan can preserve completed work.
  captureCompletedStates() {
    const preserved = new Map()
    for (const [taskId, state] of this.taskStates.entries()) {
      if (state === TaskState.VERIFIED) {
        preserved.set(taskId, {
          state,
          result: this.taskResults.get(taskId),
          observation: this.observations.get(taskId),
          verification: this.verifications.get(taskId)
        })
      }
    }
    return preserved
  }

  _setTaskState(taskId, newState) {
    const oldState = this.taskStates.get(taskId)
    this.taskStates.set(taskId, newState)
    this.transitions.push({
      taskId,
      oldState,
      newState,
      timestamp: new Date().toISOString()
    })
  }

  getReadyTasks() {
    if (!this.taskGraph) return []

    const readyTasks = []

    for (const task of this.taskGraph.tasks) {
      const currentState = this.taskStates.get(task.taskId)
      if (currentState !== TaskState.PENDING && currentState !== TaskState.READY) continue

      const allDependenciesVerified = task.dependencies.every(depId => 
        this.taskStates.get(depId) === TaskState.VERIFIED
      )

      const anyDependencyFailed = task.dependencies.some(depId => 
        this.taskStates.get(depId) === TaskState.FAILED
      )

      if (anyDependencyFailed) {
        this._setTaskState(task.taskId, TaskState.SKIPPED)
      } else if (allDependenciesVerified) {
        this._setTaskState(task.taskId, TaskState.READY)
        readyTasks.push(task)
      }
    }

    return readyTasks
  }

  // The set of resources a task contends for. Two tasks may only run
  // concurrently when these sets are disjoint.
  //
  // Capability-declared resources ("desktop", "browser", "clipboard") are the
  // coarse channel. They are not sufficient on their own: two actions on the
  // SAME window both declare "desktop" but would also interleave keystrokes, so
  // the concrete target identity (window, application, file, service) is part of
  // the key too.
  taskResourceKeys(task) {
    const capability = this.capabilityRegistry?.get?.(task.capability)
    const keys = new Set()
    for (const resource of capability?.execution?.resources ?? capability?.resources ?? []) {
      keys.add(`resource:${resource}`)
    }
    const inputs = task.inputs ?? {}
    const identity = [
      ['window', inputs.windowId ?? inputs.target?.windowId],
      ['application', inputs.application ?? inputs.target?.windowIdentity?.processName],
      ['file', inputs.filePath ?? inputs.path],
      ['service', inputs.serviceName],
      ['process', inputs.processName ?? inputs.processId]
    ]
    for (const [kind, value] of identity) {
      if (value != null && value !== '') keys.add(`${kind}:${String(value).toLowerCase()}`)
    }
    // A task whose contention surface is unknown is treated as exclusive rather
    // than assumed independent — unknown fails conservatively.
    if (keys.size === 0) keys.add(`exclusive:${task.taskId}`)
    return keys
  }

  // Greedily pick the largest prefix-stable set of ready tasks whose resource
  // sets are pairwise disjoint. Tasks left out stay ready for the next round, so
  // ordering is preserved for anything that contends.
  selectParallelBatch(readyTasks, { maxConcurrency = 4 } = {}) {
    const batch = []
    const claimed = new Set()
    for (const task of readyTasks) {
      if (batch.length >= Math.max(1, maxConcurrency)) break
      const keys = this.taskResourceKeys(task)
      if ([...keys].some((key) => claimed.has(key))) continue
      for (const key of keys) claimed.add(key)
      batch.push(task)
    }
    return batch
  }

  // Execute a set of ready tasks, running resource-disjoint ones concurrently
  // and anything that contends in order. Returns results keyed by taskId.
  async executeReadyTasks(readyTasks, { maxConcurrency = 4 } = {}) {
    const results = new Map()
    let remaining = [...readyTasks]
    while (remaining.length > 0) {
      const batch = this.selectParallelBatch(remaining, { maxConcurrency })
      const settled = await Promise.all(batch.map(async (task) => [task.taskId, await this.executeTask(task)]))
      for (const [taskId, result] of settled) results.set(taskId, result)
      const executed = new Set(batch.map((task) => task.taskId))
      remaining = remaining.filter((task) => !executed.has(task.taskId))
    }
    return results
  }

  async executeTask(task) {
    const capability = this.capabilityRegistry?.get(task.capability)
    if (!capability) throw new Error(`Unknown capability ${task.capability}`)

    this._setTaskState(task.taskId, TaskState.RUNNING)

    // Recovery budget: the task's own retryBudget bounds attempts, combined
    // with the capability's retry policy (backoff). This is the single place
    // execution-level retry happens.
    const retryPolicy = {
      maxAttempts: Math.max(
        1,
        Number(task.retryBudget ?? capability.retryPolicy?.maxAttempts ?? 1) + 1
      ),
      backoffMs: Number(capability.retryPolicy?.backoffMs ?? 0)
    }

    // Hard execution timeout: a capability that hangs must not block the whole
    // scheduler. Each execution attempt is raced against a wall-clock deadline
    // derived from the capability's declared timeout (performance.timeoutMs /
    // timeout), with a conservative default backstop. On timeout the controller
    // is aborted (cooperative capabilities that accept a signal stop promptly)
    // and the phase is abandoned.
    const hardTimeoutMs = Number(
      capability.performance?.timeoutMs ?? capability.timeout ?? task.timeoutMs ?? DEFAULT_HARD_TIMEOUT_MS
    )
    const controller = new AbortController()

    let executionResult
    let timedOut = false
    try {
      const runOnce = (signal) => capability.execute(task.inputs, { signal })
      if (this.recoveryEngine) {
        const recoveryResult = await this.recoveryEngine.executeWithBudget(
          { action: { retryPolicy } },
          async () => runWithHardTimeout(runOnce, hardTimeoutMs, new AbortController())
        )
        if (!recoveryResult.success) {
          const lastError = recoveryResult.errors?.at(-1)
          const err = lastError?.message ?? 'Execution failed after retries'
          if (lastError?.timedOut || /hard timeout/i.test(err)) timedOut = true
          throw new Error(err)
        }
        executionResult = recoveryResult.output
        this.taskResults.set(task.taskId, executionResult)
      } else {
        executionResult = await runWithHardTimeout(runOnce, hardTimeoutMs, controller)
        this.taskResults.set(task.taskId, executionResult)
      }
    } catch (error) {
      if (error?.timedOut || error?.name === 'TimeoutError' || /hard timeout/i.test(error?.message ?? '')) {
        timedOut = true
      }
      this.taskResults.set(task.taskId, { error: error.message, timedOut })
      // A hung capability is recorded as TIMED_OUT (a distinct terminal state)
      // so the runtime can trigger recovery and the audit trail can distinguish
      // it from a normal failure; getFinalStatus folds it into FAILED.
      this._setTaskState(task.taskId, timedOut ? TaskState.TIMED_OUT : TaskState.FAILED)
      // Surface a structured verification instead of throwing so the runtime's
      // diagnose -> recover -> replan loop can react to it uniformly.
      const verification = {
        status: 'FAILED',
        message: timedOut ? `Execution timed out: ${error.message}` : `Execution error: ${error.message}`,
        evidence: { error: error.message, timedOut },
        category: timedOut ? 'TIMEOUT' : undefined,
        confidence: 1
      }
      this.verifications.set(task.taskId, verification)
      const observation = this._enrichObservation({ error: error.message, timedOut }, task, timedOut ? 'execution-timeout' : 'execution-error')
      this.observations.set(task.taskId, observation)
      return { verification, observation, executionResult: { error: error.message, timedOut } }
    }

    this._setTaskState(task.taskId, TaskState.OBSERVING)

    // Observation is bounded exactly like execution: a hung observe() must not
    // block the scheduler. It runs against a fresh hard-timeout deadline with a
    // cooperative abort signal; on timeout the phase is abandoned and the task
    // fails with a TIMEOUT category so recovery can react.
    let observation
    try {
      const observeController = new AbortController()
      observation = await runWithHardTimeout(
        (signal) => capability.observe(executionResult, task.inputs, { signal }),
        hardTimeoutMs,
        observeController
      )
    } catch (error) {
      const observeTimedOut = error?.timedOut || error?.name === 'TimeoutError' || /hard timeout/i.test(error?.message ?? '')
      const obs = this._enrichObservation({ error: error.message, timedOut: observeTimedOut }, task, observeTimedOut ? 'observe-timeout' : 'observe-error')
      this.observations.set(task.taskId, obs)
      const verification = {
        status: 'FAILED',
        message: observeTimedOut ? `Observation timed out: ${error.message}` : `Observation error: ${error.message}`,
        evidence: { error: error.message, timedOut: observeTimedOut },
        category: observeTimedOut ? 'TIMEOUT' : undefined,
        confidence: 1
      }
      this.verifications.set(task.taskId, verification)
      this._setTaskState(task.taskId, observeTimedOut ? TaskState.TIMED_OUT : TaskState.FAILED)
      return { verification, observation: obs, executionResult }
    }

    observation = this._enrichObservation(observation, task, 'capability')
    this.observations.set(task.taskId, observation)
    this._setTaskState(task.taskId, TaskState.VERIFYING)

    // Verification is bounded too. A hung verify() previously threw only on
    // error, never on hang; now it is raced against the hard deadline. On
    // timeout the task is UNCERTAIN (the outcome could not be confirmed) with a
    // structured verification so the runtime can diagnose/recover uniformly.
    let verification
    try {
      const verifyController = new AbortController()
      verification = await runWithHardTimeout(
        (signal) => capability.verify(observation, task.inputs, { signal }),
        hardTimeoutMs,
        verifyController
      )
    } catch (error) {
      const verifyTimedOut = error?.timedOut || error?.name === 'TimeoutError' || /hard timeout/i.test(error?.message ?? '')
      if (verifyTimedOut) {
        const verification = {
          status: 'INCONCLUSIVE',
          message: `Verification timed out: ${error.message}`,
          evidence: { error: error.message, timedOut: true },
          category: 'TIMEOUT',
          confidence: 0.5
        }
        this.verifications.set(task.taskId, verification)
        this._setTaskState(task.taskId, TaskState.UNCERTAIN)
        return { verification, observation, executionResult }
      }
      this.verifications.set(task.taskId, { error: error.message })
      this._setTaskState(task.taskId, TaskState.UNCERTAIN)
      throw error
    }

    this.verifications.set(task.taskId, verification)

    if (verification.status === 'VERIFIED' || verification.status === 'PARTIALLY_VERIFIED') {
      this._setTaskState(task.taskId, TaskState.VERIFIED)
    } else if (verification.status === 'INCONCLUSIVE') {
      this._setTaskState(task.taskId, TaskState.UNCERTAIN)
    } else {
      this._setTaskState(task.taskId, TaskState.FAILED)
    }

    return { verification, observation, executionResult }
  }

  isComplete() {
    if (!this.taskGraph) return false

    for (const task of this.taskGraph.tasks) {
      const state = this.taskStates.get(task.taskId)
      if ([TaskState.PENDING, TaskState.READY, TaskState.RUNNING, TaskState.OBSERVING, TaskState.VERIFYING, TaskState.WAITING_FOR_PERMISSION].includes(state)) {
        return false
      }
    }
    return true
  }

  getTaskState(taskId) {
    return this.taskStates.get(taskId)
  }

  // Reconciled current verification per task (taskId -> verification), reflecting
  // state AFTER any replan/re-run — a superseded FAILED verification is replaced
  // by the task's latest outcome. This is the authoritative per-task signal for
  // goal verification, distinct from the runtime's accumulating history.
  getReconciledVerifications() {
    return Array.from(this.verifications.entries()).map(([taskId, verification]) => ({
      taskId,
      ...(verification && typeof verification === 'object' ? verification : { value: verification })
    }))
  }

  getFinalStatus() {
    if (!this.isComplete()) return null

    const allVerified = Array.from(this.taskStates.values()).every(
      state => state === TaskState.VERIFIED || state === TaskState.SKIPPED
    )

    const anyFailed = Array.from(this.taskStates.values()).some(
      state => state === TaskState.FAILED || state === TaskState.TIMED_OUT
    )
    const anyUncertain = Array.from(this.taskStates.values()).some(state => state === TaskState.UNCERTAIN)

    if (allVerified) {
      return { status: 'COMPLETED' }
    } else if (anyFailed) {
      return { status: 'FAILED' }
    } else if (anyUncertain) {
      return { status: 'UNCERTAIN' }
    } else {
      return { status: 'PARTIALLY_COMPLETED' }
    }
  }

  getTransitions() {
    return this.transitions
  }

  // Ensure every observation carries the canonical envelope regardless of what
  // the capability returned: timestamp, taskId, capability, source, confidence,
  // structuredState, detectedChanges, affectedEntities, rawEvidence, provenance.
  _enrichObservation(observation, task, provenance) {
    const base = (observation && typeof observation === 'object') ? observation : { structuredState: observation }
    return {
      // Preserve any capability-specific fields (e.g. `type`,
      // `environmentVariable`, `pathEntry`) that SemanticState.ingestObservations
      // keys on, then normalize the canonical fields on top.
      ...base,
      observationId: base.observationId ?? createId(),
      timestamp: base.timestamp ?? new Date().toISOString(),
      taskId: task.taskId,
      capability: task.capability,
      source: base.source ?? task.capability,
      confidence: base.confidence ?? 1,
      structuredState: base.structuredState ?? null,
      detectedChanges: base.detectedChanges ?? task.expectedStateChanges ?? [],
      affectedEntities: base.affectedEntities ?? task.affectedEntities ?? [],
      rawEvidence: base.rawEvidence ?? base.structuredState ?? null,
      trustLevel: base.trustLevel ?? 'SYSTEM_TRUSTED',
      provenance: base.provenance ?? provenance
    }
  }
}

export { TaskGraphScheduler, TaskState, createId }
