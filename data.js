const fs   = require('fs');
const path = require('path');

const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'bot_data.json');

const DEFAULT_STATS = {
  totalJoins: 0, authorizedJoins: 0, gateOffJoins: 0,
  successfulKicks: 0, failedKicks: 0, dmsSent: 0, dmsFailed: 0,
};

let _whitelist       = new Set();
let _stats           = { ...DEFAULT_STATS };
let _gateEnabled     = true;
let _gateExceptions  = new Set();   // guild IDs where gate is individually OFF
let _logChannelId    = null;
let _boostChannelId  = null;
let _inviteLink      = null;
let _inviteBaseline  = 0;
let _contactTag      = '@nudities';
let _vanityStats     = {};
let _trackingStarted = new Date().toISOString();

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    if (!fs.existsSync(DATA_FILE)) { console.log('📂  No data file — starting fresh'); _flush(); return; }
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    _whitelist       = new Set(Array.isArray(d.whitelist)      ? d.whitelist      : []);
    _stats           = { ...DEFAULT_STATS, ...(d.stats || {}) };
    _gateEnabled     = d.gateEnabled !== false;
    _gateExceptions  = new Set(Array.isArray(d.gateExceptions) ? d.gateExceptions : []);
    _logChannelId    = d.logChannelId    || null;
    _boostChannelId  = d.boostChannelId  || null;
    _inviteLink      = d.inviteLink      || null;
    _inviteBaseline  = d.inviteBaseline  || 0;
    _contactTag      = d.contactTag      || '@nudities';
    _vanityStats     = d.vanityStats     || {};
    _trackingStarted = d.trackingStarted || new Date().toISOString();
    console.log(`📂  Data loaded — gate: ${_gateEnabled ? 'ON' : 'OFF'}, whitelist: ${_whitelist.size}, exceptions: ${_gateExceptions.size}`);
  } catch (err) {
    console.error(`⚠️  Load error (${err.message}) — using defaults`);
    _flush();
  }
}

function _flush() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      whitelist: [..._whitelist], stats: _stats,
      gateEnabled: _gateEnabled, gateExceptions: [..._gateExceptions],
      logChannelId: _logChannelId, boostChannelId: _boostChannelId,
      inviteLink: _inviteLink, inviteBaseline: _inviteBaseline,
      contactTag: _contactTag, vanityStats: _vanityStats,
      trackingStarted: _trackingStarted,
    }, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) { console.error('⚠️  Save error:', err.message); }
}

// Whitelist
function getWhitelist()      { return _whitelist; }
function isAuthorized(id)    { return _whitelist.has(String(id)); }
function addWhitelist(id)    { _whitelist.add(String(id));    _flush(); }
function removeWhitelist(id) { _whitelist.delete(String(id)); _flush(); }

// Stats
function getStats()    { return _stats; }
function increment(k)  { if (k in _stats) { _stats[k]++; _flush(); } }
function resetStats()  { _stats = { ...DEFAULT_STATS }; _flush(); }

// Vanity stats
function getVanityStats()     { return _vanityStats; }
function getTrackingStarted() { return _trackingStarted; }
function incrementVanityJoin(v) { if (!v) return; const k = v.toLowerCase(); if (!_vanityStats[k]) _vanityStats[k] = { joins: 0, kicks: 0 }; _vanityStats[k].joins++; _flush(); }
function incrementVanityKick(v) { if (!v) return; const k = v.toLowerCase(); if (!_vanityStats[k]) _vanityStats[k] = { joins: 0, kicks: 0 }; _vanityStats[k].kicks++; _flush(); }
function resetVanityStats() { _vanityStats = {}; _flush(); }

// Gate
function getGate()     { return _gateEnabled; }
function setGate(v)    { _gateEnabled = !!v; console.log(`🛡️  Gate → ${_gateEnabled ? 'ON' : 'OFF'}`); _flush(); }
function isGateActive(guildId) {
  if (!_gateEnabled) return false;
  if (_gateExceptions.has(String(guildId))) return false;
  return true;
}
function getGateExceptions()     { return _gateExceptions; }
function addGateException(id)    { _gateExceptions.add(String(id));    console.log(`⏸️  Exception added: ${id}`);   _flush(); }
function removeGateException(id) { _gateExceptions.delete(String(id)); console.log(`✅  Exception removed: ${id}`); _flush(); }
function clearGateExceptions()   { _gateExceptions.clear();            console.log(`🗑️  All exceptions cleared`);   _flush(); }

// Channels
function getLogChannel()      { return _logChannelId; }
function setLogChannel(id)    { _logChannelId = id;    _flush(); }
function getBoostChannelId()  { return _boostChannelId; }
function setBoostChannelId(id){ _boostChannelId = id;  _flush(); }

// Invite
function getInviteLink()      { return _inviteLink; }
function setInviteLink(url)   { _inviteLink = url;   _flush(); }
function getInviteBaseline()  { return _inviteBaseline; }
function setInviteBaseline(n) { _inviteBaseline = n;  _flush(); }

// Contact
function getContactTag()    { return _contactTag; }
function setContactTag(tag) { _contactTag = tag;   _flush(); }

function save() { _flush(); }

module.exports = {
  load, save,
  getWhitelist, isAuthorized, addWhitelist, removeWhitelist,
  getStats, increment, resetStats,
  getVanityStats, incrementVanityJoin, incrementVanityKick, resetVanityStats, getTrackingStarted,
  getGate, setGate, isGateActive,
  getGateExceptions, addGateException, removeGateException, clearGateExceptions,
  getLogChannel, setLogChannel, getBoostChannelId, setBoostChannelId,
  getInviteLink, setInviteLink, getInviteBaseline, setInviteBaseline,
  getContactTag, setContactTag,
};
