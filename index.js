const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, PermissionsBitField, ChannelType,
  Partials, REST, Routes, SlashCommandBuilder, Events,
} = require('discord.js');

const getConfig = require('./config');
const db        = require('./data');

db.load();
const cfg  = getConfig();
const rest = new REST({ version: '10' }).setToken(cfg.token);

console.log(`📬  DMs: ${cfg.sendDMs ? 'ENABLED' : 'DISABLED (set SEND_DMS=true in Railway to enable)'}`);

// ── Client ────────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ── Vanity cache — fetch once per guild, not on every join ───────────────────

const vanityCache = new Map(); // guildId → code | null

async function getVanity(guild) {
  if (vanityCache.has(guild.id)) return vanityCache.get(guild.id);
  try {
    const code = (await guild.fetchVanityData()).code || null;
    vanityCache.set(guild.id, code);
    return code;
  } catch {
    vanityCache.set(guild.id, null);
    return null;
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

const COMMANDS = [
  new SlashCommandBuilder()
    .setName('whitelist').setDescription('Manage authorized users').setDefaultMemberPermissions(8)
    .addSubcommand(s => s.setName('add').setDescription('Authorize a user — they will not be kicked')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('Revoke authorization')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('View all authorized users')),

  new SlashCommandBuilder()
    .setName('gate').setDescription('Control the auto-kick gate').setDefaultMemberPermissions(8)
    .addSubcommand(s => s.setName('on').setDescription('Enable gate globally + sweep unauthorized members now'))
    .addSubcommand(s => s.setName('off').setDescription('Disable gate for ALL servers'))
    .addSubcommand(s => s.setName('status').setDescription('Show gate state per server'))
    .addSubcommand(s => s.setName('reset').setDescription('Force gate ON, clear all exceptions, sweep all servers'))
    .addSubcommand(s => s.setName('sweep').setDescription('Manually kick all unauthorized members in active servers right now'))
    .addSubcommandGroup(g => g.setName('server').setDescription('Per-server gate control')
      .addSubcommand(s => s.setName('add').setDescription('Turn gate off for specific servers')
        .addStringOption(o => o.setName('ids').setDescription('Comma-separated server IDs — blank = current server').setRequired(false)))
      .addSubcommand(s => s.setName('remove').setDescription('Re-enable gate for a server + sweep it')
        .addStringOption(o => o.setName('id').setDescription('Server ID — blank = current server').setRequired(false)))
      .addSubcommand(s => s.setName('list').setDescription('List all servers with gate off'))
      .addSubcommand(s => s.setName('clear').setDescription('Remove all per-server exceptions'))),

  new SlashCommandBuilder()
    .setName('setlog').setDescription('Set the kick log channel').setDefaultMemberPermissions(8)
    .addChannelOption(o => o.setName('channel').setDescription('Text channel').addChannelTypes(ChannelType.GuildText).setRequired(true)),

  new SlashCommandBuilder()
    .setName('setboostchannel').setDescription('Set the boost alert channel').setDefaultMemberPermissions(8)
    .addChannelOption(o => o.setName('channel').setDescription('Text channel').addChannelTypes(ChannelType.GuildText).setRequired(true)),

  new SlashCommandBuilder()
    .setName('boosts').setDescription('View boost status for every server').setDefaultMemberPermissions(8),

  new SlashCommandBuilder()
    .setName('setinvite').setDescription('Set the invite link shown in kick DMs').setDefaultMemberPermissions(8)
    .addStringOption(o => o.setName('url').setDescription('Full URL e.g. https://discord.gg/xxx').setRequired(true)),

  new SlashCommandBuilder()
    .setName('setcontact').setDescription('Set the contact tag shown in kick DMs').setDefaultMemberPermissions(8)
    .addStringOption(o => o.setName('tag').setDescription('e.g. @nudities').setRequired(true)),

  new SlashCommandBuilder()
    .setName('vanitystats').setDescription('Show join/kick counts per vanity URL').setDefaultMemberPermissions(8)
    .addStringOption(o => o.setName('vanity').setDescription('Filter to one vanity — blank for all').setRequired(false)),

  new SlashCommandBuilder()
    .setName('linkstats').setDescription('Show invite link use stats').setDefaultMemberPermissions(8),

  new SlashCommandBuilder()
    .setName('log').setDescription('View or reset statistics').setDefaultMemberPermissions(8)
    .addSubcommand(s => s.setName('stats').setDescription('Full statistics dashboard'))
    .addSubcommand(s => s.setName('reset').setDescription('Reset all stats to zero')),

  new SlashCommandBuilder()
    .setName('config').setDescription('View current bot configuration').setDefaultMemberPermissions(8),

  new SlashCommandBuilder()
    .setName('help').setDescription('Show all available commands').setDefaultMemberPermissions(8),

].map(c => c.toJSON());

// ── Command sync — batched to avoid rate limits ───────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function syncToGuild(guild) {
  try {
    await rest.put(Routes.applicationGuildCommands(cfg.clientId, guild.id), { body: COMMANDS });
    return true;
  } catch (err) {
    console.error(`⚠️  Sync failed → ${guild.name}: ${err.message}`);
    return false;
  }
}

async function syncAllGuilds() {
  const guilds = [...client.guilds.cache.values()];
  console.log(`🔄  Syncing commands to ${guilds.length} guild(s)...`);
  let ok = 0;
  for (let i = 0; i < guilds.length; i += 5) {
    const batch   = guilds.slice(i, i + 5);
    const results = await Promise.allSettled(batch.map(syncToGuild));
    ok += results.filter(r => r.status === 'fulfilled' && r.value).length;
    if (i + 5 < guilds.length) await sleep(1000);
  }
  console.log(`✅  Commands synced to ${ok}/${guilds.length} guilds`);
}

// ── Log channel ───────────────────────────────────────────────────────────────

async function postLog(embed) {
  const id = db.getLogChannel();
  if (!id) return;
  try {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (ch) await ch.send({ embeds: [embed] });
  } catch {}
}

function statsFooter() {
  const s = db.getStats();
  return `Total Joined: ${s.totalJoins}  •  Total Kicked: ${s.successfulKicks}`;
}

// ── DM embed (only used when SEND_DMS=true) ───────────────────────────────────

function buildDMEmbed(guildName, vanityCode) {
  const link = db.getInviteLink();
  const tag  = db.getContactTag();
  const v    = vanityCode ? `\`/${vanityCode}\`` : `\`${guildName}\``;
  const cta  = tag  ? `Join here or contact **${tag}**` : `Use the button below to join`;
  const body = link ? `${cta}\n\n${link}` : cta;
  const e    = new EmbedBuilder().setColor(0x0d0d1a).setDescription(`### Looking to buy ${v}?\n\n${body}`).setTimestamp();
  if (cfg.bannerUrl) e.setImage(cfg.bannerUrl);
  cfg.iconUrl
    ? e.setAuthor({ name: cfg.brandName, iconURL: cfg.iconUrl, url: link || cfg.storeUrl })
    : e.setAuthor({ name: cfg.brandName, url: link || cfg.storeUrl });
  return e;
}

function buildDMRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Join Server').setStyle(ButtonStyle.Link).setURL(db.getInviteLink() || cfg.storeUrl).setEmoji('🔗')
  );
}

