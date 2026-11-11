// Cloudflare Worker — génère un Token Agora (AccessToken2 / 007) valable 24 h
// à partir du Primary Certificate stocké en variable secrète sur Cloudflare.
//
// Variables à définir dans le Worker (Settings > Variables and Secrets) :
//   AGORA_APP_ID           (Text)   -> 7c0daed91de14d8d882b8110007de248
//   AGORA_APP_CERTIFICATE  (Secret) -> votre Primary Certificate Agora

const ALLOWED_ORIGINS = [
  'https://naelvuille.github.io',
];

const DEFAULT_CHANNEL = 'LePireDev';
const TOKEN_TTL = 86400; // 24 h (couvre largement une journée de 12 h)

// ==================== ByteBuf (little-endian) ====================
class ByteBuf {
  constructor() {
    this.buf = new Uint8Array(512);
    this.view = new DataView(this.buf.buffer);
    this.pos = 0;
  }
  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.pos + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }
  putUint16(v) {
    this.ensure(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
    return this;
  }
  putUint32(v) {
    this.ensure(4);
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
    return this;
  }
  putBytes(bytes) {
    this.putUint16(bytes.length);
    this.ensure(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
    return this;
  }
  putString(str) {
    return this.putBytes(new TextEncoder().encode(str));
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
    return this.buf.slice(0, this.pos);
  }
}

async function hmacSha256(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, msgBytes);
  return new Uint8Array(sig);
}

async function deflateZlib(bytes) {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

function uint8ToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

async function buildAgoraRtcToken(appId, appCertificate, channelName, uid, expireSeconds) {
  const issueTs = Math.floor(Date.now() / 1000);
  const salt = Math.floor(Math.random() * 99999999) + 1;

  const certBytes = new TextEncoder().encode(appCertificate);
  let signing = await hmacSha256(new ByteBuf().putUint32(issueTs).pack(), certBytes);
  signing = await hmacSha256(new ByteBuf().putUint32(salt).pack(), signing);

  // ServiceRtc (type = 1) avec privilèges Publisher (Join, Audio, Video, DataStream)
  const service = new ByteBuf()
    .putUint16(1)
    .putTreeMapUInt32({
      1: expireSeconds,
      2: expireSeconds,
      3: expireSeconds,
      4: expireSeconds,
    })
    .putString(channelName)
    .putString(uid === 0 ? '' : String(uid))
    .pack();

  const signingInfo = new ByteBuf()
    .putString(appId)
    .putUint32(issueTs)
    .putUint32(expireSeconds)
    .putUint32(salt)
    .putUint16(1)
    .pack();

  const fullSigningInfo = new Uint8Array(signingInfo.length + service.length);
  fullSigningInfo.set(signingInfo, 0);
  fullSigningInfo.set(service, signingInfo.length);

  const signature = await hmacSha256(signing, fullSigningInfo);
  const sigWrapped = new ByteBuf().putBytes(signature).pack();

  const content = new Uint8Array(sigWrapped.length + fullSigningInfo.length);
  content.set(sigWrapped, 0);
  content.set(fullSigningInfo, sigWrapped.length);

  const compressed = await deflateZlib(content);
  return '007' + uint8ToBase64(compressed);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);

    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (!allowed) {
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    if (!env.AGORA_APP_ID || !env.AGORA_APP_CERTIFICATE) {
      return new Response(JSON.stringify({ error: 'missing_agora_env' }), {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(request.url);
    const channel = url.searchParams.get('channel') || DEFAULT_CHANNEL;
    const uid = Number(url.searchParams.get('uid') || 0);

    const token = await buildAgoraRtcToken(
      env.AGORA_APP_ID.trim(),
      env.AGORA_APP_CERTIFICATE.trim(),
      channel,
      uid,
      TOKEN_TTL
    );

    return new Response(JSON.stringify({ token, channel, expiresIn: TOKEN_TTL }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  },
};
