import type { EventEmitter } from 'node:events';

const MAX_WORKER_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_TERMINATE_GRACE_MS = 30_000;

export interface WorkerClientProcess
  extends Pick<EventEmitter, 'on' | 'off' | 'once'> {
  connected: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  send(
    message: Record<string, unknown>,
    callback: (error: Error | null) => void,
  ): boolean;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface WorkerClientOptions {
  timeoutMs: number;
  terminateGraceMs: number;
}

export type WorkerEnvelope = Record<string, unknown> & { type: string };

export interface WorkerClient {
  waitFor(acceptedTypes: string[]): Promise<WorkerEnvelope>;
  send(message: Record<string, unknown>): Promise<void>;
  request(
    message: Record<string, unknown>,
    acceptedTypes: string[],
  ): Promise<WorkerEnvelope>;
  waitForExit(): Promise<void>;
  terminateAndReap(): Promise<void>;
}

interface PendingOperation {
  acceptedTypes: Set<string>;
  acknowledged: boolean;
  response?: WorkerEnvelope;
  responseRequired: boolean;
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve(message: WorkerEnvelope): void;
  reject(error: Error): void;
}

function controlledError(code: string): Error {
  return new Error(code);
}

function assertOptions(options: WorkerClientOptions): void {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > MAX_WORKER_TIMEOUT_MS ||
    !Number.isSafeInteger(options.terminateGraceMs) ||
    options.terminateGraceMs < 1 ||
    options.terminateGraceMs > MAX_TERMINATE_GRACE_MS
  ) {
    throw controlledError('MIGRATION_WORKER_TIMEOUT_INVALID');
  }
}

class ManagedWorkerClient implements WorkerClient {
  private pending?: PendingOperation;
  private closed = false;
  private disconnected = false;
  private exitObserved: boolean;
  private exitCode: number | null;
  private signalCode: NodeJS.Signals | null;
  private readonly exited: Promise<void>;
  private resolveExited!: () => void;
  private termination?: Promise<void>;

  constructor(
    private readonly child: WorkerClientProcess,
    private readonly options: WorkerClientOptions,
  ) {
    assertOptions(options);
    this.exitCode = child.exitCode;
    this.signalCode = child.signalCode;
    this.exitObserved = child.exitCode !== null || child.signalCode !== null;
    this.exited = new Promise<void>((resolveExit) => {
      this.resolveExited = resolveExit;
    });
    if (this.exitObserved) this.resolveExited();

    child.on('message', this.onMessage);
    child.on('error', this.onError);
    child.on('disconnect', this.onDisconnect);
    child.on('exit', this.onExit);
    child.on('close', this.onClose);
  }

  waitFor(acceptedTypes: string[]): Promise<WorkerEnvelope> {
    return this.beginOperation(acceptedTypes, true, true);
  }

  send(message: Record<string, unknown>): Promise<void> {
    const acknowledged = this.beginOperation([], false, false);
    const operation = this.pending;
    if (operation) this.transmit(message, operation);
    return acknowledged.then(() => undefined);
  }

  request(
    message: Record<string, unknown>,
    acceptedTypes: string[],
  ): Promise<WorkerEnvelope> {
    const response = this.beginOperation(acceptedTypes, false, true);
    const operation = this.pending;
    if (!operation) return response;
    this.transmit(message, operation);
    return response;
  }

  private transmit(
    message: Record<string, unknown>,
    operation: PendingOperation,
  ): void {
    if (!this.child.connected) {
      void this.failOperation(
        operation,
        controlledError('MIGRATION_WORKER_DISCONNECTED'),
      );
      return;
    }
    try {
      this.child.send(message, (error) => {
        if (this.pending !== operation || operation.settled) return;
        if (error) {
          void this.failOperation(
            operation,
            controlledError('MIGRATION_WORKER_SEND_FAILED'),
          );
          return;
        }
        operation.acknowledged = true;
        this.completeIfReady(operation);
      });
    } catch {
      void this.failOperation(
        operation,
        controlledError('MIGRATION_WORKER_SEND_FAILED'),
      );
    }
  }

  async waitForExit(): Promise<void> {
    if (this.exitObserved) return this.assertCleanExit();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(controlledError('MIGRATION_WORKER_TIMEOUT')),
            this.options.timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      await this.terminateAndReap();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.assertCleanExit();
  }

  terminateAndReap(): Promise<void> {
    this.closed = true;
    this.termination ??= this.terminateAndReapInternal();
    return this.termination;
  }

  private beginOperation(
    acceptedTypes: string[],
    acknowledged: boolean,
    responseRequired: boolean,
  ): Promise<WorkerEnvelope> {
    if (
      this.closed ||
      this.disconnected ||
      this.exitObserved ||
      this.pending
    ) {
      return Promise.reject(controlledError('MIGRATION_WORKER_CLOSED'));
    }
    if (responseRequired && acceptedTypes.length === 0) {
      return Promise.reject(controlledError('MIGRATION_WORKER_RESULT_INVALID'));
    }
    return new Promise<WorkerEnvelope>((resolve, reject) => {
      const operation: PendingOperation = {
        acceptedTypes: new Set(acceptedTypes),
        acknowledged,
        responseRequired,
        settled: false,
        timer: setTimeout(() => {
          void this.failOperation(
            operation,
            controlledError('MIGRATION_WORKER_TIMEOUT'),
          );
        }, this.options.timeoutMs),
        resolve,
        reject,
      };
      this.pending = operation;
    });
  }

