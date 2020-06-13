async function test(test, ms) {
  if (ms) { await wait(ms); }
  return test;
}

function exit() {
  process.exit();
}

module.exports = {
  test,
  exit
};

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
