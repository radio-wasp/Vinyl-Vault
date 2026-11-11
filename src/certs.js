const fs = require('fs');
const path = require('path');
const os = require('os');
const selfsigned = require('selfsigned');
const { DATA_DIR } = require('./db');

const CERTS_DIR = path.join(DATA_DIR, 'certs');
const KEY_PATH = path.join(CERTS_DIR, 'server.key');
const CERT_PATH = path.join(CERTS_DIR, 'server.crt');

function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const ips = ['127.0.0.1'];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

function ensureCertificates() {
  fs.mkdirSync(CERTS_DIR, { recursive: true });

  if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
    return {
      key: fs.readFileSync(KEY_PATH),
      cert: fs.readFileSync(CERT_PATH),
      ips: getLocalIpAddresses()
    };
  }

  const ips = getLocalIpAddresses();
  const altNames = [
    { type: 2, value: 'localhost' },
    ...ips.map(ip => ({ type: 7, ip }))
  ];

  const attrs = [{ name: 'commonName', value: 'VinylVault Local Scanner' }];
  const pems = selfsigned.generate(attrs, {
    algorithm: 'sha256',
    days: 3650,
    keySize: 2048,
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'subjectAltName', altNames }
    ]
  });

  fs.writeFileSync(KEY_PATH, pems.private);
  fs.writeFileSync(CERT_PATH, pems.cert);

  return {
    key: pems.private,
    cert: pems.cert,
    ips
  };
}

module.exports = {
  ensureCertificates,
  getLocalIpAddresses
};
