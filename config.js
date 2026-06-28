require('dotenv').config();

function getConfig() {
  const missing = ['DISCORD_TOKEN', 'CLIENT_ID'].filter(k => !process.env[k]);
  if (missing.length) {
    console.error('\n❌  Missing required env vars:', missing.join(', '));
    console.error('    Set them in Railway → Variables tab.\n');
    process.exit(1);
  }
  return {
    token:     process.env.DISCORD_TOKEN,
    clientId:  process.env.CLIENT_ID,
    storeUrl:  process.env.STORE_URL  || 'https://example.com',
    bannerUrl: process.env.BANNER_URL || null,
    iconUrl:   process.env.ICON_URL   || null,
    brandName: process.env.BRAND_NAME || 'Smoke - SmokeURLs',
    // DMs are OFF by default to prevent Discord quarantine.
    // Set SEND_DMS=true in Railway once your bot is unquarantined.
    sendDMs:   process.env.SEND_DMS === 'true',
  };
}

module.exports = getConfig;
