import { ChildProcess, fork, SerializationType } from 'child_process';
import { debug as debugfn } from 'debug';
import { deserializeError } from 'serialize-error';

const debug = debugfn('worker-pool:worker');

(debug as any).color = 3;

const DEFAULT_IDLE_TIMEOUT = 10000;
const DEFAULT_STOP_TIMEOUT = 10000;
const DEFAULT_STOP_SIGNAL = 'SIGTERM';
const WORKER_MAIN = `${__dirname}/worker-main`;
const CHILD_PROCESS_READY_TIMEOUT = 1000;
const HOUSEKEEPING_TIMEOUT = 1000;

interface NotReadyErrorOptions {
  pid?: number;
}

export class NotReadyError extends Error {
  constructor(options: NotReadyErrorOptions) {
    super(
      `Timed out waiting for worker process [${options.pid}] to send ready message`
    );
  }
}

export class WorkerError extends Error {
  constructor(err: Error) {
    const deserialized = deserializeError(err);
    super(deserialized.message);
    this.name = deserialized.name;
    this.stack = deserialized.stack;
  }
}

export class UnexpectedExitError extends Error {
  constructor() {
    super(`Child process exited unexpectedly`);
  }
}

interface Request {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface Message {
  id: number;
  err?: Error;
  result?: any;
}

interface WorkerOptions {
  args?: string[];
  cwd?: string;
  env?: any;
  idleTimeout?: number;
  stopTimeout?: number;
  stopSignal?: 'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'SIGKILL';
  stopWhenIdle?: () => boolean;
}

/**
 * Responsible for starting and stopping worker processes and handling requests
 * and replies
 * @private
 */
export default class Worker {
  private _id = getNextWorkerID();
  private _args?: string[];
  private _cwd?: string;
  private _env?: any;
  private _idleTimeout: number;
  private _stopTimeout: number;
  private _stopSignal: 'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'SIGKILL';
  private _stopWhenIdle?: () => boolean;
  private _waiting = 0;
  private _childProcess?: ChildProcess;
  private _creatingChildProcess?: Promise<void>;
  private _destroyingChildProcess?: Promise<void>;
  private _messageListener?: (message: Message) => void;
  private _exitListener?: () => void;
  private _requests = new Map<number, Request>();
  private _createTimestamp?: number;
  private _idleTimestamp?: number;
  private _serialization: SerializationType = 'json';

  get id() {
    return this._id;
  }

  get waiting() {
    return this._waiting;
  }

  get pid() {
    return this._childProcess?.pid ?? null;
  }

  get isStarted() {
    return this.pid != null;
  }

  /**
   * @param {object} options={} - Optional parameters
   * @param {string} options.cwd - The current working directory for worker processes
   * @param {string[]} options.args - Arguments to pass to worker processes
   * @param {Object} options.env - Environmental variables to set for worker processes
   * @param {number} options.idleTimeout=10000 - Milliseconds before an idle worker process will be asked to stop via options.stopSignal
   * @param {number} options.stopTimeout=10000 - Milliseconds before an idle worker process will receive SIGKILL after it has been asked to stop
   * @param {'SIGTERM'|'SIGINT'|'SIGHUP'|'SIGKILL'} options.stopSignal='SIGTERM' - Initial signal to send when stopping worker processes
   * @param {Function} options.stopWhenIdle - The worker will call this function to determine whether to stop an idle worker process
   * @private
   */
  constructor({
    args,
    cwd,
    env,
    idleTimeout = DEFAULT_IDLE_TIMEOUT,
    stopTimeout = DEFAULT_STOP_TIMEOUT,
    stopSignal = DEFAULT_STOP_SIGNAL,
    stopWhenIdle
  }: WorkerOptions = {}) {
    this._args = args;
    this._cwd = cwd;
    this._env = env;
    this._idleTimeout = idleTimeout;
    this._stopTimeout = stopTimeout;
    this._stopSignal = stopSignal;
    this._stopWhenIdle = stopWhenIdle;

    const timer = setInterval(() => {
      this._housekeeping();
    }, HOUSEKEEPING_TIMEOUT);

    timer.unref();
  }

