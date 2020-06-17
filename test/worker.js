const { assert } = require('chai');
const Worker = require('../src/worker');

describe('Worker', function () {
  it('creates a worker', async function () {
    const worker = new Worker();

    assert.instanceOf(worker, Worker);
  });

  it('starts a worker', async function () {
    const worker = new Worker();

    await worker.start();

    try {
      assert.isNumber(worker.pid);
    } catch (err) {
      throw err;
    } finally {
      await worker.stop();
    }
  });

  it('stops a worker', async function () {
    const worker = new Worker();

    await worker.start();

    await worker.stop();

    assert.isNull(worker.pid);
  });

  it('sends a request to a worker and receives a result', async function () {
    const worker = new Worker();

    await worker.start();

    const result = await worker.request({
      modulePath: 'os',
      functionName: 'hostname'
    });

    await worker.stop();

    assert.isString(result);
  });
});
