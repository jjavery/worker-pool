# worker-pool

A load-balancing and auto-scaling worker pool for Node.js applications

## Features

- **Load Balancing** Requests are sent to workers based on one of several of load balancing strategies
- **Auto Scaling** Worker processes are started automatically when handling reqests and stopped automatically when idle
- **Hot Reloading** Start a new set of workers while gracefully stopping the current workers
- **Prestarting** Start one or more worker processes immediately and keep them running even when they're idle — initial or infrequent requests won't have to wait for worker process starts
- **Simple Workers** A worker module is simply a module that exports one or more functions and (optionally) handles process signals

## Installation

Install with NPM

```shell
$ npm install @jjavery/worker-pool
```

## Example

### app.js:

```javascript
// Get a reference to the WorkerPool class
const WorkerPool = require('@jjavery/workerpool');

// Create an instance of a WorkerPool. The pool will start with 1 process and
// expand to 5 as needed. The 'fill' strategy will queue up to 10 requests in
// the first non-full worker before moving on to the next. If all workers are
// full, it will send requests to the least-full worker, even if that overfills
// the worker.
const workerPool = new WorkerPool({
  min: 1,
  max: 5,
  strategy: 'fill',
  full: 10
});

// Create a proxy for a worker function
const doSomeWork = workerPool.proxy('./worker', 'doSomeWork');

// Call the proxy 1,000 times
for (let i = 0; i < 1000; ++i) {
  doSomeWork('bar')
    .then((result) => {
      console.log(result);
    })
    .catch((err) => {
      console.error(err);
    });
}

// Stop the worker pool
workerPool.stop();
```

### worker.js:

```javascript
async function doSomeWork(work) {
  const ms = Math.floor(Math.random() * 1000);

  await wait(ms);

  return `[${process.pid}] Work "${work}" completed in ${ms}ms`;
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on('SIGTERM', () => {
  process.exit(0);
});

module.exports = {
  doSomeWork
};
```

# API Reference

## WorkerPool ⇐ EventEmitter
Provides a load-balancing and (optionally) auto-scaling pool of worker
processes and the ability to request for worker processes to import modules,
call their exported functions, and reply with their return values and thrown
exceptions. Load balancing and auto-scaling is configurable via min/max
limits, strategies, and timeouts.

**Extends**: EventEmitter  

