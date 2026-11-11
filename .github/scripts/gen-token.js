// Génère dist/token.json avec un Token Agora (007 / AccessToken2) valable 24 h
// en utilisant la variable secrète GitHub Actions AGORA_APP_CERTIFICATE.

const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const APP_ID = (process.env.AGORA_APP_ID || '7c0daed91de14d8d882b8110007de248').trim();
const APP_CERT = (process.env.AGORA_APP_CERTIFICATE || '').trim();
const CHANNEL = 'LePireDev';
const EXPIRE_SECONDS = 86400; // 24 h

if (!/^[0-9a-fA-F]{32}$/.test(APP_ID)) {
  console.error('Erreur: AGORA_APP_ID invalide.');
  process.exit(1);
}
if (!/^[0-9a-fA-F]{32}$/.test(APP_CERT)) {
  console.error('Erreur: Secret AGORA_APP_CERTIFICATE manquant ou invalide (doit faire 32 caractères hex).');
  process.exit(1);
}

class ByteBuf {
  constructor() {
    this.chunks = [];
  }
  putUint16(v) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v, 0);
    this.chunks.push(b);
    return this;
  }
  putUint32(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0, 0);
    this.chunks.push(b);
    return this;
  }
  putBytes(bytes) {
    this.putUint16(bytes.length);
    this.chunks.push(Buffer.from(bytes));
    return this;
  }
  putString(str) {
    return this.putBytes(Buffer.from(String(str), 'utf8'));
  }
  putTreeMapUInt32(map) {
    const keys = Object.keys(map).map(Number).sort((a, b) => a - b);
    this.putUint16(keys.length);
    for (const k of keys) {
      this.putUint16(k);
      this.putUint32(map[k]);
    }
    return this;
  }
  pack() {
    return Buffer.concat(this.chunks);
  }
}

function hmac(key, msg) {
  return crypto.createHmac('sha256', key).update(msg).digest();
}

function buildToken007(appId, appCert, channelName, uid, expire) {
  const issueTs = Math.floor(Date.now() / 1000);
  const salt = Math.floor(Math.random() * 99999999) + 1;

  let signing = hmac(new ByteBuf().putUint32(issueTs).pack(), Buffer.from(appCert, 'utf8'));
  signing = hmac(new ByteBuf().putUint32(salt).pack(), signing);

  const serviceRtc = new ByteBuf()
    .putUint16(1) // kRtcServiceType
    .putTreeMapUInt32({
      1: expire, // JoinChannel
      2: expire, // PublishAudioStream
      3: expire, // PublishVideoStream
      4: expire, // PublishDataStream
    })
    .putString(channelName)
    .putString(uid === 0 ? '' : String(uid))
    .pack();

  const signingInfo = Buffer.concat([
    new ByteBuf()
      .putString(appId)
      .putUint32(issueTs)
      .putUint32(expire)
      .putUint32(salt)
      .putUint16(1)
      .pack(),
    serviceRtc,
  ]);

  const signature = hmac(signing, signingInfo);
  const content = Buffer.concat([new ByteBuf().putBytes(signature).pack(), signingInfo]);
  const compressed = zlib.deflateSync(content);
  return '007' + compressed.toString('base64');
}

const token = buildToken007(APP_ID, APP_CERT, CHANNEL, 0, EXPIRE_SECONDS);

const outDir = path.join(process.cwd(), 'dist');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'token.json'),
  JSON.stringify({
    token,
    channel: CHANNEL,
    generatedAt: new Date().toISOString(),
    expiresIn: EXPIRE_SECONDS,
  })
);
console.log('token.json généré avec succès (valable 24 h).');
