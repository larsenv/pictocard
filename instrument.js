const Sentry = require('@sentry/node');

let config;
try {
  config = require('./config');
} catch {
  config = require('./config.example');
}

if (config.sentryDsn) {
  Sentry.init({
    dsn: config.sentryDsn,
    // Do not attach user IPs / request PII to error reports (minimal-data policy).
    sendDefaultPii: false
  });
}