// ── Sweep ─────────────────────────────────────────────────────────────────────

async function sweepGuild(guild) {
  if (!db.isGateActive(guild.id)) return { kicked: 0, failed: 0 };

  let kicked = 0, failed = 0;
  try {
    const members = await guild.members.fetch();
    const targets = [...members.values()].filter(m =>
      !m.user.bot && m.id !== client.user.id && !db.isAuthorized(m.user.id)
    );

    if (!targets.length) return { kicked: 0, failed: 0 };

    console.log(`🧹  ${guild.name}: sweeping ${targets.length} unauthorized member(s)`);
    const vanity = await getVanity(guild);

    for (const member of targets) {
      try {
        await member.kick('Gate sweep — unauthorized');
        kicked++;
        db.increment('successfulKicks');
        db.incrementVanityKick(vanity);
        console.log(`🧹  Swept: ${member.user.tag}`);

        // Send DM after kick if enabled
        if (cfg.sendDMs) {
          try {
            await member.user.send({ embeds: [buildDMEmbed(guild.name, vanity)], components: [buildDMRow()] });
            db.increment('dmsSent');
          } catch { db.increment('dmsFailed'); }
        }
      } catch (err) {
        failed++;
        console.error(`🧹  Sweep kick failed ${member.user.tag}: ${err.message}`);
      }
      await sleep(1500); // 1.5s between sweep kicks — well within rate limits
    }
  } catch (err) {
    console.error(`⚠️  sweepGuild error in ${guild.name}: ${err.message}`);
  }
  return { kicked, failed };
}

async function sweepAll() {
  const guilds = [...client.guilds.cache.values()].filter(g => db.isGateActive(g.id));
  if (!guilds.length) return;
  console.log(`🧹  Sweeping ${guilds.length} active guild(s)...`);
  let tk = 0, tf = 0;
  for (const guild of guilds) {
    const { kicked, failed } = await sweepGuild(guild);
    tk += kicked; tf += failed;
    await sleep(500);
  }
  console.log(`🧹  Sweep done — ${tk} kicked, ${tf} failed`);
  await postLog(new EmbedBuilder()
    .setColor(tk > 0 ? 0xff4444 : 0x00cc66)
    .setTitle('🧹 Gate Sweep Complete')
    .setDescription(tk > 0 ? `Removed ${tk} unauthorized member${tk !== 1 ? 's' : ''} across ${guilds.length} server${guilds.length !== 1 ? 's' : ''}.` : 'No unauthorized members found.')
    .addFields(
      { name: '✅ Kicked',  value: `\`${tk}\``,           inline: true },
      { name: '❌ Failed',  value: `\`${tf}\``,           inline: true },
      { name: '🏰 Servers', value: `\`${guilds.length}\``, inline: true },
    ).setTimestamp());
}

// ── Boost helpers ─────────────────────────────────────────────────────────────

const TIER_NAMES  = ['No Level', 'Level 1', 'Level 2', 'Level 3'];
const TIER_EMOJI  = ['⬜', '🟣', '💜', '✨'];
const TIER_THRESH = [0, 2, 7, 14];

