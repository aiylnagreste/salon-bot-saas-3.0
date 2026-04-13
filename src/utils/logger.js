function timestamp() {
  return new Date().toISOString();
}

const logger = {
  info(...args) {
    console.log(`[${timestamp()}] INFO`, ...args);
  },
  error(...args) {
    console.error(`[${timestamp()}] ERROR`, ...args);
  },
  warn(...args) {
    console.warn(`[${timestamp()}] WARN`, ...args);
  },
  debug(...args) {
    // Only log debug messages if DEBUG env var is set to true
    if (process.env.DEBUG === 'true') {
      console.log(`[${timestamp()}] DEBUG`, ...args);
    }
  },
};

module.exports = logger ;