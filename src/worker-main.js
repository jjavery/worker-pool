// This is the entrypoint for all workers

const { serializeError } = require('serialize-error');

// Keepalive
setInterval(() => {}, 2 ** 31 - 1);

// Handle requests from the worker pool
process.on('message', handleRequest);

function handleRequest(message) {
  const { id, modulePath, functionName, args } = message;

  const module = require(modulePath);

  const fn = module[functionName];

  if (!fn) {
    handleError(
      id,
      new Error(
        `Module "${modulePath}" doesn't export a function named "${functionName}"`
      )
    );
    return;
  }

  const resultOrPromise = fn(...args);

  Promise.resolve(resultOrPromise)
    .then((result) => {
      handleResult(id, result);
    })
    .catch((err) => {
      handleError(id, err);
    });
}

function handleResult(id, result) {
  process.send({ id, result });
}

function handleError(id, err) {
  process.send({ id, err: serializeError(err) });
}
