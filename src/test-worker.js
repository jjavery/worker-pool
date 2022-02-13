function test(test) {
  return test;
}

async function asyncTest(test, ms) {
  if (ms) {
    await wait(ms);
  }

  return test;
}

function exit() {
  process.exit();
}

async function asyncExit(ms) {
  if (ms) {
    await wait(ms);
  }

  process.exit();
}

function throws() {
  throw new Error('test-error');
}

async function asyncThrows(ms) {
  if (ms) {
    await wait(ms);
  }

  throw new Error('test-error');
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  test,
  asyncTest,
  exit,
  asyncExit,
  throws,
  asyncThrows
};
