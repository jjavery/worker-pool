// Get a reference to the WorkerPool class
const WorkerPool = require('../');

// Create an instance of a WorkerPool. The pool will start with 1 process and
// expand to 5 as needed. The fill strategy will queue up to 10 requests in the
// first non-full worker before moving on to the next. If all workers are
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
