const EventEmitter = require('events');
const path = require('path');
const os = require('os');
const debug = require('debug')('worker-pool');
const Worker = require('./worker');

const debug_call = debug.extend('call');

const DEFAULT_MAX = Math.max(1, Math.min(os.cpus().length - 1, 3));
const DEFAULT_IDLE_TIMEOUT = 10000;
const DEFAULT_STOP_TIMEOUT = 10000;
const DEFAULT_STOP_SIGNAL = 'SIGTERM';
const DEFAULT_STRATEGY = 'fewest';
const DEFAULT_FULL = 10;

class NotStartedError extends Error {
  constructor() {
    super('This worker pool has not been started');
  }
}

/**
 * Provides a load-balancing and (optionally) auto-scaling pool of worker
 * processes and the ability to request for worker processes to import modules,
 * call their exported functions, and reply with their return values and thrown
 * exceptions. Load balancing and auto-scaling are configurable via min/max
 * limits, strategies, and timeouts.
 * @extends EventEmitter
 */
class WorkerPool extends EventEmitter {
  /**
   * Emitted when an error is thrown in the constructor.
   * @event WorkerPool#error
   * @type {Error} - The error object that was thrown.
   */

  /**
   * Emitted when the worker pool starts.
   * @event WorkerPool#start
   */

  /**
   * Emitted when the worker pool recycles.
   * @event WorkerPool#recycle
   */

  /**
   * Emitted when the worker pool stops.
   * @event WorkerPool#stop
   */

  _cwd;
  _args;
  _env;
  _min;
  _max;
  _idleTimeout;
  _stopTimeout;
  _stopSignal;
  _strategy;
  _full;
  _serialization = 'json';

  _workers = [];
  _stopping = [];

  _round = 0;

  /**
   * The current working directory for worker processes. Takes effect after start/recycle.
   *
   * @example
   *
   * workerPool.cwd = `${versionPath}/workers`;
   *
   * await workerPool.recycle();
   *
   * @type {string}
   */
  get cwd() {
    return this._cwd;
  }
  set cwd(value) {
    this._cwd = value;
  }

  /**
   * Arguments to pass to worker processes. Takes effect after start/recycle.
   *
   * @example
   *
   * workerPool.args = [ '--verbose' ];
   *
   * await workerPool.recycle();
   *
   * @type {string[]}
   */
  get args() {
    return this._args;
  }
  set args(value) {
    this._args = value;
  }

  /**
   * Environmental variables to set for worker processes. Takes effect after start/recycle.
   *
   * @example
   *
   * workerPool.env = { TOKEN: newToken };
   *
   * await workerPool.recycle();
   *
   * @type {Object}
   */
  get env() {
    return this._env;
  }
  set env(value) {
    this._env = value;
  }

  /**
   * True if the worker pool is stopping
   * @type {boolean}
   */
  get isStopping() {
    return this._stopping.length > 0;
  }

  /**
   * True if the worker pool has stopped
   * @type {boolean}
   */
  get isStopped() {
    return this._stopping.length === 0 && this._workers.length === 0;
  }

  /**
   * True if the worker pool has started
   * @type {boolean}
   */
  get isStarted() {
    return this._workers.length > 0;
  }

  /**
   * Gets the current number of worker processes
   * @returns {Number} The current number of worker processes
   */
  getProcessCount() {
    return this._workers.reduce(
      (count, worker) => (worker.pid != null ? ++count : count),
      0
    );
  }

