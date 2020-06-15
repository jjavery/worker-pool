# worker-pool

A worker pool for Node.js applications

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
Provides a pool of child processes and the ability to instruct those
processes to require modules and call their exported functions.

**Extends**: EventEmitter  

* [WorkerPool](#markdown-header-workerpool-eventemitter) ⇐ EventEmitter
    * [new WorkerPool(options)](#markdown-header-new-workerpooloptions)
    * [.stop()](#markdown-header-workerpoolstop)
    * [.recycle()](#markdown-header-workerpoolrecycle)
    * [.exec(modulePath, functionName, ...args)](#markdown-header-workerpoolexecmodulepath-functionname-args-promise) ⇒ Promise
    * [.proxy(modulePath, functionName)](#markdown-header-workerpoolproxymodulepath-functionname-function) ⇒ function

### new WorkerPool(options)

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| options | Object | `{}` | Optional parameters |
| options.cwd | number |  | The current working directory for child processes |
| options.args | number |  | Arguments to pass to child processes |
| options.env | number |  | Environmental variables to pass to child processes |
| options.min | number | `0` | The minimum number of child processes in the pool |
| options.max | number | `3` | The maximum number of child processes in the pool |
| options.idle | number | `10000` | Milliseconds before an idle process will be removed from the pool |
| options.timeout | number | `10000` | Milliseconds before a child process will receive SIGKILL after receiving the initial signal, if it has not already exited |
| options.signal | 'SIGTERM' ⎮ 'SIGINT' ⎮ 'SIGHUP' ⎮ 'SIGKILL' | `'SIGTERM'` | Initial signal to send when destroying child processes |
| options.strategy | 'fewest' ⎮ 'fill' ⎮ 'round-robin' ⎮ 'random' | `'fewest'` | The strategy to use when routing requests to child processes |
| options.full | number | `10` | The number of requests per child process used by the 'fill' strategy |

### workerPool.stop()
Stops the worker pool, gracefully shutting down each child process

### workerPool.recycle()
Recycle the worker pool, gracefully shutting down existing child processes
and starting up new child processes

### workerPool.exec(modulePath, functionName, ...args) ⇒ Promise
Sends a request to a child process in the pool asking it to require a module and call a function with the provided arguments

**Returns**: Promise - The result of the function invocation  

| Param | Type | Description |
| --- | --- | --- |
| modulePath | string | The module path for the child process to require() |
| functionName | string | The name of a function expored by the required module |
| ...args | any | Arguments to pass when invoking function |

### workerPool.proxy(modulePath, functionName) ⇒ function
Creates a proxy function that will call WorkerPool#exec() with the provided module path and function name

**Returns**: function - A function that returns a Promise and calls the child process function with the provided args  

| Param | Type | Description |
| --- | --- | --- |
| modulePath | string | The module path for the child process to require() |
| functionName | string | The name of a function expored by the required module |


---

Copyright &copy; 2020 James P. Javery [@jjavery](https://github.com/jjavery)
