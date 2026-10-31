// Which IPv4 address of the Docker host reaches the native model server? (Install-CrestmontRunner.ps1, step 7.)
// Usage: node host-gateway-probe.cjs <port> <name> [<name> ...]
// For each name: resolve its IPv4 addresses only (getaddrinfo, /etc/hosts first), then try a TCP connect to <port>.
// Prints one JSON line: { port, candidates: [{ name, address, reachable, error }] }. Exit 0 even when nothing is
// reachable; the installer decides (OllamaProbe.ps1, Select-CrestmontHostGatewayIPv4).
//
// Why IPv4 only: on Docker Desktop with dual-stack networking, host-gateway / host.docker.internal also have an IPv6
// address. The egress proxy's internal networks are IPv4-only, so Squid's CONNECT to that IPv6 address fails with
// ERR_CONNECT_FAIL 101 (network unreachable), which is what Node 1 showed. The installer pins host.docker.internal
// to the IPv4 address found here, so the proxy never sees the IPv6 one.
// The installer mounts this file read-only into a throw-away runner container; it sends nothing but a TCP SYN.
'use strict';
const dns = require('node:dns');
const net = require('node:net');

const [portArg, ...names] = process.argv.slice(2);
const port = Number(portArg);
if (!Number.isInteger(port) || port < 1 || port > 65535 || names.length === 0) {
  console.error('usage: node host-gateway-probe.cjs <port> <name> [<name> ...]');
  process.exit(2);
}

function lookup4(name) {
  return new Promise((resolve) => dns.lookup(name, { family: 4, all: true }, (err, list) => resolve(err ? { error: err.code || String(err) } : { addresses: list.map((a) => a.address) })));
}
function connect(address) {
  return new Promise((resolve) => {
    const s = net.connect({ host: address, port, family: 4 });
    const done = (reachable, error) => { s.destroy(); resolve({ reachable, error }); };
    s.setTimeout(4000, () => done(false, 'ETIMEDOUT'));
    s.once('connect', () => done(true, null));
    s.once('error', (e) => done(false, e.code || String(e)));
  });
}

(async () => {
  const candidates = [];
  for (const name of names) {
    const r = await lookup4(name);
    if (r.error) { candidates.push({ name, address: null, reachable: false, error: r.error }); continue; }
    for (const address of [...new Set(r.addresses)]) candidates.push({ name, address, ...(await connect(address)) });
  }
  console.log(JSON.stringify({ port, candidates }));
})();
