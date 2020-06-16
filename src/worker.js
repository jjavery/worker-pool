const child_process = require('child_process');
const debug = require('debug')('worker-pool:worker');
const { deserializeError } = require('serialize-error');

debug.color = 3;

const DEFAULT_IDLE = 10000;
const DEFAULT_TIMEOUT = 10000;
const DEFAULT_SIGNAL = 'SIGTERM';
const WORKER_MAIN = `${__dirname}/worker-main.js`;
const WAIT_FOR_CHILD_PROCESS_READY_MESSAGE_MS = 1000;
const HOUSEKEEPING_MS = 1000;

class NoChildProcessError extends Error {
  constructor() {
    super('No child process');
  }
}

class ChildProcessNotReadyError extends Error {
  constructor({ pid }) {
    super(`Timed out waiting for child process [${pid}] to send ready message`);
  }
}

class UnexpectedExitError extends Error {
  constructor() {
    super(`Child process exited unexpectedly`);
  }
}

/**
 *
 */
class Worker {
  _args;
  _cwd;
  _env;
  _idle;
  _timeout;
  _stopWhenIdle;
  _signal;
  _waiting = 0;
  _childProcess = null;
  _creatingChildProcess = null;
  _destroyingChildProcess = null;
  _messageListener = null;
  _exitListener = null;
  _requests = new Map();
  _createTimestamp = null;
  _idleTimestamp = null;

  get waiting() {
    return this._waiting;
  }

  get pid() {
    return this._childProcess?.pid ?? null;
  }

  get exitCode() {
    return this._childProcess?.exitCode ?? null;
  }

  constructor({
    args,
    cwd,
    env,
    idle = DEFAULT_IDLE,
    timeout = DEFAULT_TIMEOUT,
    stopWhenIdle = null,
    signal = DEFAULT_SIGNAL
  } = {}) {
    this._args = args;
    this._cwd = cwd;
    this._env = env;
    this._idle = idle;
    this._timeout = timeout;
    this._stopWhenIdle = stopWhenIdle;
    this._signal = signal;

    const timer = setInterval(() => {
      this._housekeeping();
    }, HOUSEKEEPING_MS);

    timer.unref();
  }

  /**
   *
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
          this._creatingChildProcess = null;

          resolve();
        })
        .catch(reject);
    }));
  }

  /**
   *
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

    this._childProcess = null;
    this._idleTimestamp = null;
    this._createTimestamp = null;

    const destroyingChildProcess = this._destroyingChildProcess;

    // If this worker is currently destroying a child process, return the promise
    // that will resolve when a child process has been destroyed
    if (destroyingChildProcess != null) {
      return destroyingChildProcess;
    }

    return (this._destroyingChildProcess = new Promise((resolve, reject) => {
      this._destroyChildProcess(childProcess)
        .then(() => {
          this._destroyingChildProcess = null;

          resolve();
        })
        .catch(reject);
    }));
  }

  /**
   * Send a request to the worker process and wait for and return the result
   * @param {*} message
   * @returns {*}
   * @throws {Worker.NoChildProcessError}
   */
  async request(message = {}) {
    await this.start();

    const childProcess = this._childProcess;

    this._waiting++;
    this._idleTimestamp = null;

    const id = getNextRequestID();
    const messageToSend = Object.assign({}, message, { id });
    let result;

    try {
      debug('Sending message to child process [%d]:', childProcess.pid);
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

  _handleResponse(message) {
    const { id, err, result } = message;

    const { resolve, reject } = this._requests.get(id);
    this._requests.delete(id);

    debug('Received message from child process [%d]:', this._childProcess.pid);
    debug('%j', message);

    if (err != null) {
      reject(deserializeError(err));
    } else {
      resolve(result);
    }
  }

  _housekeeping() {
    const idleTimestamp = this._idleTimestamp;
    const idle = this._idle;
    const stopWhenIdle = this._stopWhenIdle;

    if (
      idleTimestamp != null &&
      new Date().getTime() > idleTimestamp + idle &&
      (stopWhenIdle == null || stopWhenIdle())
    ) {
      this.stop()
        .then(() => {})
        .catch((err) => {});
    }
  }

  async _createChildProcess() {
    const modulePath = WORKER_MAIN;
    const args = this._args;
    const cwd = this._cwd;
    const env = this._env;

    return new Promise((resolve, reject) => {
      debug('Creating child process from "%s"', modulePath);

      const options = { cwd, env, serialization: this._serialization };

      // Start a child process
      const childProcess = child_process.fork(modulePath, args, options);

      const handleMessage = (message) => {
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

      const handleError = (err) => {
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

        reject(new ChildProcessNotReadyError(childProcess));
      }, WAIT_FOR_CHILD_PROCESS_READY_MESSAGE_MS);

      timer.unref();

      function removeStartupListeners() {
        childProcess.removeListener('message', handleMessage);
        childProcess.removeListener('error', handleError);
        clearTimeout(timer);
      }
    });
  }

  async _destroyChildProcess(childProcess) {
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

      const handleError = (err) => {
        removeShutdownListeners();

        debug('Child process error [%d]', childProcess.pid);
        debug('%j', err);

        reject(err);
      };

      childProcess.once('error', handleError);

      const signal = this._signal;
      let timer;

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
        }, this._timeout);

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

  _addListeners(childProcess) {
    const messageListener = (this._messageListener = (message) =>
      this._handleResponse(message));
    const exitListener = (this._exitListener = () =>
      this._handleUnexpectedExit());

    childProcess.on('message', messageListener);
    childProcess.once('exit', exitListener);
  }

  _removeListeners(childProcess) {
    const messageListener = this._messageListener;
    const exitListener = this._exitListener;

    if (messageListener) {
      childProcess.removeListener('message', messageListener);
    }
    if (exitListener) {
      childProcess.removeListener('exit', exitListener);
    }

    this._messageListener = null;
    this._exitListener = null;
  }

  _handleUnexpectedExit() {
    const childProcess = this._childProcess;

    this._childProcess = null;

    this._removeListeners(childProcess);

    const requests = this._requests;

    if (requests.size > 0) {
      debug('Child process [%d] exited unexpectedly', childProcess.pid);

      for (let [id, { reject }] of requests) {
        requests.delete(id);

        reject(new UnexpectedExitError());
      }
    }

    const stopWhenIdle = this._stopWhenIdle;

    if (stopWhenIdle != null && !stopWhenIdle()) {
      this.start()
        .then(() => {})
        .catch((err) => {});
    }
  }

  static NoChildProcessError = NoChildProcessError;
  static ChildProcessNotReadyError = ChildProcessNotReadyError;
  static UnexpectedExitError = UnexpectedExitError;
}

let requestID = 0;

function getNextRequestID() {
  return requestID++;
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = Worker;
