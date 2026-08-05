import assert from 'node:assert'
import { describe, it, before } from 'node:test'
import path from 'node:path'
import { TaskGraphScheduler, TaskState, createId } from '../../packages/task-graph-scheduler/src/index.js'
import { CapabilityRegistry, createDefaultCapabilityRegistry } from '../../packages/capability-registry/src/index.js'
import { WindowsAdapter } from '../../os-adapters/windows/src/windows-adapter.js'

describe('TaskGraphScheduler', () => {
  let capabilityRegistry
  let adapter

  before(async () => {
    adapter = new WindowsAdapter()
    capabilityRegistry = createDefaultCapabilityRegistry(adapter)
  })

  it('should initialize with a task graph', async () => {
    const scheduler = new TaskGraphScheduler({ capabilityRegistry, adapter })
    const taskGraph = {
      tasks: [
        { taskId: createId(), capability: 'system.inspect', dependencies: [], inputs: {} }
      ]
    }
    scheduler.initialize(taskGraph)
    assert(scheduler.getReadyTasks().length > 0, 'should have a ready task')
  })

  it('should respect task dependencies', async () => {
    const scheduler = new TaskGraphScheduler({ capabilityRegistry, adapter })
    const task1Id = createId()
    const task2Id = createId()
    const taskGraph = {
      tasks: [
        { taskId: task1Id, capability: 'system.inspect', dependencies: [], inputs: {} },
        { taskId: task2Id, capability: 'processes.list', dependencies: [task1Id], inputs: {} }
      ]
    }
    scheduler.initialize(taskGraph)
    const readyTasks = scheduler.getReadyTasks()
    assert.strictEqual(readyTasks.length, 1)
    assert.strictEqual(readyTasks[0].taskId, task1Id)
  })

  it('enforces a hard timeout on a hung capability instead of blocking forever', async () => {
    // A capability whose execute() never resolves must not hang the scheduler.
    const registry = new CapabilityRegistry([
      {
        name: 'test.hang',
        version: '1.0.0',
        description: 'Never resolves',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        riskMetadata: { level: 'LOW' },
        reversibility: 'NOT_REQUIRED',
        preconditions: () => true,
        // Ignores the abort signal, so only the hard timeout can stop it.
        execute: () => new Promise(() => {}),
        observe: async (result) => ({ structuredState: result }),
        verify: async () => ({ status: 'VERIFIED' }),
        // Small declared timeout drives the hard deadline.
        timeout: 200,
        lifecycleStatus: 'VERIFIED'
      }
    ])
    const scheduler = new TaskGraphScheduler({ capabilityRegistry: registry })
    const taskId = createId()
    scheduler.initialize({ tasks: [{ taskId, capability: 'test.hang', dependencies: [], inputs: {} }] })

    const started = Date.now()
    const { verification, executionResult } = await scheduler.executeTask({ taskId, capability: 'test.hang', dependencies: [], inputs: {} })
    const elapsed = Date.now() - started

    assert.strictEqual(verification.status, 'FAILED')
    assert.strictEqual(executionResult.timedOut, true)
    assert.strictEqual(scheduler.getTaskState(taskId), TaskState.TIMED_OUT)
    assert.ok(elapsed < 5000, `hard timeout should fire promptly (took ${elapsed}ms)`)
    // A hung task folds into a terminal FAILED final status, never left pending.
    assert.strictEqual(scheduler.isComplete(), true)
    assert.strictEqual(scheduler.getFinalStatus().status, 'FAILED')
  })

  it('bounds a hung observe() phase with the hard timeout', async () => {
    const registry = new CapabilityRegistry([
      {
        name: 'test.hang.observe',
        version: '1.0.0',
        description: 'observe never resolves',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        riskMetadata: { level: 'LOW' },
        reversibility: 'NOT_REQUIRED',
        preconditions: () => true,
        execute: async () => ({ ok: true }),
        observe: () => new Promise(() => {}),
        verify: async () => ({ status: 'VERIFIED' }),
        timeout: 200,
        lifecycleStatus: 'VERIFIED'
      }
    ])
    const scheduler = new TaskGraphScheduler({ capabilityRegistry: registry })
    const taskId = createId()
    scheduler.initialize({ tasks: [{ taskId, capability: 'test.hang.observe', dependencies: [], inputs: {} }] })

    const started = Date.now()
    const { verification } = await scheduler.executeTask({ taskId, capability: 'test.hang.observe', dependencies: [], inputs: {} })
    const elapsed = Date.now() - started

    assert.strictEqual(verification.status, 'FAILED')
    assert.strictEqual(verification.category, 'TIMEOUT')
    assert.strictEqual(scheduler.getTaskState(taskId), TaskState.TIMED_OUT)
    assert.ok(elapsed < 5000, `observe hard timeout should fire promptly (took ${elapsed}ms)`)
  })

  it('bounds a hung verify() phase with the hard timeout (UNCERTAIN, not blocked)', async () => {
    const registry = new CapabilityRegistry([
      {
        name: 'test.hang.verify',
        version: '1.0.0',
        description: 'verify never resolves',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        riskMetadata: { level: 'LOW' },
        reversibility: 'NOT_REQUIRED',
        preconditions: () => true,
        execute: async () => ({ ok: true }),
        observe: async (result) => ({ structuredState: result }),
        verify: () => new Promise(() => {}),
        timeout: 200,
        lifecycleStatus: 'VERIFIED'
      }
    ])
    const scheduler = new TaskGraphScheduler({ capabilityRegistry: registry })
    const taskId = createId()
    scheduler.initialize({ tasks: [{ taskId, capability: 'test.hang.verify', dependencies: [], inputs: {} }] })

    const started = Date.now()
    const { verification } = await scheduler.executeTask({ taskId, capability: 'test.hang.verify', dependencies: [], inputs: {} })
    const elapsed = Date.now() - started

    assert.strictEqual(verification.status, 'INCONCLUSIVE')
    assert.strictEqual(verification.category, 'TIMEOUT')
    assert.strictEqual(scheduler.getTaskState(taskId), TaskState.UNCERTAIN)
    assert.ok(elapsed < 5000, `verify hard timeout should fire promptly (took ${elapsed}ms)`)
  })

  it('rejects a capability false-success when execution returns a nonzero exit code', async () => {
    const registry = new CapabilityRegistry([{
      name: 'test.false.success',
      version: '1.0.0',
      description: 'Incorrectly claims verification after a failed command',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      riskMetadata: { level: 'LOW' },
      reversibility: 'NOT_REQUIRED',
      preconditions: () => true,
      execute: async () => ({ exitCode: -1, stderr: 'command failed' }),
      observe: async (result) => ({ structuredState: result }),
      verify: async () => ({ status: 'VERIFIED', message: 'incorrect capability claim' }),
      timeout: 1000,
      lifecycleStatus: 'VERIFIED'
    }])
    const scheduler = new TaskGraphScheduler({ capabilityRegistry: registry })
    const taskId = createId()
    const task = { taskId, capability: 'test.false.success', dependencies: [], inputs: {} }
    scheduler.initialize({ tasks: [task] })

    const { verification } = await scheduler.executeTask(task)

    assert.strictEqual(verification.status, 'FAILED')
    assert.strictEqual(verification.category, 'EXECUTION_FAILED')
    assert.match(verification.message, /nonzero code -1/)
    assert.strictEqual(scheduler.getTaskState(taskId), TaskState.FAILED)
  })
})
