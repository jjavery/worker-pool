const { assert } = require('chai');
const WorkerPool = require('../src/worker-pool');
const Worker = require('../src/worker');

describe('WorkerPool', function () {
  it('creates a worker pool', async function () {
    const workerPool = new WorkerPool({ start: false });

    assert.instanceOf(workerPool, WorkerPool);
    assert.isFalse(workerPool.isStarted);
    assert.isFalse(workerPool.isStopping);
    assert.isTrue(workerPool.isStopped);
  });

  it('starts a worker pool', async function () {
    const workerPool = new WorkerPool({ start: false });

    await workerPool.start();

    try {
      assert.isTrue(workerPool.isStarted);
      assert.isFalse(workerPool.isStopping);
      assert.isFalse(workerPool.isStopped);
    } catch (err) {
      throw err;
    } finally {
      await workerPool.stop();
    }
  });

  it('stops a worker pool', async function () {
    const workerPool = new WorkerPool();

    const workerPoolStop = workerPool.stop();

    try {
      assert.isFalse(workerPool.isStarted);
      assert.isTrue(workerPool.isStopping);
      assert.isFalse(workerPool.isStopped);
    } catch (err) {
      throw err;
    } finally {
      await workerPoolStop;
    }

    assert.isFalse(workerPool.isStarted);
    assert.isFalse(workerPool.isStopping);
    assert.isTrue(workerPool.isStopped);
  });

  it('creates a worker pool with a minimum number of running workers', async function () {
    const workerPool = new WorkerPool({ min: 2, start: false });

    const runningCountBeforeStart = workerPool.getProcessCount();

    await workerPool.start();

    const runningCountAfterStart = workerPool.getProcessCount();

    await workerPool.stop();

    const runningCountAfterStop = workerPool.getProcessCount();

    assert.equal(runningCountBeforeStart, 0);
    assert.equal(runningCountAfterStart, 2);
    assert.equal(runningCountAfterStop, 0);
  });

  it('calls a function exported by a worker module', async function () {
    const workerPool = new WorkerPool();

    const result = await workerPool.call('./test-worker', 'test', 'test');

    await workerPool.stop();

    assert.equal(result, 'test');
  });

  it('proxies a function exported by a worker module', async function () {
    const workerPool = new WorkerPool();

    const testFunc = workerPool.proxy('./test-worker', 'test');

    const result = await testFunc('test');

    await workerPool.stop();

    assert.equal(result, 'test');
  });

  it('limits the maximum number of workers', async function () {
    const workerPool = new WorkerPool({ max: 2, strategy: 'round-robin' });

    await workerPool.call('./test-worker', 'test', 'test');
    await workerPool.call('./test-worker', 'test', 'test');
    await workerPool.call('./test-worker', 'test', 'test');

    try {
      assert.equal(workerPool.getProcessCount(), 2);
    } catch (err) {
      throw err;
    } finally {
      workerPool.stop();
    }
  });

  it('properly handles worker processes that exit unexpectedly', async function () {
    const workerPool = new WorkerPool();

    const exit = workerPool.proxy('./test-worker', 'exit');

    try {
      await exit();

      assert.fail('Failed to throw');
    } catch (err) {
      assert.instanceOf(err, Worker.UnexpectedExitError);
    }

    const testFunc = workerPool.proxy('./test-worker', 'test');

    const result = await testFunc('test');

    await workerPool.stop();

    assert.equal(result, 'test');
  });

  it('recycles a worker pool', async function () {
    const workerPool = new WorkerPool();

    const testFunc = workerPool.proxy('./test-worker', 'test');

    testFunc('test')
      .then(() => {})
      .catch((err) => {
        console.log(err);
      });

    workerPool.recycle();

    const result = await testFunc('test');

    await workerPool.stop();

    assert.equal(result, 'test');
  });

  it('throws an error when calling a worker function after being stopped', async function () {
    const workerPool = new WorkerPool();

    await workerPool.stop();

    const testFunc = workerPool.proxy('./test-worker', 'test');

    try {
      await testFunc();

      assert.fail('Failed to throw');
    } catch (err) {
      assert.instanceOf(err, WorkerPool.NotStartedError);
    }
  });

  it('properly handles worker processes that throw errors', async function () {
    const workerPool = new WorkerPool();

    const throws = workerPool.proxy('./test-worker', 'throws');

    try {
      await throws();

      assert.fail('Failed to throw');
    } catch (err) {
      assert.instanceOf(err, Worker.WorkerError);
    } finally {
      await workerPool.stop();
    }
  });

  it('uses the "fewest" strategy to assign requests to workers', async function () {
    const workerPool = new WorkerPool({ strategy: 'fewest' });

    const result = await workerPool.call('./test-worker', 'test', 'test');

    await workerPool.stop();

    assert.equal(result, 'test');
  });

  it('uses the "fill" strategy to assign requests to workers', async function () {
    const workerPool = new WorkerPool({ strategy: 'fill' });

    const result = await workerPool.call('./test-worker', 'test', 'test');

    await workerPool.stop();

    assert.equal(result, 'test');
  });

  it('uses the "random" strategy to assign requests to workers', async function () {
    const workerPool = new WorkerPool({ strategy: 'random' });

    const result = await workerPool.call('./test-worker', 'test', 'test');

    await workerPool.stop();

    assert.equal(result, 'test');
  });

  it('uses the "round-robin" strategy to assign requests to workers', async function () {
    const workerPool = new WorkerPool({ strategy: 'round-robin' });

    const result = await workerPool.call('./test-worker', 'test', 'test');

    await workerPool.stop();

    assert.equal(result, 'test');
  });
});