* [WorkerPool](#markdown-header-workerpool-eventemitter) ⇐ EventEmitter
    * [new WorkerPool(options)](#markdown-header-new-workerpooloptions)
    * _instance_
        * [.cwd](#markdown-header-workerpoolcwd-string) : string
        * [.args](#markdown-header-workerpoolargs-arraystring) : Array.<string>
        * [.env](#markdown-header-workerpoolenv-object) : Object
        * [.isStopping](#markdown-header-workerpoolisstopping-boolean) : boolean
        * [.isStopped](#markdown-header-workerpoolisstopped-boolean) : boolean
        * [.isStarted](#markdown-header-workerpoolisstarted-boolean) : boolean
        * [.getProcessCount()](#markdown-header-workerpoolgetprocesscount-number) ⇒ Number
        * [.start()](#markdown-header-workerpoolstart-promise) ⇒ Promise
        * [.stop()](#markdown-header-workerpoolstop-promise) ⇒ Promise
        * [.recycle()](#markdown-header-workerpoolrecycle-promise) ⇒ Promise
        * [.call(modulePath, functionName, ...args)](#markdown-header-workerpoolcallmodulepath-functionname-args-promise) ⇒ Promise
        * [.proxy(modulePath, functionName)](#markdown-header-workerpoolproxymodulepath-functionname-function) ⇒ function
        * ["error"](#markdown-header-error)
        * ["start"](#markdown-header-start)
        * ["recycle"](#markdown-header-recycle)
        * ["stop"](#markdown-header-stop)
    * _static_
        * [.NotStartedError](#markdown-header-workerpoolnotstartederror)
        * [.NotReadyError](#markdown-header-workerpoolnotreadyerror)
        * [.UnexpectedExitError](#markdown-header-workerpoolunexpectedexiterror)
        * [.WorkerError](#markdown-header-workerpoolworkererror)

### new WorkerPool(options)

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| options | Object | `{}` | Optional parameters |
| options.cwd | string |  | The current working directory for worker processes |
| options.args | Array.<string> |  | Arguments to pass to worker processes |
| options.env | Object |  | Environmental variables to set for worker processes |
| options.min | number | `0` | The minimum number of worker processes in the pool |
| options.max | number | `3` | The maximum number of worker processes in the pool |
| options.idleTimeout | number | `10000` | Milliseconds before an idle worker process will be asked to stop via options.stopSignal |
| options.stopTimeout | number | `10000` | Milliseconds before a worker process will receive SIGKILL after it has been asked to stop |
| options.stopSignal | 'SIGTERM' ⎮ 'SIGINT' ⎮ 'SIGHUP' ⎮ 'SIGKILL' | `'SIGTERM'` | Initial signal to send when stopping worker processes |
| options.strategy | 'fewest' ⎮ 'fill' ⎮ 'round-robin' ⎮ 'random' | `'fewest'` | The strategy to use when routing calls to workers |
| options.full | number | `10` | The number of requests per worker used by the 'fill' strategy |
| options.start | boolean | `true` | Whether to automatically start this worker pool |

**Example**  
```js
const workerPool = new WorkerPool(
  cwd: `${versionPath}/workers`,
  args: [ '--verbose' ],
  env: { TOKEN: token },
  min: 1,
  max: 4,
  idleTimeout: 30000,
  stopTimeout: 1000,
  stopSignal: 'SIGINT'
  strategy: 'fill',
  full: 100
});
```
### workerPool.cwd : string
The current working directory for worker processes. Takes effect after start/recycle.

**Example**  
```js
workerPool.cwd = `${versionPath}/workers`;

await workerPool.recycle();
```
### workerPool.args : Array.<string>
Arguments to pass to worker processes. Takes effect after start/recycle.

**Example**  
```js
workerPool.args = [ '--verbose' ];

await workerPool.recycle();
```
### workerPool.env : Object
Environmental variables to set for worker processes. Takes effect after start/recycle.

**Example**  
```js
workerPool.env = { TOKEN: newToken };

await workerPool.recycle();
```
### workerPool.isStopping : boolean
True if the worker pool is stopping

### workerPool.isStopped : boolean
True if the worker pool has stopped

### workerPool.isStarted : boolean
True if the worker pool has started

### workerPool.getProcessCount() ⇒ Number
Gets the current number of worker processes

**Returns**: Number - The current number of worker processes  
### workerPool.start() ⇒ Promise
Starts the worker pool

**Resolves**: When the worker pool has started  
**Rejects**: WorkerPool.NotReadyError | Error When an error has been thrown  
### workerPool.stop() ⇒ Promise
Stops the worker pool, gracefully shutting down each worker process

**Resolves**: When the worker pool has stopped  
**Rejects**: Error When an error has been thrown  
### workerPool.recycle() ⇒ Promise
Recycle the worker pool, gracefully shutting down existing worker processes
and starting up new worker processes

**Resolves**: When the worker pool has recycled  
**Rejects**: WorkerPool.NotReadyError | Error When an error has been thrown  
### workerPool.call(modulePath, functionName, ...args) ⇒ Promise
Routes a request to a worker in the pool asking it to import a module and call a function with the provided arguments.

**Note**: WorkerPool#call() uses JSON serialization to communicate with worker processes, so only types/objects that can survive JSON.stringify()/JSON.parse() will be passed through unchanged.

**Resolves**: any The return value of the function call when the call returns  
**Rejects**: WorkerPool.UnexpectedExitError | WorkerPool.WorkerError | Error When an error has been thrown  

| Param | Type | Description |
| --- | --- | --- |
| modulePath | string | The module path for the worker process to import |
| functionName | string | The name of a function expored by the imported module |
| ...args | any | Arguments to pass when calling the function |

**Example**  
```js
const result = await workerPool.call('user-module', 'hashPassword', password, salt);
```
### workerPool.proxy(modulePath, functionName) ⇒ function
Creates a proxy function that will call WorkerPool#call() with the provided module path, function name, and arguments. Provided as a convenience and minor performance improvement as the modulePath will only be resolved when creating the proxy, rather than with each call.

**Note**: WorkerPool#proxy() uses JSON serialization to communicate with worker processes, so only types/objects that can survive JSON.stringify()/JSON.parse() will be passed through unchanged.

**Returns**: function - A function that calls WorkerPool#call() with the provided modulePath, functionName, and args, and returns its Promise  

| Param | Type | Description |
| --- | --- | --- |
| modulePath | string | The module path for the worker process to import |
| functionName | string | The name of a function expored by the imported module |

**Example**  
```js
const hashPassword = workerPool.proxy('user-module', 'hashPassword');

const hashedPassword = await hashPassword(password, salt);
```
### "error"
Emitted when an error is thrown in the constructor.

### "start"
Emitted when the worker pool starts.

### "recycle"
Emitted when the worker pool recycles.

### "stop"
Emitted when the worker pool stops.

### WorkerPool.NotStartedError
Thrown when the worker pool is not started

### WorkerPool.NotReadyError
Thrown when a worker process doesn't signal that it is ready

### WorkerPool.UnexpectedExitError
Thrown when a worker process exits unexpectedly

### WorkerPool.WorkerError
Thrown when a function called by a worker process (or a worker process itself) throws an error


---

Copyright &copy; 2020 James P. Javery [@jjavery](https://github.com/jjavery)