function getBoostInfo(guild) {
  const count = guild.premiumSubscriptionCount || 0;
  const tier  = guild.premiumTier              || 0;
  const next  = tier < 3 ? TIER_THRESH[tier + 1] : null;
  return { count, tier, next, needed: next ? next - count : 0, emoji: TIER_EMOJI[tier], name: TIER_NAMES[tier] };
}

function progBar(cur, max, len = 10) {
  if (!max) return '░'.repeat(len);
  const f = Math.min(len, Math.round((cur / max) * len));
  return '▓'.repeat(f) + '░'.repeat(len - f);
}

function buildBoostsEmbed(sorted, page, totalPages) {
  const slice = sorted.slice(page * 8, (page + 1) * 8);
  const total = sorted.reduce((s, g) => s + (g.premiumSubscriptionCount || 0), 0);
  const tiers = [0, 0, 0, 0]; sorted.forEach(g => tiers[g.premiumTier || 0]++);
  const embed = new EmbedBuilder().setColor(0xf47fff).setTitle('🚀 Server Boost Status')
    .setDescription(`**${sorted.length}** servers  •  **${total}** total boosts\n✨ ${tiers[3]} L3  •  💜 ${tiers[2]} L2  •  🟣 ${tiers[1]} L1  •  ⬜ ${tiers[0]} none\nPage **${page + 1} / ${totalPages}**`)
    .setTimestamp();
  for (const g of slice) {
    const { count, tier, next, needed, emoji, name } = getBoostInfo(g);
    const gn = g.name.length > 35 ? g.name.slice(0, 32) + '...' : g.name;
    embed.addFields({ name: gn, inline: false, value: next !== null
      ? `${emoji} **${name}** — **${count}** boost${count !== 1 ? 's' : ''}\n\`[${progBar(count, next)}]\` ${count}/${next} → Level ${tier + 1} (+${needed})`
      : `✨ **Level 3 (Max)** — **${count}** boosts` });
  }
  return embed;
}

function buildBoostsRow(page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`bp_${page - 1}`).setLabel('◀  Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId('bm').setLabel(`${page + 1} / ${totalPages}`).setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId(`bn_${page + 1}`).setLabel('Next  ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
  );
}

async function sendBoostAlert(embed) {
  const id = db.getBoostChannelId() || db.getLogChannel();
  if (!id) return;
  try { const ch = await client.channels.fetch(id).catch(() => null); if (ch) await ch.send({ embeds: [embed] }); } catch {}
}

// ── Misc helpers ──────────────────────────────────────────────────────────────

function formatDate(iso) { return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); }
function guildLabel(id)  { const g = client.guilds.cache.get(String(id)); return g ? `**${g.name}** (\`${id}\`)` : `\`${id}\``; }
function parseIds(raw)   { return (raw || '').split(',').map(s => s.trim()).filter(s => /^\d{10,20}$/.test(s)); }

async function fetchInviteUses(url) {
  const m = (url || '').match(/(?:discord\.gg|discord\.com\/invite)\/([a-zA-Z0-9-]+)/);
  if (!m) return null;
  try { return (await client.fetchInvite(m[1])).uses ?? null; } catch { return null; }
}

// ── Ready ─────────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async () => {
  console.log(`\n✅  Online as ${client.user.tag}`);
  console.log(`🛡️  Gate: ${db.getGate() ? 'ON' : 'OFF'} | Exceptions: ${db.getGateExceptions().size} | Whitelist: ${db.getWhitelist().size}`);
  console.log(`📝  Log: ${db.getLogChannel() || 'not set'} | Boost: ${db.getBoostChannelId() || 'not set'}`);
  console.log(`📬  DMs: ${cfg.sendDMs ? 'ON' : 'OFF'}\n`);

  const guilds = [...client.guilds.cache.values()];
  guilds.forEach(g => {
    const active = db.isGateActive(g.id);
    const bot    = g.members.me;
    const hasKick = bot?.permissions.has(PermissionsBitField.Flags.KickMembers);
    const icon   = active ? (hasKick ? '🟢' : '⚠️') : '🔴';
    console.log(`  ${icon} ${g.name} — gate ${active ? 'ON' : 'OFF'}${!hasKick && active ? ' ← MISSING KICK PERMISSION' : ''}`);
  });
  console.log('');

  await syncAllGuilds();

  // Cache vanity URLs for all guilds on startup (non-blocking, best effort)
  for (const guild of guilds) {
    await getVanity(guild).catch(() => {});
    await sleep(200);
  }

  setInterval(() => {
    const gs = [...client.guilds.cache.values()];
    const tb = gs.reduce((s, g) => s + (g.premiumSubscriptionCount || 0), 0);
    console.log(`🔄  Boost: ${tb} total across ${gs.length} servers`);
  }, 30 * 60 * 1000);
});

client.on(Events.GuildCreate, async (guild) => {
  console.log(`📥  Joined: ${guild.name}`);
  await syncToGuild(guild);
  await getVanity(guild).catch(() => {});
});

