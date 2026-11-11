// Génère dist/token.json avec le package officiel agora-token (valable 24 h)
const fs = require('fs');
const path = require('path');
const { RtcTokenBuilder, RtcRole } = require('agora-token');

const APP_ID = (process.env.AGORA_APP_ID || '7c0daed91de14d8d882b8110007de248').trim();
const APP_CERT = (process.env.AGORA_APP_CERTIFICATE || '').trim();
const CHANNEL = 'LePireDev';
const EXPIRE_SECONDS = 86400; // 24 h

if (!/^[0-9a-fA-F]{32}$/.test(APP_ID)) {
  console.error('Erreur: AGORA_APP_ID invalide.');
  process.exit(1);
}
if (!/^[0-9a-fA-F]{32}$/.test(APP_CERT)) {
  console.error('Erreur: Secret AGORA_APP_CERTIFICATE manquant ou invalide.');
  process.exit(1);
}

const token = RtcTokenBuilder.buildTokenWithUid(
  APP_ID,
  APP_CERT,
  CHANNEL,
  0,
  RtcRole.PUBLISHER,
  EXPIRE_SECONDS,
  EXPIRE_SECONDS
);

if (!token) {
  console.error('Erreur: token vide généré par agora-token.');
  process.exit(1);
}

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
console.log('token.json généré avec succès via agora-token (valable 24 h).');
