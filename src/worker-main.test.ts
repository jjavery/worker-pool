import { assert } from 'chai';
import { deserializeError } from 'serialize-error';
import { onSend, handleRequest } from './worker-main';

describe('worker-main', function () {
  it('handles a request', function (done) {
    onSend((message) => {
      if (message?.err != null) {
        return done(deserializeError(message.err));
      }

      assert.isNumber(message.id);
      assert.isString(message.result);

      done();
    });

    handleRequest({
      id: 0,
      modulePath: 'os',
      functionName: 'hostname'
    });
  });

  it("sends an error when a module can't be found", function (done) {
    onSend((message) => {
      assert.isObject(message.err);

      done();
    });

    handleRequest({
      id: 0,
      modulePath: '8bdc44c3-9549-473e-a99b-4898bdd01485',
      functionName: 'hostname'
    });
  });

  it("sends an error when a function can't be found", function (done) {
    onSend((message) => {
      assert.isObject(message.err);

      done();
    });

    handleRequest({
      id: 0,
      modulePath: 'os',
      functionName: '5f8df03c-87b9-414b-888e-73e67287686d'
    });
  });

  it('sends an error when a synchronous function throws an error', function (done) {
    onSend((message) => {
      assert.isObject(message.err);

      done();
    });

    handleRequest({
      id: 0,
      modulePath: `${__dirname}/test-worker`,
      functionName: 'throws'
    });
  });

  it('sends an error when an asynchronous function throws an error', function (done) {
    onSend((message) => {
      assert.isObject(message.err);

      done();
    });

    handleRequest({
      id: 0,
      modulePath: `${__dirname}/test-worker`,
      functionName: 'asyncThrows'
    });
  });
});