  /**
   * Start the worker process
   * @returns {Promise}
   * @throws {Worker.NotReadyError}
   * @protected
   */
  async start() {
    const destroyingChildProcess = this._destroyingChildProcess;

    if (destroyingChildProcess) {
      await destroyingChildProcess;
      await wait(1);
    }

    let childProcess = this._childProcess;

    // If this worker already has a child process then there's nothing to do
    if (childProcess != null) {
      return;
    }

    const creatingChildProcess = this._creatingChildProcess;

    // If this worker is currently creating a child process, return the promise
    // that will resolve when a child process has been created
    if (creatingChildProcess != null) {
      return creatingChildProcess;
    }

    // No child process and no promise so create the promise and create
    // a child process
    return (this._creatingChildProcess = new Promise((resolve, reject) => {
      this._createChildProcess()
        .then((childProcess) => {
          this._childProcess = childProcess;
          this._idleTimestamp = new Date().getTime();
          this._createTimestamp = new Date().getTime();
          this._creatingChildProcess = undefined;

          resolve();
        })
        .catch(reject);
    }));
  }

  /**
   * Stop the worker process
   * @returns {Promise}
   * @protected
   */
  async stop() {
    const creatingChildProcess = this._creatingChildProcess;

    if (creatingChildProcess) {
      await creatingChildProcess;
      await wait(1);
    }

    const childProcess = this._childProcess;

    // If this worker doesn't have a child process then there's nothing to do
    if (childProcess == null) {
      return;
    }

    this._childProcess = undefined;
    this._idleTimestamp = undefined;
    this._createTimestamp = undefined;

    const destroyingChildProcess = this._destroyingChildProcess;

    // If this worker is currently destroying a child process, return the promise
    // that will resolve when a child process has been destroyed
    if (destroyingChildProcess != null) {
      return destroyingChildProcess;
    }

    return (this._destroyingChildProcess = new Promise((resolve, reject) => {
      this._destroyChildProcess(childProcess)
        .then(() => {
          this._destroyingChildProcess = undefined;

          resolve();
        })
        .catch(reject);
    }));
  }

  /**
   * Send a request to the worker process and wait for and return the result
   * @param {any} message
   * @returns {Promise}
   * @resolves {any} - The result of the function invocation
   * @rejects {Worker.UnexpectedExitError|Error}
   * @protected
   */
  async request(message = {}) {
    await this.start();

    const childProcess = this._childProcess;
    if (childProcess == null) return;

    this._waiting++;
    this._idleTimestamp = undefined;

    const id = getNextRequestID();
    const messageToSend = Object.assign({}, message, { id });
    let result;

    try {
      debug('Sending message to child process [%d]:', childProcess?.pid);
      debug('%j', messageToSend);

      childProcess.send(messageToSend);

      result = await new Promise((resolve, reject) => {
        this._requests.set(id, { resolve, reject });
      });
    } catch (err) {
      throw err;
    } finally {
      this._waiting--;

      if (this._waiting === 0) {
        this._idleTimestamp = new Date().getTime();
      }
    }

    return result;
  }

  private _handleResponse(message: Message) {
    const { id, err, result } = message;

    debug('Received message from child process [%d]:', this._childProcess?.pid);
    debug('%j', message);

    const request = this._requests.get(id);
    if (request == null) return;

    const { resolve, reject } = request;
    this._requests.delete(id);

    if (err != null) {
      reject(new WorkerError(err));
    } else {
      resolve(result);
    }
  }

  private _housekeeping() {
    const idleTimestamp = this._idleTimestamp;
    const idleTimeout = this._idleTimeout;
    const stopWhenIdle = this._stopWhenIdle;

    if (
      idleTimestamp != null &&
      new Date().getTime() > idleTimestamp + idleTimeout &&
      (stopWhenIdle == null || stopWhenIdle())
    ) {
      // TODO: Handle these errors
      this.stop()
        .then(() => {})
        .catch((err) => {});
    }
  }

