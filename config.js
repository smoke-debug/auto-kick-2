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
    // Gap between each DM send (ms). 1200 = ~50 DMs/min, very safe.
    // Lower = faster processing but higher rate limit risk.
    dmDelay:   parseInt(process.env.DM_DELAY || '1200', 10),
  };
}

module.exports = getConfig;
