const EventEmitter = require('events');
const path = require('path');
const os = require('os');
const child_process = require('child_process');
const debug = require('debug')('worker-pool');
const genericPool = require('generic-pool');
const Worker = require('./worker');

const debug_exec = debug.extend('exec');

const workerMain = `${__dirname}/worker-main.js`;
const defaultMax = Math.max(1, Math.min(os.cpus().length - 1, 3));

/** */
class WorkerPool extends EventEmitter {
  #timeout;
  #strategy;
  #full;
  #round = 0;

  #genericPool;

  #workers = [];

  constructor({
    cwd,
    args,
    env,
    min = 0,
    max = defaultMax,
    idle = 1000,
    timeout = 30000,
    strategy = 'fewest',
    full = 10
  } = {}) {
    super();

    if (min > max) {
      max = min;
    }

    this.#timeout = timeout;
    this.#strategy = strategy;
    this.#full = full;

    const factory = {
      create: () => {
        return this._createChildProcess(workerMain, args, cwd, env);
      },
      destroy: (childProcess) => {
        this._destroyChildProcess(childProcess);
      }
    };

    const options = {
      min,
      max,
      softIdleTimeoutMillis: idle,
      evictionRunIntervalMillis: 1000
    };

    this.#genericPool = genericPool.createPool(factory, options);

    for (let i = 0; i < max; ++i) {
      const worker = new Worker(this);

      this.#workers.push(worker);
    }

    debug('Worker pool started');

    this.emit('start');
  }

  stop() {
    debug('Stopping worker pool');

    this.#genericPool
      .drain()
      .then(() => this.#genericPool.clear())
      .catch((err) => {
        this.emit('error', err);
      })
      .finally(() => {
        debug('Worker pool stopped');

        this.emit('stop');
      });
  }

  async exec(modulePath, functionName, ...args) {
    const resolvedModulePath = this._resolve(modulePath);

    return this._exec(resolvedModulePath, functionName, args);
  }

  proxy(modulePath, functionName) {
    const resolvedModulePath = this._resolve(modulePath);

    return async (...args) => {
      return this._exec(resolvedModulePath, functionName, args);
    };
  }

  async _exec(resolvedModulePath, functionName, args) {
    debug_exec(
      'Executing module "%s" function "%s" with args %j',
      resolvedModulePath,
      functionName,
      args
    );

    const worker = this._getWorker();

    await worker.acquire();

    const reply = await worker.request({
      modulePath: resolvedModulePath,
      functionName,
      args
    });

    worker.release();

    return reply;
  }

  _resolve(modulePath) {
    if (path.parse(modulePath).dir !== '') {
      const dirname = path.dirname(module.parent.filename);
      modulePath = path.resolve(dirname, modulePath);
    }
    return modulePath;
  }

  _getWorker() {
    switch (this.#strategy) {
      case 'fewest':
        return this._fewestStrategy();
      case 'fill':
        return this._fillStrategy();
      case 'round-robin':
        return this._roundRobinStrategy();
      case 'random':
        return this._randomStrategy();
      default:
        throw new Error(`Unknown strategy "${this.#strategy}"`);
    }
  }

  _createChildProcess(modulePath, args, cwd, env) {
    debug('Creating child process from "%s"', modulePath);

    const childProcess = child_process.fork(modulePath, args, { cwd, env });

    debug('Created child process [%d]', childProcess.pid);

    this.emit('createChildProcess', childProcess);

    return childProcess;
  }

  _destroyChildProcess(childProcess) {
    debug('Destroying child process [%d]', childProcess.pid);

    // Set up a timer to send SIGKILL to the child process after the timeout
    const timer = setTimeout(() => childProcess.kill('SIGKILL'), this.#timeout);

    // Don't let this timer keep the (parent) process alive
    timer.unref();

    // If the child process does exit before the timeout, clear the timer
    childProcess.once('exit', () => clearTimeout(timer));

    // Kindly ask the child process to stop
    childProcess.kill('SIGTERM');

    debug('Destroyed child process [%d]', childProcess.pid);

    this.emit('destroyChildProcess', childProcess);
  }

  async _acquireChildProcess() {
    return this.#genericPool.acquire();
  }

  async _releaseChildProcess(childProcess) {
    return this.#genericPool.release(childProcess);
  }

  /**
   * Return the worker with the fewest number of queued requests
   * @private
   */
  _fewestStrategy() {
    const workers = this.#workers;

    // Use the queue with the shortest queue
    let worker = workers[0];

    for (let i = 1, len = workers.length; i < len; ++i) {
      const candidate = workers[i];

      if (candidate.queued < worker.queued) {
        worker = candidate;
      }
    }

    return worker;
  }

  /**
   * Return the first worker that is not full, or if they are all full, the
   * worker with the fewest number of queued requests. This does not prevent
   * workers from overfilling, it will fill each worker before moving on to
   * the next, and will fall back to the "fewest" strategy when all workers
   * are full.
   * @private
   */
  _fillStrategy() {
    let worker = null;
    const workers = this.#workers;
    const full = this.#full;

    // Use the queue with the most tasks, but don't overfill
    worker = workers[0];
    const fewest = worker;

    for (let i = 1, len = workers.length; i < len; ++i) {
      const candidate = workers[i];
      const candidateQueued = candidate.queued;

      if (candidateQueued >= worker.queued && candidateQueued < full) {
        worker = workers[i];
      }
      if (candidateQueued < fewest.queued) {
        fewest = candidate;
      }
    }

    if (worker.queued >= full) {
      worker = fewest;
    }

    return worker;
  }

  /**
   * Return the next worker in the sequence
   * @private
   */
  _roundRobinStrategy() {
    const workers = this.#workers;

    // Rotate through queues
    let round = this.#round++;
    if (round >= workers.length) {
      round = this.#round = 0;
    }

    return workers[round];
  }

  /**
   * Return a random worker
   * @private
   */
  _randomStrategy() {
    const workers = this.#workers;

    const random = Math.floor(Math.random() * workers.length);

    return workers[random];
  }
}

module.exports = WorkerPool;