// ── Boost events ──────────────────────────────────────────────────────────────

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const was = !!oldMember.premiumSince, is = !!newMember.premiumSince;
  if (was === is) return;
  const guild = newMember.guild, gained = !was && is;
  const { count, emoji, name, next, needed } = getBoostInfo(guild);
  console.log(`${gained ? '🎉' : '💔'} Boost ${gained ? 'added' : 'removed'}: ${newMember.user.tag} in ${guild.name}`);
  await sendBoostAlert(new EmbedBuilder()
    .setColor(gained ? 0xf47fff : 0xff4444)
    .setTitle(gained ? `🎉 New Boost — ${guild.name}` : `💔 Boost Removed — ${guild.name}`)
    .setThumbnail(newMember.user.displayAvatarURL())
    .addFields(
      { name: gained ? '🚀 Started Boosting' : '❌ Stopped Boosting', value: `${newMember.user.tag}\n<@${newMember.user.id}>`, inline: true },
      { name: '📊 Boosts', value: `**${count}**`, inline: true },
      { name: '🏆 Tier',   value: next ? `${emoji} **${name}** — ${needed} more to next` : `✨ **Level 3**`, inline: true },
    ).setTimestamp());
});

client.on(Events.GuildMemberRemove, async (member) => {
  if (!member.premiumSince) return;
  const guild = member.guild;
  const { count, emoji, name, next, needed } = getBoostInfo(guild);
  console.log(`⚠️  Booster left: ${member.user.tag} from ${guild.name}`);
  await sendBoostAlert(new EmbedBuilder()
    .setColor(0xff8c00).setTitle(`⚠️ Booster Left — ${guild.name}`)
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      { name: '👤 Member',   value: `${member.user.tag}\n<@${member.user.id}>`, inline: true },
      { name: '📊 Boosts',   value: `**${count}**`, inline: true },
      { name: '🏆 Tier',     value: next ? `${emoji} **${name}** — ${needed} more to next` : `✨ **Level 3**`, inline: true },
      { name: '⚠️ Note',    value: 'This member was boosting — their boost has been removed.', inline: false },
    ).setTimestamp());
});

// ── Member join — clean, simple, reliable kick logic ─────────────────────────

client.on(Events.GuildMemberAdd, async (member) => {
  if (member.user.bot) return;

  db.increment('totalJoins');
  const guild     = member.guild;
  const createdAt = Math.floor(member.user.createdTimestamp / 1000);
  const joinedAt  = Math.floor(Date.now() / 1000);

  // ── 1. Authorized? ──────────────────────────────────────────────────────────
  if (db.isAuthorized(member.user.id)) {
    db.increment('authorizedJoins');
    console.log(`✅ [AUTH] ${member.user.tag} in ${guild.name}`);
    await postLog(new EmbedBuilder().setColor(0x00cc66).setTitle('✅ Authorized Member Joined')
      .setThumbnail(member.user.displayAvatarURL())
      .addFields(
        { name: 'Server',  value: `${guild.name} (\`${guild.id}\`)`,         inline: false },
        { name: 'User',    value: `${member.user.tag}\n<@${member.user.id}>`, inline: true  },
        { name: 'ID',      value: `\`${member.user.id}\``,                    inline: true  },
        { name: 'Account', value: `<t:${createdAt}:R>`,                       inline: true  },
      ).setFooter({ text: statsFooter() }).setTimestamp());
    return;
  }

  // ── 2. Gate active? ─────────────────────────────────────────────────────────
  if (!db.isGateActive(guild.id)) {
    db.increment('gateOffJoins');
    const reason = !db.getGate()
      ? 'Global gate is OFF'
      : 'This server is individually excepted';
    console.log(`⏸️ [GATE OFF] ${member.user.tag} in ${guild.name} — ${reason}`);
    await postLog(new EmbedBuilder().setColor(0xf0a500).setTitle('⏸️ Unauthorized — Gate Off (Not Kicked)')
      .setThumbnail(member.user.displayAvatarURL())
      .addFields(
        { name: 'Server',  value: `${guild.name} (\`${guild.id}\`)`,         inline: false },
        { name: 'User',    value: `${member.user.tag}\n<@${member.user.id}>`, inline: true  },
        { name: 'ID',      value: `\`${member.user.id}\``,                    inline: true  },
        { name: 'Account', value: `<t:${createdAt}:R>`,                       inline: true  },
        { name: 'Reason',  value: reason,                                     inline: false },
      ).setFooter({ text: statsFooter() }).setTimestamp());
    return;
  }

  // ── 3. Gate is active — kick immediately ────────────────────────────────────
  console.log(`🚨 [KICK] ${member.user.tag} (${member.user.id}) in ${guild.name} (${guild.id})`);

  let kickOk = false, kickErr = '';
  try {
    await member.kick('Unauthorized — not on the whitelist.');
    kickOk = true;
    db.increment('successfulKicks');
    console.log(`✅ [KICKED] ${member.user.tag} from ${guild.name}`);
  } catch (err) {
    kickErr = err.message;
    db.increment('failedKicks');
    console.error(`❌ [KICK FAILED] ${member.user.tag} in ${guild.name}: ${err.message}`);
  }

  // ── 4. Update vanity tracking ────────────────────────────────────────────────
  const vanity = vanityCache.get(guild.id) || null;
  db.incrementVanityJoin(vanity);
  if (kickOk) db.incrementVanityKick(vanity);

  // ── 5. DM — only if kick succeeded AND DMs are enabled ───────────────────────
  let dmSent = false, dmErr = '';
  if (kickOk && cfg.sendDMs) {
    try {
      await member.user.send({ embeds: [buildDMEmbed(guild.name, vanity)], components: [buildDMRow()] });
      dmSent = true;
      db.increment('dmsSent');
    } catch (err) {
      dmErr = err.message;
      db.increment('dmsFailed');
      console.warn(`⚠️ [DM FAILED] ${member.user.tag}: ${err.message}`);
    }
  }

  // ── 6. Log to channel ────────────────────────────────────────────────────────
  await postLog(new EmbedBuilder()
    .setColor(kickOk ? 0xff4444 : 0xff9900)
    .setTitle(kickOk ? '🚫 Unauthorized Member Kicked' : '⚠️ Kick Failed')
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      { name: 'Server',  value: `${guild.name} (\`${guild.id}\`)`,                         inline: false },
      { name: 'Vanity',  value: vanity ? `\`/${vanity}\`` : '_None_',                      inline: true  },
      { name: 'User',    value: `${member.user.tag}\n<@${member.user.id}>`,                inline: true  },
      { name: 'ID',      value: `\`${member.user.id}\``,                                   inline: true  },
      { name: 'Account', value: `<t:${createdAt}:R>`,                                      inline: true  },
      { name: 'Joined',  value: `<t:${joinedAt}:R>`,                                       inline: true  },
      { name: 'Kick',    value: kickOk ? '✅ Success' : `❌ Failed\n\`${kickErr}\`\n*Check bot role position in Server Settings → Roles*`, inline: true },
      ...(cfg.sendDMs ? [{ name: 'DM', value: dmSent ? '✅ Sent' : `❌ Failed\n\`${dmErr}\``, inline: true }] : []),
    ).setFooter({ text: statsFooter() }).setTimestamp());
});