  private async _createChildProcess(): Promise<ChildProcess> {
    const modulePath = WORKER_MAIN;
    const args = this._args;
    const cwd = this._cwd;
    const env = this._env;

    return new Promise((resolve, reject) => {
      debug('Creating child process from "%s"', modulePath);

      const options = { cwd, env, serialization: this._serialization };

      // Start a child process
      const childProcess = fork(modulePath, args, options);

      const handleMessage = (message: string) => {
        if (message === 'ready') {
          removeStartupListeners();

          this._addListeners(childProcess);

          debug('Created child process [%d]', childProcess.pid);

          // this.emit('createChildProcess', childProcess);

          resolve(childProcess);
        }
      };

      // Wait for a 'ready' message
      childProcess.on('message', handleMessage);

      const handleError = (err: Error) => {
        removeStartupListeners();

        debug('Child process error [%d]', childProcess.pid);
        debug('%j', err);

        reject(err);
      };

      // Handle startup error
      childProcess.once('error', handleError);

      // Time out waiting for 'ready' message
      const timer = setTimeout(() => {
        removeStartupListeners();

        reject(new NotReadyError(childProcess));
      }, CHILD_PROCESS_READY_TIMEOUT);

      timer.unref();

      function removeStartupListeners() {
        childProcess.removeListener('message', handleMessage);
        childProcess.removeListener('error', handleError);
        clearTimeout(timer);
      }
    });
  }

  private async _destroyChildProcess(childProcess: ChildProcess) {
    this._removeListeners(childProcess);

    if (childProcess.exitCode !== null) {
      debug(
        "Won't destroy child process [%d] because it has already exited",
        childProcess.pid
      );
      return;
    }

    return new Promise((resolve, reject) => {
      debug('Destroying child process [%d]', childProcess.pid);

      const handleExit = () => {
        removeShutdownListeners();

        debug('Destroyed child process [%d]', childProcess.pid);

        // this.emit('destroyChildProcess', childProcess);

        resolve(childProcess);
      };

      childProcess.once('exit', handleExit);

      const handleError = (err: Error) => {
        removeShutdownListeners();

        debug('Child process error [%d]', childProcess.pid);
        debug('%j', err);

        reject(err);
      };

      childProcess.once('error', handleError);

      const signal = this._stopSignal;
      let timer: NodeJS.Timeout;

      // Don't bother with the timeout if the first signal is SIGKILL
      if (signal !== 'SIGKILL') {
        // Set up a timer to send SIGKILL to the child process after the timeout
        timer = setTimeout(() => {
          debug(
            'Child process [%d] [%s] timed out; sending SIGKILL',
            childProcess.pid,
            signal
          );
          childProcess.kill('SIGKILL');
        }, this._stopTimeout);

        // Don't let this timer keep the (parent) process alive
        timer.unref();
      }

      // Ask the child process to stop
      childProcess.kill(signal);

      function removeShutdownListeners() {
        childProcess.removeListener('exit', handleExit);
        childProcess.removeListener('error', handleError);
        // If the child process does exit before the timeout, clear the timer
        if (timer != null) {
          clearTimeout(timer);
        }
      }
    });
  }

  private _addListeners(childProcess: ChildProcess) {
    const messageListener = (this._messageListener = (message: Message) =>
      this._handleResponse(message));
    const exitListener = (this._exitListener = () =>
      this._handleUnexpectedExit());

    childProcess.on('message', messageListener);
    childProcess.once('exit', exitListener);
  }

  private _removeListeners(childProcess?: ChildProcess) {
    if (childProcess == null) return;

    const messageListener = this._messageListener;
    const exitListener = this._exitListener;

    if (messageListener) {
      childProcess.removeListener('message', messageListener);
    }
    if (exitListener) {
      childProcess.removeListener('exit', exitListener);
    }

    this._messageListener = undefined;
    this._exitListener = undefined;
  }

  private _handleUnexpectedExit() {
    const childProcess = this._childProcess;

    this._childProcess = undefined;

    this._removeListeners(childProcess);

    const requests = this._requests;

    if (requests.size > 0) {
      debug('Child process [%d] exited unexpectedly', childProcess?.pid);

      for (let [id, { reject }] of requests) {
        requests.delete(id);

        reject(new UnexpectedExitError());
      }
    }

    const stopWhenIdle = this._stopWhenIdle;

    if (stopWhenIdle != null && !stopWhenIdle()) {
      // TODO: Handle these errors
      this.start()
        .then(() => {})
        .catch((err) => {});
    }
  }
}

let workerID = 0;

function getNextWorkerID() {
  return workerID++;
}

let requestID = 0;

function getNextRequestID() {
  return requestID++;
}

async function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
