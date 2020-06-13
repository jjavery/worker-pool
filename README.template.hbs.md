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
const WorkerPool = require('@jjavery/worker-pool');

// Create an instance of a WorkerPool. The pool will start with 1 process and
// expand to 5 as needed. The fill strategy will fill up to 10 requests in the
// first non-full worker before moving on to the next. If all workers are
// full, it will send requests to the least-full worker, even if that overfills
// the worker. Workers will be shut down after they are idle for 30 seconds.
const workerPool = new WorkerPool({
  min: 1,
  max: 5,
  idle: 30000,
  strategy: 'fill',
  full: 10
});

// Create a proxy for a worker function
const doSomeWork = workerPool.proxy('./worker', 'doSomeWork');

for (let = 0; i < 1000; ++i) {
  doSomeWork('bar').then((result) => {
    console.log(result);
  }).catch((err) => {
    console.error(err);
  });
}

process.on('SIGINT', () => {
  // Stop the worker pool
  workerPool.stop();
});
```

### worker.js:

```javascript
function doSomeWork(work) {
  return `${work} bar`;
}

module.exports = {
  doSomeWork
};
```

# API Reference

{{>main}}

---

Copyright &copy; 2020 James P. Javery [@jjavery](https://github.com/jjavery)
