import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Logger, LOG_LEVELS } from '../../src/utils/logger.js';
import { clearSecrets, registerSecret } from '../../src/utils/redact.js';

/** Collects log lines instead of writing to stdout. */
function capture(options = {}) {
  const lines = [];
  const records = [];
  const logger = new Logger({
    name: 'test',
    level: 'trace',
    format: 'json',
    sink: (line, record) => {
      lines.push(line);
      records.push(record);
    },
    ...options,
  });
  return { logger, lines, records };
}

describe('logger', () => {
  test('emits one JSON record per line with ts, level, name and msg', () => {
    const { logger, lines, records } = capture();
    logger.info('hello world', { guildId: '42' });

    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.level, 'info');
    assert.equal(parsed.name, 'test');
    assert.equal(parsed.msg, 'hello world');
    assert.equal(parsed.guildId, '42');
    assert.ok(parsed.ts);
    assert.equal(records[0].msg, 'hello world');
  });

  test('respects the minimum level', () => {
    const { logger, lines } = capture({ level: 'warn' });
    logger.debug('hidden');
    logger.info('hidden too');
    logger.warn('shown');
    logger.error('also shown');
    assert.equal(lines.length, 2);
  });

  test('isLevelEnabled reflects the configured level', () => {
    const { logger } = capture({ level: 'error' });
    assert.equal(logger.isLevelEnabled('error'), true);
    assert.equal(logger.isLevelEnabled('fatal'), true);
    assert.equal(logger.isLevelEnabled('info'), false);
    assert.equal(LOG_LEVELS.fatal, 60);
  });

  test('child loggers inherit bindings and scope the name', () => {
    const { logger, records } = capture();
    const child = logger.child('commands').child({ command: 'ping' });
    assert.equal(child.name, 'test:commands');
    child.info('executed');
    assert.equal(records[0].command, 'ping');
  });

  test('redacts secrets before writing', () => {
    clearSecrets();
    registerSecret('MTA-token-value-that-is-long');
    const { logger, lines } = capture();
    logger.info('boot', { token: 'MTA-token-value-that-is-long', note: 'see MTA-token-value-that-is-long' });

    const line = lines[0];
    assert.ok(!line.includes('MTA-token-value-that-is-long'), line);
    assert.ok(line.includes('[REDACTED]'));
    clearSecrets();
  });

  test('errorFrom includes the error name, message and a truncated stack', () => {
    const { logger, records } = capture();
    logger.errorFrom(new Error('kaboom'), 'command failed', { command: 'ping' });
    assert.equal(records[0].level, 'error');
    assert.equal(records[0].errorMessage, 'kaboom');
    assert.equal(records[0].command, 'ping');
    assert.ok(records[0].stack.split('\n').length <= 8);
  });

  test('keeps a bounded ring buffer for /health debugging', () => {
    const { logger, lines } = capture({ maxBuffered: 5 });
    for (let i = 0; i < 12; i += 1) logger.info(`line ${i}`);
    assert.equal(lines.length, 12, 'every record is still emitted to the sink');
    assert.equal(logger.records.length, 5, 'but only the newest ones are buffered in memory');
    assert.equal(logger.recent(1)[0].msg, 'line 11');
    assert.equal(logger.recent(10)[0].msg, 'line 7');
  });

  test('a child logger shares the parent ring buffer', () => {
    const { logger } = capture({ maxBuffered: 4 });
    logger.child('a').info('from child');
    logger.info('from parent');
    assert.equal(logger.records.length, 2);
    assert.equal(logger.records[0].name, 'test:a');
  });

  test('pretty format produces a readable single line', () => {
    const { logger, lines } = capture({ format: 'pretty', color: false });
    logger.warn('careful', { key: 'value' });
    assert.match(lines[0], /WARN\s+\[test\] careful key=value/);
  });

  test('configure() can change level and format at runtime', () => {
    const { logger, lines } = capture({ level: 'error' });
    logger.info('hidden');
    logger.configure({ level: 'info' });
    logger.info('visible');
    assert.equal(lines.length, 1);
  });
});
