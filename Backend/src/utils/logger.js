/**
 * logger.js — central logging setup.
 *
 * Usage:
 *   const log = require('../utils/logger').child('cameras');
 *   log.info({ camera_id }, 'camera created');
 *   log.error({ err }, 'mediamtx addPath failed');
 *
 * Env vars:
 *   LOG_LEVEL   trace | debug | info | warn | error | fatal   (default: debug in dev, info in prod)
 *   LOG_PRETTY  '0' to force plain JSON logs even in dev
 *
 * In dev, logs are pretty-printed with colors + timestamps. In production
 * (NODE_ENV=production) they're single-line JSON so they can be shipped to
 * a log aggregator (CloudWatch, Loki, Datadog, etc.) and grepped/queried.
 */

'use strict';

const pino = require('pino');

const isProd = process.env.NODE_ENV === 'production';
const usePretty = process.env.LOG_PRETTY !== '0' && !isProd;

const baseLogger = pino({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  transport: usePretty
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'yyyy-mm-dd HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  // Pino errors don't serialize `err` objects by default — this makes
  // log.error({ err }, 'message') actually print the stack trace.
  serializers: { err: pino.stdSerializers.err },
});

/**
 * Get a child logger tagged with a module name, e.g. 'worker', 'mediamtx',
 * 'cameras'. Every line it logs will include { module: '<name>' } so you
 * can filter logs by subsystem when debugging.
 */
function getChild(moduleName) {
  // Call Pino's native child method directly via Object.getPrototypeOf
  const PinoProto = Object.getPrototypeOf(baseLogger);
  return PinoProto.child.call(baseLogger, { module: moduleName });
}

module.exports = baseLogger;
module.exports.child = getChild;
