# worker-pool

A load-balancing and auto-scaling pool of Node.js worker processes

## Features

- **Load Balancing** Requests are sent to worker processes based on one of several of load balancing strategies
- **Auto Scaling** Worker processes are started automatically when handling reqests and stopped automatically when idle
- **Hot Reloading** Start a new set of worker processes while gracefully stopping the current workers
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
// full, it will send requests to the least-full worker, even if this overfills
// the worker.
const workerPool = new WorkerPool({
  min: 1,
  max: 5,
  strategy: 'fill',
  full: 10
});

// Create a proxy for a worker function
// Note that a proxy function always returns a promise, even if its worker
// function is synchronous
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

{{>main}}

---

Copyright &copy; 2022 James P. Javery [@jjavery](https://github.com/jjavery)
