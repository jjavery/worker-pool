const EventEmitter = require('events');
const path = require('path');
const os = require('os');
const debug = require('debug')('worker-pool');
const Worker = require('./worker');

const debug_call = debug.extend('call');

const DEFAULT_MAX = Math.max(1, Math.min(os.cpus().length - 1, 3));
const DEFAULT_IDLE = 10000;
const DEFAULT_TIMEOUT = 10000;
const DEFAULT_SIGNAL = 'SIGTERM';
const DEFAULT_STRATEGY = 'fewest';
const DEFAULT_FULL = 10;

class NoWorkersError extends Error {
  constructor() {
    super('There are no workers available in this work pool');
  }
}

/**
 * Provides a pool of worker processes and the ability to instruct those
 * processes to require modules and call their exported functions.
 * @extends EventEmitter
 */
class WorkerPool extends EventEmitter {
  _cwd;
  _args;
  _env;
  _min;
  _max;
  _idle;
  _timeout;
  _signal;
  _strategy;
  _full;
  _serialization = 'json';

  _workers = [];
  _stopping = [];

  _round = 0;

  get cwd() {
    return this._cwd;
  }
  set cwd(value) {
    this._cwd = value;
  }

  get args() {
    return this._args;
  }
  set args(value) {
    this._args = value;
  }

  get env() {
    return this._env;
  }
  set env(value) {
    this._env = value;
  }

  /**
   * @param {Object} options={} - Optional parameters
   * @param {number} options.cwd - The current working directory for worker processes
   * @param {number} options.args - Arguments to pass to worker processes
   * @param {number} options.env - Environmental variables to set for worker processes
   * @param {number} options.min=0 - The minimum number of worker processes in the pool
   * @param {number} options.max=3 - The maximum number of worker processes in the pool
   * @param {number} options.idle=10000 - Milliseconds before an idle process will be removed from the pool
   * @param {number} options.timeout=10000 - Milliseconds before a worker process will receive SIGKILL after receiving the initial signal, if it has not already exited
   * @param {'SIGTERM'|'SIGINT'|'SIGHUP'|'SIGKILL'} options.signal='SIGTERM' - Initial signal to send when destroying worker processes
   * @param {'fewest'|'fill'|'round-robin'|'random'} options.strategy='fewest' - The strategy to use when routing requests to worker processes
   * @param {number} options.full=10 - The number of requests per worker process used by the 'fill' strategy
   */
  constructor({
    cwd,
    args,
    env,
    min = 0,
    max = DEFAULT_MAX,
    idle = DEFAULT_IDLE,
    timeout = DEFAULT_TIMEOUT,
    signal = DEFAULT_SIGNAL,
    strategy = DEFAULT_STRATEGY,
    full = DEFAULT_FULL
  } = {}) {
    super();

    if (min > max) {
      max = min;
    }

    this._cwd = cwd;
    this._args = args;
    this._env = env;
    this._min = min;
    this._max = max;
    this._idle = idle;
    this._timeout = timeout;
    this._signal = signal;
    this._strategy = strategy;
    this._full = full;

    this._createWorkers();

    debug('Worker pool started');

    this.emit('start');
  }

  _createWorkers() {
    const workers = (this._workers = []);
    const min = this._min;

    for (let i = 0, max = this._max; i < max; ++i) {
      const worker = new Worker({
        args: this._args,
        cwd: this._cwd,
        env: this._env,
        timeout: this._timeout,
        stopWhenIdle: () => this._stopWhenIdle(),
        signal: this._signal
      });

      if (i < min) {
        worker
          .start()
          .then(() => {})
          .catch(() => {});
      }

      workers.push(worker);
    }
  }

  info() {
    const result = {
      workers: [],
      processes: []
    };

    addToResult(this._stopping);
    addToResult(this._workers);

    function addToResult(workers) {
      for ({ waiting, _childProcess } of workers) {
        result.workers.push({
          waiting,
          pid: _childProcess?.pid ?? null,
          exitCode: _childProcess?.exitCode ?? null
        });
      }
    }

    return result;
  }

  /**
   * Stops the worker pool, gracefully shutting down each worker process
   */
  stop() {
    debug('Stopping worker pool');

    const workers = this._workers;
    this._workers = [];

    this._stop(workers)
      .then(() => {
        debug('Worker pool stopped');

        this.emit('stop');
      })
      .catch((err) => {
        console.log(err);
      });
  }

