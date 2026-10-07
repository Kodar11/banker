// Second player for single-device Maestro flows. Talks to the real referee
// (game-action Edge Function) exactly like the app does.
// Inputs (env): OP, SUPABASE_URL, SUPABASE_KEY, CODE, NAME, BID
var URL_ = SUPABASE_URL + '/functions/v1/game-action';

function call(body) {
  var res = http.post(URL_, {
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
    body: JSON.stringify(body),
  });
  return json(res.body);
}
function hex(n) {
  var s = '';
  for (var i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}
function uuid() {
  return hex(8) + '-' + hex(4) + '-4' + hex(3) + '-8' + hex(3) + '-' + hex(12);
}
function creds() {
  return { gameId: output.botGameId, playerId: output.botPlayerId, token: output.botToken };
}
function state() {
  var c = creds();
  return call({ op: 'state', gameId: c.gameId, playerId: c.playerId, token: c.token }).snapshot.state;
}
function act(s, action) {
  var c = creds();
  return call({ op: 'action', gameId: c.gameId, playerId: c.playerId, token: c.token, actionId: uuid(), expectedVersion: s.version, action: action });
}

if (OP === 'join') {
  var token = hex(64);
  var res = call({ op: 'join', actionId: uuid(), token: token, code: CODE, name: NAME || 'Bot' });
  if (!res.ok) throw new Error('bot join failed: ' + res.error.message);
  output.botGameId = res.gameId;
  output.botPlayerId = res.playerId;
  output.botToken = token;
}

if (OP === 'host') {
  var t = hex(64);
  var r = call({ op: 'create', actionId: uuid(), token: t, name: NAME || 'BotHost' });
  if (!r.ok) throw new Error('bot create failed: ' + r.error.message);
  output.botGameId = r.gameId;
  output.botPlayerId = r.playerId;
  output.botToken = t;
  output.code = r.snapshot.state.code;
}

if (OP === 'start') {
  act(state(), { type: 'START_GAME' });
}

// Plays the bot's whole turn: buys whenever it can (so the app player meets rent), pays, ends turn.
if (OP === 'play') {
  for (var i = 0; i < 12; i++) {
    var s = state();
    if (s.status !== 'ACTIVE' || s.turn.playerId !== output.botPlayerId) break;
    var phase = s.turn.phase;
    var p = s.turn.pending;
    if (phase === 'AWAITING_ROLL') act(s, { type: 'ROLL_DICE' });
    else if (phase === 'AWAITING_DECISION') act(s, { type: 'BUY_PROPERTY' }).ok || act(state(), { type: 'DECLINE_PROPERTY' });
    else if (phase === 'AWAITING_PAYMENT') act(s, { type: 'PAY_' + p.reason }).ok || act(state(), { type: 'DECLARE_BANKRUPTCY' });
    else if (phase === 'AWAITING_CARD') act(s, { type: 'RESOLVE_CARD', resolution: 'NONE' });
    else if (phase === 'AUCTION') act(s, { type: 'PASS_AUCTION', auctionId: s.auction.id });
    else if (phase === 'TURN_COMPLETE') act(s, { type: 'END_TURN' });
  }
}

// Bids on the open auction (the app player then passes so the bot wins).
if (OP === 'bid') {
  var st = state();
  if (st.auction && st.auction.status === 'OPEN') {
    var min = st.auction.highBid === null ? st.auction.minimumOpeningBid : st.auction.highBid + st.auction.minimumIncrement;
    act(st, { type: 'PLACE_BID', auctionId: st.auction.id, amount: Number(BID) || min });
  }
}
