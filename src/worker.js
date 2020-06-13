const debug = require('debug')('worker-pool:worker');
const { deserializeError } = require('serialize-error');

class Worker {
  #workerPool;
  #queued = 0;
  #childProcess = null;
  #acquireChildProcess = null;
  #requests = {};
  #id = 0;

  get queued() {
    return this.#queued;
  }

  constructor(workerPool) {
    this.#workerPool = workerPool;
  }

  async acquire() {
    this.#queued++;

    let childProcess = this.#childProcess;

    if (childProcess != null) {
      return;
    } else if (this.#acquireChildProcess != null) {
      return this.#acquireChildProcess;
    }

    const acquireChildProcess = (this.#acquireChildProcess = this.#workerPool._acquireChildProcess());

    childProcess = await acquireChildProcess;

    this.#acquireChildProcess = null;
    this.#childProcess = childProcess;

    childProcess.on('message', (message) => this._response(message));
  }

  async release() {
    const queued = --this.#queued;

    if (queued === 0) {
      await this.#workerPool._releaseChildProcess(this.#childProcess);
      this.#childProcess = null;
    }
  }

  async request(message = {}, sendHandle = null) {
    const id = this._getNextID();

    const messageToSend = Object.assign({}, message, { id });

    const childProcess = this.#childProcess;

    debug('Sending message to child process [%d]:', childProcess.pid);
    debug('%j', messageToSend);

    childProcess.send(messageToSend, sendHandle);

    return new Promise((resolve, reject) => {
      this.#requests[id] = { resolve, reject, childProcess };
    });
  }

  _response(message) {
    const { id, err, result } = message;

    const { resolve, reject, childProcess } = this.#requests[id];
    delete this.#requests[id];

    debug('Received message from child process [%d]:', childProcess.pid);
    debug('%j', message);

    if (err != null) {
      reject(deserializeError(err));
    } else {
      resolve(result);
    }
  }

  _getNextID() {
    let id = this.#id++;

    if (id >= Number.MAX_SAFE_INTEGER) {
      id = this.#id = 0;
    }

    return id;
  }
}

module.exports = Worker;