  /**
   * Recycle the worker pool, gracefully shutting down existing worker processes
   * and starting up new worker processes
   */
  recycle() {
    debug('Recycling worker pool');

    const workers = this._workers;

    // Create a new set of workers
    this._createWorkers();

    // Stop the old workers
    this._stop(workers)
      .then(() => {
        debug('Worker pool recycled');

        this.emit('recycle');
      })
      .catch((err) => {
        console.log(err);
      });
  }

  async _stop(workers) {
    const stopping = this._stopping;
    stopping.push(...workers);

    const stopAllWorkers = workers.map((worker) => worker.stop());

    await Promise.all(stopAllWorkers).then(() => {
      for (var worker of workers) {
        stopping.splice(stopping.indexOf(worker), 1);
      }
    });
  }

  /**
   * Sends a request to a worker process in the pool asking it to require a module and call a function with the provided arguments
   * @param {string} modulePath - The module path for the worker process to require()
   * @param {string} functionName - The name of a function expored by the required module
   * @param {...any} args - Arguments to pass when invoking function
   * @returns {Promise} The result of the function invocation
   */
  async call(modulePath, functionName, ...args) {
    const resolvedModulePath = this._resolve(modulePath);

    return this._call(resolvedModulePath, functionName, args);
  }

  /**
   * Creates a proxy function that will call WorkerPool#call() with the provided module path and function name
   * @param {string} modulePath - The module path for the worker process to require()
   * @param {string} functionName - The name of a function expored by the required module
   * @returns {Function} A function that returns a Promise and calls the worker process function with the provided args
   */
  proxy(modulePath, functionName) {
    const resolvedModulePath = this._resolve(modulePath);

    return async (...args) => {
      return this._call(resolvedModulePath, functionName, args);
    };
  }

  async _call(resolvedModulePath, functionName, args) {
    debug_call(
      'Calling module "%s" function "%s" with args %j',
      resolvedModulePath,
      functionName,
      args
    );

    const worker = this._getWorker();

    const result = await worker.request({
      modulePath: resolvedModulePath,
      functionName,
      args
    });

    return result;
  }

  _resolve(modulePath) {
    if (/^(\/|.\/|..\/)/.test(modulePath)) {
      const dirname = path.dirname(module.parent.filename);
      modulePath = path.resolve(dirname, modulePath);
    }
    return modulePath;
  }

  _getWorker() {
    if (this._workers.length === 0) {
      throw new NoWorkersError();
    }

    switch (this._strategy) {
      case 'fewest':
        return this._fewestStrategy();
      case 'fill':
        return this._fillStrategy();
      case 'round-robin':
        return this._roundRobinStrategy();
      case 'random':
        return this._randomStrategy();
      default:
        throw new Error(`Unknown strategy "${this._strategy}"`);
    }
  }

  /**
   * Return the worker with the fewest number of queued requests
   * @private
   */
  _fewestStrategy() {
    const workers = this._workers;

    let worker = workers[0];

    for (let i = 1, len = workers.length; i < len; ++i) {
      const candidate = workers[i];

      if (candidate.waiting < worker.waiting) {
        worker = candidate;
      }
    }

    return worker;
  }

  /**
   * Return the first worker that is not full, or if they are all full, the
   * worker with the fewest number of queued requests. This does not prevent
   * workers from overfilling. It will fill each worker before moving on to
   * the next, and will fall back to the "fewest" strategy when all workers
   * are full.
   * @private
   */
  _fillStrategy() {
    const workers = this._workers;
    const full = this._full;

    let worker = workers[0];
    let fewest = worker;

    for (let i = 1, len = workers.length; i < len; ++i) {
      const candidate = workers[i];
      const candidateWaiting = candidate.waiting;

      if (candidateWaiting >= worker.waiting && candidateWaiting < full) {
        worker = workers[i];
      }
      if (candidateWaiting < fewest.waiting) {
        fewest = candidate;
      }
    }

    if (worker.waiting >= full) {
      worker = fewest;
    }

    return worker;
  }

  /**
   * Return the next worker in the sequence
   * @private
   */
  _roundRobinStrategy() {
    const workers = this._workers;

    let round = this._round++;
    if (round >= workers.length) {
      round = this._round = 0;
    }

    return workers[round];
  }

  /**
   * Return a random worker
   * @private
   */
  _randomStrategy() {
    const workers = this._workers;

    const random = Math.floor(Math.random() * workers.length);

    return workers[random];
  }

  _stopWhenIdle() {
    const min = this._min;

    if (min === 0) {
      return true;
    }

    const count = this._workers.reduce(
      (count, worker) => (worker.pid != null ? count++ : count),
      0
    );

    return count > min;
  }

  static NoWorkersError = NoWorkersError;
}

module.exports = WorkerPool;
