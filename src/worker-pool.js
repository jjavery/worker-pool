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

/**
 * Provides a pool of child processes and the ability to instruct those
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

  _genericPool;
  _workers = [];
  _draining = new Map();

  _round = 0;

  /**
   * @param {Object} options={} - Optional parameters
   * @param {number} options.cwd - The current working directory for child processes
   * @param {number} options.args - Arguments to pass to child processes
   * @param {number} options.env - Environmental variables to pass to child processes
   * @param {number} options.min=0 - The minimum number of child processes in the pool
   * @param {number} options.max=3 - The maximum number of child processes in the pool
   * @param {number} options.idle=10000 - Milliseconds before an idle process will be removed from the pool
   * @param {number} options.timeout=10000 - Milliseconds before a child process will receive SIGKILL after receiving the initial signal, if it has not already exited
   * @param {'SIGTERM'|'SIGINT'|'SIGHUP'|'SIGKILL'} options.signal='SIGTERM' - Initial signal to send when destroying child processes
   * @param {'fewest'|'fill'|'round-robin'|'random'} options.strategy='fewest' - The strategy to use when routing requests to child processes
   * @param {number} options.full=10 - The number of requests per child process used by the 'fill' strategy
   */
  constructor({
    cwd,
    args,
    env,
    min = 0,
    max = defaultMax,
    idle = 10000,
    timeout = 10000,
    signal = 'SIGTERM',
    strategy = 'fewest',
    full = 10
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

    this._createGenericPoolAndWorkers();

    debug('Worker pool started');

    this.emit('start');
  }

  _createGenericPoolAndWorkers() {
    const factory = {
      create: () => {
        return this._createChildProcess(
          workerMain,
          this._args,
          this._cwd,
          this._env
        );
      },
      destroy: (childProcess) => {
        this._destroyChildProcess(childProcess);
      }
    };

    const options = {
      min: this._min,
      max: this._max,
      softIdleTimeoutMillis: this._idle,
      idleTimeoutMillis: 2 ** 31 - 1,
      evictionRunIntervalMillis: 1000
    };

    this._genericPool = genericPool.createPool(factory, options);

    this._workers = [];

    for (let i = 0, max = this._max; i < max; ++i) {
      const worker = new Worker(this._genericPool);

      this._workers.push(worker);
    }
  }

  info() {
    const result = {
      workers: [],
      processes: []
    };

    for (let [genericPool, workers] of this._draining) {
      addToResult(genericPool, workers);
    }

    addToResult(this._genericPool, this._workers);

    function addToResult(genericPool, workers) {
      for ({ queued, _childProcess } of workers) {
        result.workers.push({
          queued,
          pid: _childProcess ? _childProcess.pid : null
        });
      }
      for ({
        obj: { exitCode, pid },
        state
      } of genericPool._allObjects) {
        result.processes.push({
          exitCode,
          pid,
          state
        });
      }
    }

    return result;
  }

  /**
   * Stops the worker pool, gracefully shutting down each child process
   */
  stop() {
    debug('Stopping worker pool');

    this._stop().then(() => {
      debug('Worker pool stopped');

      this.emit('stop');
    });
  }

  /**
   * Recycle the worker pool, gracefully shutting down existing child processes
   * and starting up new child processes
   */
  recycle() {
    debug('Recycling worker pool');

    // Stop the existing generic pool
    this._stop().then(() => {
      debug('Worker pool recycled');

      this.emit('recycle');
    });

    // Create a new generic pool and set of workers
    this._createGenericPoolAndWorkers();
  }

  async _stop() {
    const genericPool = this._genericPool;

    this._addDraining(genericPool);

    try {
      await genericPool.drain();
      await genericPool.clear();
    } catch (err) {
      this.emit('error', err);
    } finally {
      this._removeDraining(genericPool);
    }
  }

  /**
   * Keep references to a generic pool and workers while draining
   * @private
   */
  _addDraining(genericPool) {
    this._draining.set(genericPool, this._workers);
  }

  /**
   * Clean up the references to the drained generic pool and workers
   * @private
   */
  _removeDraining(genericPool) {
    this._draining.delete(genericPool);
  }

  /**
   * Sends a request to a child process in the pool asking it to require a module and call a function with the provided arguments
   * @param {string} modulePath - The module path for the child process to require()
   * @param {string} functionName - The name of a function expored by the required module
   * @param {...any} args - Arguments to pass when invoking function
   * @returns {Promise} The result of the function invocation
   */
  async exec(modulePath, functionName, ...args) {
    const resolvedModulePath = this._resolve(modulePath);

    return this._exec(resolvedModulePath, functionName, args);
  }

  /**
   * Creates a proxy function that will call WorkerPool#exec() with the provided module path and function name
   * @param {string} modulePath - The module path for the child process to require()
   * @param {string} functionName - The name of a function expored by the required module
   * @returns {Function} A function that returns a Promise and calls the child process function with the provided args
   */
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

    let reply;

    try {
      reply = await worker.request({
        modulePath: resolvedModulePath,
        functionName,
        args
      });
    } catch (err) {
      throw err;
    } finally {
      worker.release();
    }

    return reply;
  }

  _resolve(modulePath) {
    if (/^(\/|.\/|..\/)/.test(modulePath)) {
      const dirname = path.dirname(module.parent.filename);
      modulePath = path.resolve(dirname, modulePath);
    }
    return modulePath;
  }

  _getWorker() {
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

  _createChildProcess(modulePath, args, cwd, env) {
    return new Promise((resolve, reject) => {
      debug('Creating child process from "%s"', modulePath);

      const options = { cwd, env, serialization: this._serialization };

      // Start a child process
      const childProcess = child_process.fork(modulePath, args, options);

      // Wait for a 'ready' message
      childProcess.on('message', handleMessage);

      function handleMessage(message) {
        if (message === 'ready') {
          debug('Created child process [%d]', childProcess.pid);

          this.emit('createChildProcess', childProcess);

          removeListeners();

          resolve(childProcess);
        }
      }

      // Handle startup error
      childProcess.once('error', handleError);

      function handleError(err) {
        debug('Child process error [%d]', childProcess.pid);
        debug('%j', err);

        removeListeners();

        reject(err);
      }

      // Time out waiting for 'ready' message
      const timer = setTimeout(() => {
        removeListeners();
        reject(
          new Error(
            'Timed out waiting for child process [%d] to send ready message',
            childProcess.pid
          )
        );
      }, 1000);

      function removeListeners() {
        childProcess.removeListener('message', handleMessage);
        childProcess.removeListener('error', handleError);
        clearTimeout(timer);
      }
    });
  }

  _destroyChildProcess(childProcess) {
    if (childProcess.exitCode !== null) {
      debug(
        "Won't destroy child process [%d] because it has already exited",
        childProcess.pid
      );
      return;
    }

    debug('Destroying child process [%d]', childProcess.pid);

    const signal = this._signal;

    // Don't bother with the timeout if the first signal is SIGKILL
    if (signal !== 'SIGKILL') {
      // Set up a timer to send SIGKILL to the child process after the timeout
      const timer = setTimeout(() => {
        debug(
          'Child process [%d] [%s] timed out; sending SIGKILL',
          childProcess.pid,
          signal
        );
        childProcess.kill('SIGKILL');
      }, this._timeout);

      // Don't let this timer keep the (parent) process alive
      timer.unref();

      // If the child process does exit before the timeout, clear the timer
      childProcess.once('exit', () => clearTimeout(timer));
    }

    // Ask the child process to stop
    childProcess.kill(signal);

    debug('Destroyed child process [%d]', childProcess.pid);

    this.emit('destroyChildProcess', childProcess);
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

      if (candidate.queued < worker.queued) {
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
}

module.exports = WorkerPool;