// ── Slash commands + buttons ──────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {

  // Boost pagination buttons
  if (interaction.isButton()) {
    const id = interaction.customId;
    if (id !== 'bm' && !id.startsWith('bp_') && !id.startsWith('bn_')) return;
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator))
      return interaction.reply({ content: '❌ Administrator permission required.', ephemeral: true });
    if (id === 'bm') return interaction.deferUpdate();
    const page   = parseInt(id.split('_')[1]);
    const guilds = [...client.guilds.cache.values()].sort((a, b) => (b.premiumSubscriptionCount || 0) - (a.premiumSubscriptionCount || 0));
    const tot    = Math.max(1, Math.ceil(guilds.length / 8));
    return interaction.update({ embeds: [buildBoostsEmbed(guilds, page, tot)], components: [buildBoostsRow(page, tot)] });
  }

  if (!interaction.isChatInputCommand()) return;
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator))
    return interaction.reply({ content: '❌ Administrator permission required.', ephemeral: true });

  const { commandName } = interaction;

  // /whitelist
  if (commandName === 'whitelist') {
    const sub = interaction.options.getSubcommand(), user = interaction.options.getUser('user');
    if (sub === 'add')    { db.addWhitelist(user.id);    return interaction.reply({ content: `✅ **${user.tag}** whitelisted.`, ephemeral: true }); }
    if (sub === 'remove') { db.removeWhitelist(user.id); return interaction.reply({ content: `✅ **${user.tag}** removed.`,     ephemeral: true }); }
    if (sub === 'list') {
      const wl = db.getWhitelist();
      if (!wl.size) return interaction.reply({ content: '📋 Whitelist is empty.', ephemeral: true });
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x0d0d1a).setTitle('📋 Authorized Users')
        .setDescription([...wl].map((id, i) => `**${i + 1}.** <@${id}> (\`${id}\`)`).join('\n'))
        .setFooter({ text: `${wl.size} user(s)` })], ephemeral: true });
    }
  }

  // /gate
  if (commandName === 'gate') {
    const sub = interaction.options.getSubcommand(), group = interaction.options.getSubcommandGroup(false);

    if (group === 'server') {
      if (sub === 'add') {
        const raw = interaction.options.getString('ids');
        const ids = raw ? parseIds(raw) : [interaction.guild.id];
        if (!ids.length) return interaction.reply({ content: '❌ No valid IDs.', ephemeral: true });
        ids.forEach(id => db.addGateException(id));
        const wasOff = !db.getGate(); if (wasOff) db.setGate(true);
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xf0a500)
          .setTitle(`⏸️ Gate Off for ${ids.length} Server${ids.length !== 1 ? 's' : ''}`)
          .setDescription(`Not kicking in:\n${ids.map(id => `• ${guildLabel(id)}`).join('\n')}` +
            (wasOff ? '\n\n⚠️ Global gate was OFF — **automatically enabled** for all other servers.' : '\n\nAll other servers still kick.'))
          .setTimestamp()], ephemeral: true });
      }
      if (sub === 'remove') {
        const raw = interaction.options.getString('id');
        const id  = raw?.trim() || interaction.guild.id;
        if (!/^\d{10,20}$/.test(id)) return interaction.reply({ content: '❌ Invalid ID.', ephemeral: true });
        if (!db.getGateExceptions().has(String(id)))
          return interaction.reply({ content: `⚠️ \`${id}\` is not in exceptions. Check \`/gate status\`.`, ephemeral: true });
        db.removeGateException(id);
        const active = db.isGateActive(id);
        await interaction.reply({ embeds: [new EmbedBuilder().setColor(active ? 0x00cc66 : 0xf0a500)
          .setTitle('✅ Exception Removed')
          .setDescription(`${guildLabel(id)}\n\n**Gate is now: ${active ? '🟢 ON — will kick' : '🔴 still OFF (global gate is off)'}**` +
            (active ? '\n\n🧹 Sweeping for unauthorized members...' : '')).setTimestamp()], ephemeral: true });
        if (active) { const tg = client.guilds.cache.get(String(id)); if (tg) sweepGuild(tg).catch(() => {}); }
        return;
      }
      if (sub === 'list') {
        const ex = db.getGateExceptions();
        if (!ex.size) return interaction.reply({ content: '📋 No per-server exceptions.', ephemeral: true });
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xf0a500).setTitle(`⏸️ Excepted Servers (${ex.size})`)
          .setDescription([...ex].map(id => `• ${guildLabel(id)}`).join('\n'))
          .setFooter({ text: 'These never kick regardless of global gate' }).setTimestamp()], ephemeral: true });
      }
      if (sub === 'clear') {
        const c = db.getGateExceptions().size; db.clearGateExceptions();
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(db.getGate() ? 0x00cc66 : 0xf0a500)
          .setTitle('🗑️ All Exceptions Cleared')
          .setDescription(`Removed ${c} exception${c !== 1 ? 's' : ''}. Global gate: **${db.getGate() ? '🟢 ON' : '🔴 OFF'}**`).setTimestamp()], ephemeral: true });
      }
    }

    if (sub === 'on') {
      if (db.getGate()) return interaction.reply({ content: '🛡️ Gate is already ON.', ephemeral: true });
      db.setGate(true);
      const ex = db.getGateExceptions().size;
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('🛡️ Gate Enabled')
        .setDescription('Gate is ON. Kicking unauthorized members on join.\n\n🧹 **Sweeping active servers for unauthorized members — results in log channel.**' +
          (ex > 0 ? `\n\n⚠️ ${ex} server${ex !== 1 ? 's are' : ' is'} still individually excepted.` : '')).setTimestamp()] });
      sweepAll().catch(() => {});
      return;
    }

    if (sub === 'off') {
      if (!db.getGate()) return interaction.reply({ content: '⏸️ Gate is already OFF.', ephemeral: true });
      db.setGate(false);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xf0a500).setTitle('⏸️ Gate Disabled')
        .setDescription('Gate is **OFF for ALL servers**. Run `/gate on` to re-enable.').setTimestamp()] });
    }

    if (sub === 'reset') {
      db.clearGateExceptions(); db.setGate(true);
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('🔄 Gate Reset')
        .setDescription('✅ Gate → **ON**\n✅ All exceptions → **cleared**\n🧹 **Sweeping all servers — results in log channel.**').setTimestamp()] });
      sweepAll().catch(() => {});
      return;
    }

    if (sub === 'sweep') {
      const ac = [...client.guilds.cache.values()].filter(g => db.isGateActive(g.id)).length;
      if (!ac) return interaction.reply({ content: '⚠️ No active servers to sweep.', ephemeral: true });
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xff4444).setTitle('🧹 Sweep Started')
        .setDescription(`Scanning **${ac}** server${ac !== 1 ? 's' : ''} — results in log channel.`).setTimestamp()], ephemeral: true });
      sweepAll().catch(() => {});
      return;
    }

    if (sub === 'status') {
      const on = db.getGate(), ex = db.getGateExceptions();
      const lines = [...client.guilds.cache.values()].map(g => {
        const act  = db.isGateActive(g.id);
        const perm = g.members.me?.permissions.has(PermissionsBitField.Flags.KickMembers);
        return `${act ? '🟢' : '🔴'} **${g.name}**${ex.has(g.id) ? ' _(excepted)_' : ''}${act && !perm ? ' ⚠️ NO KICK PERM' : ''}`;
      }).join('\n') || '_none_';
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(on ? 0x00cc66 : 0xf0a500).setTitle('🛡️ Gate Status')
        .addFields(
          { name: 'Global Gate', value: on ? '🟢 **ON**' : '🔴 **OFF**', inline: false },
          { name: `Exceptions (${ex.size})`, value: ex.size ? [...ex].map(id => `• ${guildLabel(id)}`).join('\n') : '_None_', inline: false },
          { name: 'Per-Server State', value: lines, inline: false },
        ).setFooter({ text: '⚠️ NO KICK PERM = move bot role above members in Server Settings → Roles' }).setTimestamp()], ephemeral: true });
    }
  }

  // /boosts
  if (commandName === 'boosts') {
    const gs  = [...client.guilds.cache.values()].sort((a, b) => (b.premiumSubscriptionCount || 0) - (a.premiumSubscriptionCount || 0));
    const tot = Math.max(1, Math.ceil(gs.length / 8));
    return interaction.reply({ embeds: [buildBoostsEmbed(gs, 0, tot)], components: [buildBoostsRow(0, tot)], ephemeral: true });
  }

  // /setboostchannel
  if (commandName === 'setboostchannel') {
    const ch = interaction.options.getChannel('channel');
    if (ch.type !== ChannelType.GuildText) return interaction.reply({ content: '❌ Text channel required.', ephemeral: true });
    if (!ch.permissionsFor(interaction.guild.members.me)?.has('SendMessages')) return interaction.reply({ content: `❌ No send permission in ${ch}.`, ephemeral: true });
    db.setBoostChannelId(ch.id);
    await ch.send({ embeds: [new EmbedBuilder().setColor(0xf47fff).setTitle('🚀 Boost Alert Channel Set').setDescription('Boost gain/loss alerts will appear here.').setTimestamp()] });
    return interaction.reply({ content: `✅ Boost channel → ${ch}.`, ephemeral: true });
  }

  // /setlog
  if (commandName === 'setlog') {
    const ch = interaction.options.getChannel('channel');
    if (ch.type !== ChannelType.GuildText) return interaction.reply({ content: '❌ Text channel required.', ephemeral: true });
    if (!ch.permissionsFor(interaction.guild.members.me)?.has('SendMessages')) return interaction.reply({ content: `❌ No send permission in ${ch}.`, ephemeral: true });
    db.setLogChannel(ch.id);
    await ch.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📝 Log Channel Set').setDescription('Kick logs and sweep results will appear here.').setTimestamp()] });
    return interaction.reply({ content: `✅ Log channel → ${ch}.`, ephemeral: true });
  }

  // /setinvite
  if (commandName === 'setinvite') {
    const url = interaction.options.getString('url');
    if (!url.startsWith('http')) return interaction.reply({ content: '❌ Provide a full URL (https://...).', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    db.setInviteLink(url);
    const uses = await fetchInviteUses(url); if (uses !== null) db.setInviteBaseline(uses);
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('🔗 Invite Link Updated')
      .setDescription(`${url}${uses !== null ? `\n\nBaseline: **${uses}** uses` : ''}`).setTimestamp()] });
  }

  // /setcontact
  if (commandName === 'setcontact') {
    db.setContactTag(interaction.options.getString('tag'));
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('👤 Contact Updated')
      .setDescription(`DMs will say: contact **${db.getContactTag()}**`).setTimestamp()], ephemeral: true });
  }

  // /vanitystats
  if (commandName === 'vanitystats') {
    const filter = interaction.options.getString('vanity')?.toLowerCase();
    const all = db.getVanityStats(), entries = Object.entries(all).sort((a, b) => b[1].joins - a[1].joins);
    const since = formatDate(db.getTrackingStarted());
    if (!entries.length) return interaction.reply({ content: '📊 No vanity data yet.', ephemeral: true });
    if (filter) {
      const s = all[filter]; if (!s) return interaction.reply({ content: `❌ No data for \`${filter}\`.`, ephemeral: true });
      const rate = s.joins > 0 ? `${((s.kicks / s.joins) * 100).toFixed(1)}%` : 'N/A';
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x0d0d1a).setTitle(`📊 /${filter}`)
        .addFields({ name: '👥 Joins', value: `\`${s.joins}\``, inline: true }, { name: '👢 Kicks', value: `\`${s.kicks}\``, inline: true }, { name: '📈 Rate', value: `\`${rate}\``, inline: true })
        .setFooter({ text: `Since ${since}` }).setTimestamp()], ephemeral: true });
    }
    const lines = entries.map(([v, s]) => `**/${v}** — ${s.joins} join${s.joins !== 1 ? 's' : ''}, ${s.kicks} kick${s.kicks !== 1 ? 's' : ''} (${s.joins > 0 ? Math.round(s.kicks / s.joins * 100) : 0}%)`).join('\n');
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x0d0d1a).setTitle('📊 Vanity Stats').setDescription(lines)
      .setFooter({ text: `${entries.length} tracked  •  Since ${since}` }).setTimestamp()], ephemeral: true });
  }

  // /linkstats
  if (commandName === 'linkstats') {
    const url = db.getInviteLink(); if (!url) return interaction.reply({ content: '❌ No invite link set.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const total = await fetchInviteUses(url), baseline = db.getInviteBaseline();
    const since = total !== null ? Math.max(0, total - baseline) : null;
    const sent  = db.getStats().dmsSent;
    const conv  = sent > 0 && since !== null ? `${((since / sent) * 100).toFixed(1)}%` : 'N/A';
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x0d0d1a).setTitle('🔗 Invite Link Stats')
      .addFields(
        { name: '🔗 Link',          value: url,                                        inline: false },
        { name: '📨 DMs Sent',      value: `\`${sent}\``,                              inline: true  },
        { name: '🖱️ Uses Since Set',value: since !== null ? `\`${since}\`` : '`N/A`', inline: true  },
        { name: '📊 All-Time',      value: total !== null ? `\`${total}\`` : '`N/A`', inline: true  },
        { name: '📈 Conversion',    value: `\`${conv}\``,                              inline: true  },
      ).setFooter({ text: 'Live from Discord API' }).setTimestamp()] });
  }

  // /log
  if (commandName === 'log') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'reset') { db.resetStats(); return interaction.reply({ content: '🔄 Stats reset to zero.', ephemeral: true }); }
    if (sub === 'stats') {
      const s = db.getStats(), up = process.uptime();
      const upt = `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m ${Math.floor(up % 60)}s`;
      const kr  = s.totalJoins > 0 ? `${((s.successfulKicks / s.totalJoins) * 100).toFixed(1)}%` : 'N/A';
      const dt  = s.dmsSent + s.dmsFailed, dr = dt > 0 ? `${((s.dmsSent / dt) * 100).toFixed(1)}%` : 'N/A';
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x0d0d1a).setTitle('📊 Statistics')
        .addFields(
          { name: '🛡️ Gate',  value: db.getGate() ? '🟢 ON' : '🔴 OFF', inline: true },
          { name: '🔕 Except',value: `${db.getGateExceptions().size}`,    inline: true },
          { name: '⏱️ Uptime',value: upt,                                 inline: true },
          { name: '\u200b', value: '**── Joins ──**', inline: false },
          { name: '👥 Total',   value: `\`${s.totalJoins}\``,      inline: true },
          { name: '✅ Auth',    value: `\`${s.authorizedJoins}\``, inline: true },
          { name: '⏸️ Allowed',value: `\`${s.gateOffJoins}\``,    inline: true },
          { name: '\u200b', value: '**── Kicks ──**', inline: false },
          { name: '👢 OK',   value: `\`${s.successfulKicks}\``, inline: true },
          { name: '❌ Fail', value: `\`${s.failedKicks}\``,     inline: true },
          { name: '📈 Rate', value: `\`${kr}\``,                inline: true },
          { name: '\u200b', value: '**── DMs ──**', inline: false },
          { name: `📨 ${cfg.sendDMs ? 'Sent' : 'Sent (DMs off)'}`, value: `\`${s.dmsSent}\``,   inline: true },
          { name: '📭 Failed',                                     value: `\`${s.dmsFailed}\``, inline: true },
          { name: '📬 Rate',                                       value: `\`${dr}\``,           inline: true },
        ).setFooter({ text: `DMs: ${cfg.sendDMs ? 'ON' : 'OFF (set SEND_DMS=true in Railway to enable)'}` }).setTimestamp()], ephemeral: true });
    }
  }

  // /config
  if (commandName === 'config') {
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x0d0d1a).setTitle('⚙️ Configuration')
      .setDescription('Static → Railway Variables  •  Dynamic → volume')
      .addFields(
        { name: '🏷️ Brand',     value: cfg.brandName || '_Not set_',                                                                inline: false },
        { name: '🖼️ Banner',   value: cfg.bannerUrl  || '_Not set_',                                                                inline: false },
        { name: '📝 Log Ch',   value: db.getLogChannel()     ? `<#${db.getLogChannel()}>` : '_Not set_',                            inline: true  },
        { name: '🚀 Boost Ch', value: db.getBoostChannelId() ? `<#${db.getBoostChannelId()}>` : '_Not set_',                       inline: true  },
        { name: '🔗 Invite',   value: db.getInviteLink() || '_Not set_',                                                             inline: false },
        { name: '👤 Contact',  value: db.getContactTag(),                                                                            inline: true  },
        { name: '🛡️ Gate',    value: db.getGate() ? '🟢 ON' : '🔴 OFF',                                                           inline: true  },
        { name: '📬 DMs',      value: cfg.sendDMs ? '✅ ON' : '❌ OFF (SEND_DMS=true to enable)',                                   inline: true  },
        { name: '📋 Whitelist',value: `${db.getWhitelist().size} user(s)`,                                                          inline: true  },
      )], ephemeral: true });
  }

  // /help
  if (commandName === 'help') {
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📖 Command Reference')
      .setDescription('All commands require **Administrator** permission.')
      .addFields(
        { name: '🔐 Whitelist', value: '`/whitelist add @user`  `remove`  `list`' },
        { name: '🛡️ Gate — Global', value: '`/gate on` — enable + immediate sweep\n`/gate off` — disable ALL servers\n`/gate status` — shows state + kick permissions\n`/gate reset` — force ON + clear + sweep\n`/gate sweep` — manual kick sweep now' },
        { name: '🛡️ Gate — Per Server', value: '`/gate server add [ids:123,456]` — turn off for specific servers\n`/gate server remove [id]` — re-enable + sweep\n`/gate server list`  `clear`' },
        { name: '🚀 Boost Monitoring', value: '`/boosts` — paginated boost status (◀▶)\n`/setboostchannel #ch` — boost alert channel' },
        { name: '✉️ Kick DM', value: '`/setinvite <url>`  `setcontact <tag>`\n> DMs are **OFF by default** to prevent Discord quarantine.\n> Set `SEND_DMS=true` in Railway Variables to enable.' },
        { name: '📊 Stats & Tracking', value: '`/vanitystats [vanity]`  `linkstats`  `log stats`  `log reset`' },
        { name: '📝 Setup', value: '`/setlog #channel`  `setboostchannel #channel`  `config`' },
        { name: '⚠️ Kicks not working?', value: '1. Run `/gate status` — check for `⚠️ NO KICK PERM`\n2. **Server Settings → Roles** → move bot role above member roles\n3. Give bot **Kick Members** permission\n4. Run `/gate sweep` to catch anyone who slipped through' },
      ).setFooter({ text: 'Railway deploy logs show every kick attempt in real time' }).setTimestamp()], ephemeral: true });
  }
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(sig) { console.log(`\n${sig} — saving...`); db.save(); client.destroy(); process.exit(0); }
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('unhandledRejection', err => console.error('⚠️  Unhandled:', err?.message || err));
client.login(cfg.token).catch(err => { console.error(`\n❌  Login failed: ${err.message}\n`); process.exit(1); });