  private readonly onMessage = (message: unknown): void => {
    const operation = this.pending;
    if (
      !operation ||
      operation.settled ||
      typeof message !== 'object' ||
      message === null ||
      !('type' in message) ||
      typeof message.type !== 'string'
    ) {
      return;
    }
    const envelope = message as WorkerEnvelope;
    if (envelope.type === 'error') {
      const errorCode =
        typeof envelope.errorCode === 'string'
          ? envelope.errorCode
          : 'MIGRATION_WORKER_FAILED';
      void this.failOperation(operation, controlledError(errorCode));
      return;
    }
    if (envelope.type === 'progress') {
      this.resetInactivityTimer(operation);
      return;
    }
    if (!operation.acceptedTypes.has(envelope.type)) return;
    operation.response = envelope;
    this.completeIfReady(operation);
  };

  private readonly onError = (): void => {
    const operation = this.pending;
    if (operation && !operation.settled) {
      void this.failOperation(
        operation,
        controlledError('MIGRATION_WORKER_SPAWN_FAILED'),
      );
    } else {
      this.closed = true;
    }
  };

  private readonly onDisconnect = (): void => {
    this.disconnected = true;
    const operation = this.pending;
    if (operation && !operation.settled) {
      void this.failOperation(
        operation,
        controlledError('MIGRATION_WORKER_DISCONNECTED'),
      );
    }
  };

  private readonly onExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    this.recordExit(code, signal);
    const operation = this.pending;
    if (operation && !operation.settled) {
      void this.failOperation(
        operation,
        controlledError('MIGRATION_WORKER_EXITED'),
      );
    }
  };

  private readonly onClose = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    this.recordExit(code, signal);
    const operation = this.pending;
    if (operation && !operation.settled) {
      void this.failOperation(
        operation,
        controlledError('MIGRATION_WORKER_EXITED'),
      );
    }
  };

  private recordExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.exitObserved) return;
    this.exitObserved = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.resolveExited();
  }

  private completeIfReady(operation: PendingOperation): void {
    if (
      this.pending !== operation ||
      operation.settled ||
      !operation.acknowledged ||
      (operation.responseRequired && !operation.response)
    ) {
      return;
    }
    operation.settled = true;
    clearTimeout(operation.timer);
    this.pending = undefined;
    operation.resolve(operation.response ?? { type: 'acknowledged' });
  }

  private resetInactivityTimer(operation: PendingOperation): void {
    if (this.pending !== operation || operation.settled) return;
    clearTimeout(operation.timer);
    operation.timer = setTimeout(() => {
      void this.failOperation(
        operation,
        controlledError('MIGRATION_WORKER_TIMEOUT'),
      );
    }, this.options.timeoutMs);
  }

  private async failOperation(
    operation: PendingOperation,
    error: Error,
  ): Promise<void> {
    if (this.pending !== operation || operation.settled) return;
    operation.settled = true;
    clearTimeout(operation.timer);
    this.pending = undefined;
    this.closed = true;
    let rejection = error;
    try {
      await this.terminateAndReap();
    } catch (reapError) {
      rejection =
        reapError instanceof Error
          ? reapError
          : controlledError('MIGRATION_WORKER_REAP_FAILED');
    }
    operation.reject(rejection);
  }

  private async terminateAndReapInternal(): Promise<void> {
    if (this.exitObserved) return;
    try {
      this.child.kill('SIGTERM');
    } catch {
      // Continue to the bounded reap wait and SIGKILL escalation.
    }
    if (await this.waitForReap(this.options.terminateGraceMs)) return;
    try {
      this.child.kill('SIGKILL');
    } catch {
      // The bounded wait below is the final reap attempt.
    }
    if (!(await this.waitForReap(this.options.terminateGraceMs))) {
      throw controlledError('MIGRATION_WORKER_REAP_FAILED');
    }
  }

  private async waitForReap(timeoutMs: number): Promise<boolean> {
    if (this.exitObserved) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      this.exited.then(() => true),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return completed;
  }

  private assertCleanExit(): void {
    if (this.exitCode !== 0 || this.signalCode !== null) {
      throw controlledError('MIGRATION_WORKER_EXITED');
    }
  }
}

export function createWorkerClient(
  child: WorkerClientProcess,
  options: WorkerClientOptions,
): WorkerClient {
  return new ManagedWorkerClient(child, options);
}

export function spawnWorkerClient(
  spawn: () => WorkerClientProcess,
  options: WorkerClientOptions,
): WorkerClient {
  assertOptions(options);
  let child: WorkerClientProcess;
  try {
    child = spawn();
  } catch {
    throw controlledError('MIGRATION_WORKER_SPAWN_FAILED');
  }
  return createWorkerClient(child, options);
}
