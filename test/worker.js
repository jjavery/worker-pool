const { assert } = require('chai');
const Worker = require('../src/worker');

describe('Worker', function () {
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
