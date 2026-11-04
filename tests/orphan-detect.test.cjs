const test = require('node:test');
const assert = require('node:assert/strict');
const { findPossibleOrphans } = require('../electron/orphan-detect.cjs');

function netstat(outputs, calls = []) {
  return (file, args, options, callback) => {
    calls.push({ file, args, options });
    const protocol = args[2];
    const response = outputs[protocol];
    if (response instanceof Error) return callback(response, '', '');
    callback(null, response ?? '', '');
  };
}

const occupied = (id, port, pid) => ({ id, pid, port, reason: 'UDP port occupied (process identity unverified)' });
const ambiguous = (id, port) => ({ id, pid: null, port, reason: 'UDP port occupied (ambiguous PID; process identity unverified)' });

test('detects IPv4 and bracketed IPv6 wildcard and specific-address UDP sockets only by local port', async () => {
  const calls = [];
  const execFile = netstat({
    udp: [
      'Active Connections',
      '  Proto  Local Address          Foreign Address        PID',
      '  UDP    0.0.0.0:28960          *:*                    1234',
      '  UDP    192.168.1.8:27015     *:*                    4321',
      '  TCP    0.0.0.0:30100         0.0.0.0:0              LISTENING      9999',
      '  UDP    127.0.0.1:27012      *:*                    5555',
    ].join('\r\n'),
    udpv6: '  UDP    [::]:27016            *:*                    7890\r\n' +
      '  UDP    [fe80::abcd%12]:27017 *:*                    6789\r\n',
  }, calls);
  const games = [
    { id: 'cod4', port: 28960, gamePath: 'C:\\irrelevant\\game' },
    { id: 'mw2', port: 27015 }, { id: 'bo2', port: 27016 },
    { id: 'waw', port: 27017 }, { id: 'bo1', port: 27012 },
    { id: 'unused', port: 30100 },
  ];
  assert.deepEqual(await findPossibleOrphans(games, { execFile }), [
    occupied('cod4', 28960, 1234), occupied('mw2', 27015, 4321),
    occupied('bo2', 27016, 7890), occupied('waw', 27017, 6789),
    occupied('bo1', 27012, 5555),
  ]);
  assert.deepEqual(calls.map(({ file, args }) => [file, args]), [
    ['netstat.exe', ['-ano', '-p', 'udp']], ['netstat.exe', ['-ano', '-p', 'udpv6']],
  ]);
  for (const { options } of calls) {
    assert.equal(options.windowsHide, true);
    assert.ok(options.timeout > 0 && options.timeout <= 7000);
    assert.ok(options.maxBuffer > 0 && options.maxBuffer <= 3_000_000);
  }
});

test('deduplicates identical sockets across families and repeated candidates; never attributes ownership from gamePath', async () => {
  const row = ' UDP  0.0.0.0:27016  *:*  4000\n';
  const execFile = netstat({ udp: row + row, udpv6: row + ' UDP  [::]:27016  *:*  4000\n' });
  assert.deepEqual(await findPossibleOrphans([
    { id: 'mw3', port: 27016, gamePath: 'D:\\MW3' },
    { id: 'mw3', port: 27016 }, { id: 'other', port: 27016, gamePath: 'X:\\NotMW3' },
  ], { execFile }), [occupied('mw3', 27016, 4000), occupied('other', 27016, 4000)]);
});

test('multiple distinct PIDs or missing, zero, or malformed PIDs are ambiguous', async () => {
  const execFile = netstat({
    udp: [
      ' UDP  0.0.0.0:27016  *:*  4000',
      ' UDP  127.0.0.1:27016  *:*  5000',
      ' UDP  0.0.0.0:28960  *:*  0',
      ' UDP  0.0.0.0:27015  *:*  -',
      ' UDP  0.0.0.0:27017  *:*',
      ' UDP  0.0.0.0:27018  *:*  88',
    ].join('\n'),
    udpv6: ' UDP  [::]:27018  *:*  ?\n',
  });
  assert.deepEqual(await findPossibleOrphans([27016, 28960, 27015, 27017, 27018].map(port => ({ id: String(port), port })),
    { execFile }), [27016, 28960, 27015, 27017, 27018].map(port => ambiguous(String(port), port)));
});

test('one failed family leaves observed occupancy ambiguous; both failed do not imply a free port', async () => {
  const one = netstat({ udp: new Error('netstat failed'), udpv6: ' UDP [::]:27016 *:* 1234\n' });
  assert.deepEqual(await findPossibleOrphans([{ id: 'bo2', port: 27016 }], { execFile: one }), [ambiguous('bo2', 27016)]);
  const none = netstat({ udp: new Error('ENOENT'), udpv6: new Error('ENOENT') });
  assert.deepEqual(await findPossibleOrphans([{ id: 'bo2', port: 27016 }], { execFile: none }), []);
  const throws = () => { throw new Error('unavailable'); };
  assert.deepEqual(await findPossibleOrphans([{ id: 'bo2', port: 27016 }], { execFile: throws }), []);
});

test('oversized output and malformed input cannot produce invented findings', async () => {
  const huge = netstat({ udp: ' UDP 0.0.0.0:27016 *:* 1234\n' + ' '.repeat(3_000_000), udpv6: '' });
  assert.deepEqual(await findPossibleOrphans([{ id: 'mw3', port: 27016 }], { execFile: huge }), []);
  const calls = [];
  assert.deepEqual(await findPossibleOrphans([{ id: 'bad', port: -1 }, { id: 1, port: 27016 }],
    { execFile: netstat({}, calls) }), []);
  assert.deepEqual(calls, []);
  assert.deepEqual(await findPossibleOrphans([], { execFile: netstat({}, calls) }), []);
});