  /**
   * @example
   *
   * const workerPool = new WorkerPool(
   *   cwd: `${versionPath}/workers`,
   *   args: [ '--verbose' ],
   *   env: { TOKEN: token },
   *   min: 1,
   *   max: 4,
   *   idleTimeout: 30000,
   *   stopTimeout: 1000,
   *   stopSignal: 'SIGINT'
   *   strategy: 'fill',
   *   full: 100
   * });
   *
   * @param {Object} options={} - Optional parameters
   * @param {string} options.cwd - The current working directory for worker processes
   * @param {string[]} options.args - Arguments to pass to worker processes
   * @param {Object} options.env - Environmental variables to set for worker processes
   * @param {number} options.min=0 - The minimum number of worker processes in the pool
   * @param {number} options.max=3 - The maximum number of worker processes in the pool
   * @param {number} options.idleTimeout=10000 - Milliseconds before an idle worker process will be asked to stop via options.stopSignal
   * @param {number} options.stopTimeout=10000 - Milliseconds before a worker process will receive SIGKILL after it has been asked to stop
   * @param {'SIGTERM'|'SIGINT'|'SIGHUP'|'SIGKILL'} options.stopSignal='SIGTERM' - Initial signal to send when stopping worker processes
   * @param {'fewest'|'fill'|'round-robin'|'random'} options.strategy='fewest' - The strategy to use when routing calls to workers
   * @param {number} options.full=10 - The number of requests per worker used by the 'fill' strategy
   * @param {boolean} options.start=true - Whether to automatically start this worker pool
   */
  constructor({
    cwd,
    args,
    env,
    min = 0,
    max = DEFAULT_MAX,
    idleTimeout = DEFAULT_IDLE_TIMEOUT,
    stopTimeout = DEFAULT_STOP_TIMEOUT,
    stopSignal = DEFAULT_STOP_SIGNAL,
    strategy = DEFAULT_STRATEGY,
    full = DEFAULT_FULL,
    start = true
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
    this._idleTimeout = idleTimeout;
    this._stopTimeout = stopTimeout;
    this._stopSignal = stopSignal;
    this._strategy = strategy;
    this._full = full;

    if (start) {
      this.start().catch((err) => {
        this.emit('error', err);
      });
    }
  }

  /**
   * Starts the worker pool
   * @returns {Promise}
   * @resolves When the worker pool has started
   * @rejects {WorkerPool.NotReadyError | Error} When an error has been thrown
   */
  async start() {
    if (this.isStarted) {
      return;
    }

    debug('Starting worker pool');

    this._createWorkers();

    return this._startMinWorkers().then(() => {
      debug('Worker pool started');

      this.emit('start');
    });
  }

  /**
   * Stops the worker pool, gracefully shutting down each worker process
   * @returns {Promise}
   * @resolves When the worker pool has stopped
   * @rejects {Error} When an error has been thrown
   */
  async stop() {
    debug('Stopping worker pool');

    const workers = this._workers;
    this._workers = [];

    return this._stop(workers).then(() => {
      debug('Worker pool stopped');

      this.emit('stop');
    });
  }

  /**
   * Recycle the worker pool, gracefully shutting down existing worker processes
   * and starting up new worker processes
   * @returns {Promise}
   * @resolves When the worker pool has recycled
   * @rejects {WorkerPool.NotReadyError | Error} When an error has been thrown
   */
  async recycle() {
    debug('Recycling worker pool');

    const oldWorkers = this._workers;

    // Create a new set of workers
    this._createWorkers();

    // Stop the old workers and start the minimum number of new workers
    return Promise.all([this._stop(oldWorkers), this._startMinWorkers()]).then(
      () => {
        debug('Worker pool recycled');

        this.emit('recycle');
      }
    );
  }

  _createWorkers() {
    const workers = (this._workers = []);

    for (let i = 0, max = this._max; i < max; ++i) {
      const worker = new Worker({
        args: this._args,
        cwd: this._cwd,
        env: this._env,
        idleTimeout: this._idleTimeout,
        stopTimeout: this._stopTimeout,
        signal: this._stopSignal,
        stopWhenIdle: () => this._stopWhenIdle()
      });

      workers.push(worker);
    }
  }

  async _startMinWorkers() {
    const workers = this._workers;
    const min = this._min;

    const startWorkers = workers.slice(0, min).map((worker) => worker.start());

    return Promise.all(startWorkers);
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
   * Routes a request to a worker in the pool asking it to import a module and call a function with the provided arguments.
   *
   * **Note**: WorkerPool#call() uses JSON serialization to communicate with worker processes, so only types/objects that can survive JSON.stringify()/JSON.parse() will be passed through unchanged.
   *
   * @example
   *
   * const result = await workerPool.call('user-module', 'hashPassword', password, salt);
   *
   * @param {string} modulePath - The module path for the worker process to import
   * @param {string} functionName - The name of a function expored by the imported module
   * @param {...any} args - Arguments to pass when calling the function
   * @returns {Promise}
   * @resolves {any} The return value of the function call when the call returns
   * @rejects {WorkerPool.UnexpectedExitError | WorkerPool.WorkerError | Error} When an error has been thrown
   */
  async call(modulePath, functionName, ...args) {
    const resolvedModulePath = this._resolve(modulePath);

    return this._call(resolvedModulePath, functionName, args);
  }

  /**
   * Creates a proxy function that will call WorkerPool#call() with the provided module path, function name, and arguments. Provided as a convenience and minor performance improvement as the modulePath will only be resolved when creating the proxy, rather than with each call.
   *
   * **Note**: WorkerPool#proxy() uses JSON serialization to communicate with worker processes, so only types/objects that can survive JSON.stringify()/JSON.parse() will be passed through unchanged.
   *
   * @example
   *
   * const hashPassword = workerPool.proxy('user-module', 'hashPassword');
   *
   * const hashedPassword = await hashPassword(password, salt);
   *
   * @param {string} modulePath - The module path for the worker process to import
   * @param {string} functionName - The name of a function expored by the imported module
   * @returns {Function} A function that calls WorkerPool#call() with the provided modulePath, functionName, and args, and returns its Promise
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
    if (!this.isStarted) {
      throw new NotStartedError();
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
   * Return the worker with the fewest number of waiting requests, favoring
   * workers that are already started
   * @private
   */
  _fewestStrategy() {
    const workers = this._workers;

    let worker = workers[0];

    for (let i = 1, len = workers.length; i < len; ++i) {
      const candidate = workers[i];

      if (
        candidate.waiting < worker.waiting ||
        (candidate.waiting === 0 &&
          candidate.isStarted &&
          !worker.isStarted)
      ) {
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

    const count = this.getProcessCount();

    return count > min;
  }

  /**
   * https://nodejs.org/api/events.html#events_emitter_once_eventname_listener
   * @function JobQueue#once
   * @param {string|symbol} eventName - The name of the event.
   * @param {Function} listener - The callback function.
   * @returns {EventEmitter}
   */

  /**
   * https://nodejs.org/api/events.html#events_emitter_on_eventname_listener
   * @function JobQueue#on
   * @param {string|symbol} eventName - The name of the event.
   * @param {Function} listener - The callback function.
   * @returns {EventEmitter}
   */

  /**
   * https://nodejs.org/api/events.html#events_emitter_off_eventname_listener
   * @function JobQueue#off
   * @param {string|symbol} eventName - The name of the event.
   * @param {Function} listener - The callback function.
   * @returns {EventEmitter}
   */
}

/**
 * Thrown when the worker pool is not started
 * @Static
 */
WorkerPool.NotStartedError = NotStartedError;

/**
 * Thrown when a worker process doesn't signal that it is ready
 * @Static
 */
WorkerPool.NotReadyError = Worker.NotReadyError;

/**
 * Thrown when a worker process exits unexpectedly
 * @Static
 */
WorkerPool.UnexpectedExitError = Worker.UnexpectedExitError;

/**
 * Thrown when a function called by a worker process (or a worker process itself) throws an error
 * @Static
 */
WorkerPool.WorkerError = Worker.WorkerError;

module.exports = WorkerPool;
