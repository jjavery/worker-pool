const { assert } = require('chai');
const WorkerPool = require('../src/worker-pool');

describe('WorkerPool', async () => {
  it('execues a function exported by a worker module', async () => {
    const workerPool = new WorkerPool();

    const result = await workerPool.exec('./test-worker', 'test', 'test', 100);

    workerPool.stop();

    assert.equal(result, 'test');
  });

  it('proxies a function exported by a worker module', async () => {
    const workerPool = new WorkerPool();

    const test = workerPool.proxy('./test-worker', 'test');

    const result = await test('test');

    workerPool.stop();

    assert.equal(result, 'test');
  });

  it.only('properly handles child processes that exit unexpectedly', async () => {
    const workerPool = new WorkerPool();

    const exit = workerPool.proxy('./test-worker', 'exit');

    try {
      const result = await exit();
    } catch (err) {
      assert.isNotNull(err);
    }

    const test = workerPool.proxy('./test-worker', 'test');

    const result = await test('test');

    workerPool.stop();

    assert.equal(result, 'test');
  });

});
