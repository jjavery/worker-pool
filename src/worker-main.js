// This is the entrypoint for all workers

const { serializeError } = require('serialize-error');

// Keepalive
setInterval(() => {}, 2 ** 31 - 1);

// Handle requests from the worker pool
process.on('message', handleRequest);

// Inform the worker pool that this worker is ready
process.send('ready');

function handleRequest(message) {
  const { id, modulePath, functionName, args } = message;

  let module;

  try {
    module = require(modulePath);
  } catch (err) {
    handleError(id, err);
    return;
  }

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
