async function test(test, ms) {
  if (ms) { await wait(ms); }
  return test;
}

module.exports = {
  test
};

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
