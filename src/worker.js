const debug = require('debug')('worker-pool:worker');
const { deserializeError } = require('serialize-error');

class Worker {
  _workerPool;
  _queued = 0;
  _childProcess = null;
  _acquireChildProcess = null;
  _requests = {};
  _id = 0;

  get queued() {
    return this._queued;
  }

  constructor(workerPool) {
    this._workerPool = workerPool;
  }

  async acquire() {
    this._queued++;

    let childProcess = this._childProcess;

    if (childProcess != null) {
      return;
    } else if (this._acquireChildProcess != null) {
      return this._acquireChildProcess;
    }

    const acquireChildProcess = (this._acquireChildProcess = this._workerPool._acquireChildProcess());

    childProcess = this._childProcess = await acquireChildProcess;

    this._acquireChildProcess = null;

    childProcess.on('message', (message) => this._response(message));
  }

  async release() {
    const queued = (this._queued = Math.max(this._queued - 1, 0));

    if (queued === 0) {
      await this.#workerPool._releaseChildProcess(this.#childProcess);
      this._childProcess = null;
    }
  }

  async request(message = {}, sendHandle = null) {
    const id = this._getNextID();

    const messageToSend = Object.assign({}, message, { id });

    const childProcess = this._childProcess;

    debug('Sending message to child process [%d]:', childProcess.pid);
    debug('%j', messageToSend);

    childProcess.send(messageToSend, sendHandle);

    return new Promise((resolve, reject) => {
      this._requests[id] = { resolve, reject };
    });
  }

  _response(message) {
    const { id, err, result } = message;

    const { resolve, reject } = this._requests[id];
    delete this._requests[id];

    debug('Received message from child process [%d]:', this._childProcess.pid);
    debug('%j', message);

    if (err != null) {
      reject(deserializeError(err));
    } else {
      resolve(result);
    }
  }

  _getNextID() {
    let id = this._id++;

    if (id >= Number.MAX_SAFE_INTEGER) {
      id = this._id = 0;
    }

    return id;
  }
}

module.exports = Worker;
