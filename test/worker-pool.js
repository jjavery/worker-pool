const { assert } = require('chai');
const WorkerPool = require('../src/worker-pool');

describe('WorkerPool', function () {
  it('execues a function exported by a worker module', async function () {
    const workerPool = new WorkerPool();

    const result = await workerPool.exec('./test-worker', 'test', 'test', 100);

    workerPool.stop();

    assert.equal(result, 'test');
  });

  it('proxies a function exported by a worker module', async function () {
    const workerPool = new WorkerPool();

    const testFunc = workerPool.proxy('./test-worker', 'test');

    const result = await testFunc('test');

    workerPool.stop();

    assert.equal(result, 'test');
  });

  it('properly handles child processes that exit unexpectedly', async function () {
    const workerPool = new WorkerPool();

    const exit = workerPool.proxy('./test-worker', 'exit');

    try {
      const result = await exit();
    } catch (err) {
      assert.isNotNull(err);
    }

    const testFunc = workerPool.proxy('./test-worker', 'test');

    const result = await testFunc('test');

    workerPool.stop();

    assert.equal(result, 'test');
  });

  it('recycles a worker pool', async function () {
    const workerPool = new WorkerPool();

    const testFunc = workerPool.proxy('./test-worker', 'test');

    testFunc('test', 100)
      .then(() => {})
      .catch((err) => {});

    workerPool.recycle();

    const result = await testFunc('test', 100);

    workerPool.stop();

    assert.equal(result, 'test');
  });
});
