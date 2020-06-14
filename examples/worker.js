async function doSomeWork(work) {
  const ms = Math.floor(Math.random() * 1000);

  await wait(ms);

  return `[${process.pid}] Work "${work}" completed in ${ms}ms`;
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on('SIGTERM', () => {
  process.exit(0);
});

module.exports = {
  doSomeWork
};
