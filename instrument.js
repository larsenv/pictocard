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
    sendDefaultPii: false,
    // A client dropping its connection mid-upload is not a server bug.
    beforeSend(event, hint) {
      const err = hint && hint.originalException;
      if (err && err.message === 'Request aborted') return null;
      return event;
    }
  });
}
