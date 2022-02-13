// This is the entrypoint for all workers
const { serializeError } = require('serialize-error');

// If module has been executed directly
if (require.main === module && process.send != null) {
  // Keepalive
  setInterval(() => {}, 2 ** 31 - 1);

  // Handle requests from the worker pool
  process.on('message', handleRequest);

  // Inform the worker pool that this worker is ready
  process.send('ready');
}

function handleRequest(message) {
  const { id, modulePath, functionName, args = [] } = message;

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

  let resultOrPromise;

  try {
    resultOrPromise = fn(...args);
  } catch (err) {
    handleError(id, err);
    return;
  }

  Promise.resolve(resultOrPromise)
    .then((result) => {
      handleResult(id, result);
    })
    .catch((err) => {
      handleError(id, err);
    });
}

function handleResult(id, result) {
  const message = { id, result };

  send(message);
}

function handleError(id, err) {
  const message = { id, err: serializeError(err) };

  send(message);
}

function send(message) {
  if (handleSend != null) {
    handleSend(message);
  } else {
    if (process.send == null) return;
    process.send(message);
  }
}

let handleSend;

function onSend(handler) {
  handleSend = handler;
}

// Entrypoint for testing
module.exports = {
  handleRequest,
  onSend
}
