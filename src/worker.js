const debug = require('debug')('worker-pool:worker');
const { deserializeError } = require('serialize-error');
const { exit } = require('../test/test-worker');

class Worker {
  _genericPool;
  _queued = 0;
  _childProcess = null;
  _acquiringChildProcess = null;
  _messageListener = null;
  _exitListener = null;
  _requests = {};
  _id = 0;

  get queued() {
    return this._queued;
  }

  constructor(genericPool) {
    this._genericPool = genericPool;
  }

  async acquire() {
    this._queued++;

    let childProcess = this._childProcess;
    const acquiringChildProcess = this._acquiringChildProcess;

    // If this worker already has a child process then there's nothing to do
    if (childProcess != null) {
      return;
    }
    // If this worker is in the process of acquring a child process, return the
    // promise that will resolve when a child process is acquired
    else if (acquiringChildProcess != null) {
      return acquiringChildProcess;
    }

    // No child process and no promise so create the promise and acquire
    // a child process
    return (this._acquiringChildProcess = new Promise((resolve, reject) => {
      this._acquireChildProcess()
        .then((childProcess) => {
          this._childProcess = childProcess;
          this._acquiringChildProcess = null;

          const messageListener = (this._messageListener = (message) =>
            this._response(message));
          const exitListener = (this._exitListener = () => this._cleanup());

          childProcess.on('message', messageListener);
          childProcess.once('exit', exitListener);

          resolve();
        })
        .catch((err) => {
          reject(err);
        });
    }));
  }

  async release() {
    const queued = (this._queued = Math.max(this._queued - 1, 0));

    if (queued === 0) {
      const childProcess = this._childProcess;
      this._childProcess = null;

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

      await this._releaseChildProcess(childProcess);
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

  async _acquireChildProcess() {
    return this._genericPool.acquire();
  }

  async _releaseChildProcess(childProcess) {
    if (childProcess.exitCode !== null) {
      return this._genericPool.destroy(childProcess);
    } else {
      return this._genericPool.release(childProcess);
    }
  }

  _cleanup() {
    const requests = this._requests;
    const ids = Object.keys(requests);

    if (ids.length > 0) {
      debug('Child process [%d] exited unexpectedly', this._childProcess.pid);
    }

    for (let id of ids) {
      const { reject } = requests[id];
      delete requests[id];

      reject(new Error('Child process exited unexpectedly'));
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
