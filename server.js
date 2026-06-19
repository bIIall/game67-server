// server.js — WebSocket сервер игры 67
// Деплой: Railway / Render / любой Node.js хостинг
// npm install ws

const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const RANKS = ['6','В','Д','К','Т','7','8'];
const SUITS = ['+','☽','♚','☀'];
const RANK_POWER = { '6':0,'В':1,'Д':2,'К':3,'Т':4,'7':5,'8':6 };

// ─── HTTP сервер (для health check на Render/Railway) ─────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('67 Game Server OK');
});

const wss = new WebSocketServer({ server });

// ─── ХРАНИЛИЩЕ КОМНАТ ─────────────────────────────────────────────────────────
// rooms: Map<roomId, Room>
// Room: { id, players: [{ws, userId, name, ready}], state: GameState|null, phase: 'waiting'|'playing' }
const rooms = new Map();

function generateRoomId() {
  return 'R' + Math.floor(1000 + Math.random() * 9000);
}

// ─── КОЛОДА ───────────────────────────────────────────────────────────────────
function buildDeck() {
  const deck = [];
  for (const suit of SUITS)
    for (const rank of RANKS)
      deck.push({ rank, suit });
  return deck;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── ПРАВИЛА ─────────────────────────────────────────────────────────────────
function isTrump(card) { return card.suit === '♚'; }
function isPlus(card) { return card.suit === '+'; }

function canCover(attacker, defender) {
  // Д+ бьёт всё
  if (defender.rank === 'Д' && defender.suit === '+') return true;
  // 7 нельзя перевернуть шестёркой — 7 не может быть крыта шестёркой вообще
  if (attacker.rank === '7' && defender.rank === '6') return false;
  // Масть + кроется только мастью +
  if (attacker.suit === '+') {
    if (defender.suit !== '+') return false;
    return RANK_POWER[defender.rank] > RANK_POWER[attacker.rank];
  }
  // 6 — переворот по любой непривилегированной карте
  if (defender.rank === '6') {
    if (attacker.suit === '+') return false;
    if (attacker.rank === '7') return false;
    // 6♚ = козырная шестёрка, бьёт все обычные масти и козырь
    if (defender.suit === '♚') return true;
    // Остальные 6 — только свою масть
    return defender.suit === attacker.suit;
  }
  // Козырь кроется козырем старшим
  if (attacker.suit === '♚') {
    if (defender.suit === '♚') return RANK_POWER[defender.rank] > RANK_POWER[attacker.rank];
    return false;
  }
  // Обычная масть: та же масть старшей картой ИЛИ козырем
  if (defender.suit === attacker.suit) return RANK_POWER[defender.rank] > RANK_POWER[attacker.rank];
  if (defender.suit === '♚') return true;
  return false;
}

function cardEffect(card) {
  if (card.rank === 'Д' && card.suit === '+') return { flip: true, right: 'thrower', beatAll: true };
  if (card.rank === '8') return { flip: true, right: 'thrower', beatAll: false };
  if (card.rank === '6') return { flip: true, right: 'next-reversed', beatAll: false };
  return { flip: false, right: 'next', beatAll: false };
}

function nextIdx(n, from, dir) {
  return ((from + dir) % n + n) % n;
}

// ─── ИГРОВАЯ ЛОГИКА ───────────────────────────────────────────────────────────
function initGame(players) {
  const deck = shuffle(buildDeck());
  const n = players.length;
  const hands = Array.from({ length: n }, () => []);
  for (let i = 0; i < deck.length; i++) hands[i % n].push(deck[i]);

  // Открываем одну рандомную карту — у кого она, тот ходит первым
  const revealCard = deck[Math.floor(Math.random() * deck.length)];
  let firstPlayer = 0;
  for (let p = 0; p < n; p++) {
    if (hands[p].some(c => c.rank === revealCard.rank && c.suit === revealCard.suit)) {
      firstPlayer = p;
      break;
    }
  }

  return {
    hands,             // hands[playerIndex] = [{rank,suit},...]
    table: [],         // карты на столе
    pile: 0,           // сброс
    currentPlayer: firstPlayer,
    direction: -1,     // -1 против часовой, +1 по часовой
    phase: 'reveal',   // reveal → playing → gameover
    revealCard,
    firstPlayer,
    loser: null,
    n,
  };
}

function tryFlush(state) {
  if (state.table.length >= state.n) {
    state.pile += state.table.length;
    state.table = [];
    return true;
  }
  return false;
}

function checkEnd(state) {
  const alive = state.hands.map((h, i) => ({ i, len: h.length })).filter(x => x.len > 0);
  if (alive.length === 1) {
    state.loser = alive[0].i;
    state.phase = 'gameover';
    return true;
  }
  if (alive.length === 0) {
    state.phase = 'gameover';
    return true;
  }
  return false;
}

// Возвращает { ok: bool, event: string, ... } — описание произошедшего для клиентов
function applyPlay(state, playerIdx, cardIdx) {
  const hand = state.hands[playerIdx];
  if (!hand || cardIdx < 0 || cardIdx >= hand.length) return { ok: false, reason: 'Карты нет в руке' };
  if (state.currentPlayer !== playerIdx) return { ok: false, reason: 'Не ваш ход' };
  if (state.phase !== 'playing') return { ok: false, reason: 'Игра не в фазе игры' };

  const card = hand[cardIdx];
  const tableTop = state.table[state.table.length - 1];

  if (state.table.length > 0 && !canCover(tableTop, card)) {
    return { ok: false, reason: 'Нельзя покрыть этой картой' };
  }

  hand.splice(cardIdx, 1);
  state.table.push(card);

  const effect = cardEffect(card);
  let event = { type: 'play', playerIdx, card, tableTop: tableTop || null, effect };

  if (state.table.length === 0 || tableTop === undefined) {
    // Первый ход — просто кладём карту
  }

  if (effect.beatAll) {
    state.pile += state.table.length;
    state.table = [];
    state.direction *= -1;
    state.currentPlayer = playerIdx;
    event.flushed = true;
  } else if (effect.flip) {
    const flushed = tryFlush(state);
    event.flushed = flushed;
    state.direction *= -1;
    if (effect.right === 'thrower') {
      state.currentPlayer = playerIdx;
    } else {
      state.currentPlayer = nextIdx(state.n, playerIdx, state.direction);
    }
  } else {
    const flushed = tryFlush(state);
    event.flushed = flushed;
    state.currentPlayer = nextIdx(state.n, playerIdx, state.direction);
  }

  if (checkEnd(state)) event.gameover = true;
  return { ok: true, event };
}

function applyPickup(state, playerIdx) {
  if (state.currentPlayer !== playerIdx) return { ok: false, reason: 'Не ваш ход' };
  if (state.phase !== 'playing') return { ok: false, reason: 'Игра не в фазе игры' };
  if (state.table.length === 0) return { ok: false, reason: 'Стол пуст' };

  const taken = [...state.table];
  state.hands[playerIdx].push(...state.table);
  state.table = [];
  state.currentPlayer = nextIdx(state.n, playerIdx, state.direction);

  if (checkEnd(state)) return { ok: true, event: { type: 'pickup', playerIdx, taken, gameover: true } };
  return { ok: true, event: { type: 'pickup', playerIdx, taken } };
}

// ─── КОМНАТЫ ─────────────────────────────────────────────────────────────────
function findOrCreateRoom() {
  // Ищем комнату с ожиданием и не заполненную (< 4 игроков)
  for (const [id, room] of rooms) {
    if (room.phase === 'waiting' && room.players.length < 4) return room;
  }
  const id = generateRoomId();
  const room = { id, players: [], state: null, phase: 'waiting' };
  rooms.set(id, room);
  return room;
}

function broadcastRoom(room) {
  const playersInfo = room.players.map(p => ({
    userId: p.userId,
    name: p.name,
    ready: p.ready,
  }));
  const msg = JSON.stringify({ type: 'room_update', roomId: room.id, players: playersInfo });
  for (const p of room.players) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  }
}

function sendState(room) {
  const state = room.state;
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (p.ws.readyState !== WebSocket.OPEN) continue;
    // Каждый игрок видит только свои карты + количество карт остальных
    const handsView = state.hands.map((h, idx) => idx === i ? h : h.map(() => null));
    p.ws.send(JSON.stringify({
      type: 'game_state',
      myIndex: i,
      hands: handsView,
      table: state.table,
      pile: state.pile,
      currentPlayer: state.currentPlayer,
      direction: state.direction,
      phase: state.phase,
      revealCard: state.revealCard,
      firstPlayer: state.firstPlayer,
      loser: state.loser,
      players: room.players.map(pl => ({ userId: pl.userId, name: pl.name })),
    }));
  }
}

function broadcastEvent(room, event) {
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (p.ws.readyState !== WebSocket.OPEN) continue;
    p.ws.send(JSON.stringify({ type: 'game_event', myIndex: i, event }));
  }
}

function removePlayerFromRoom(ws) {
  for (const [id, room] of rooms) {
    const idx = room.players.findIndex(p => p.ws === ws);
    if (idx === -1) continue;
    room.players.splice(idx, 1);
    if (room.players.length === 0) {
      rooms.delete(id);
    } else {
      if (room.phase === 'playing') {
        // Если игра шла — сообщить остальным что игрок вышел
        broadcastEvent(room, { type: 'player_left', playerIdx: idx });
      }
      broadcastRoom(room);
    }
    break;
  }
}

// ─── WebSocket ОБРАБОТЧИК ─────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let playerRoom = null;
  let playerIdx = -1;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'join': {
        // { type:'join', userId, name }
        const room = findOrCreateRoom();
        const player = { ws, userId: msg.userId, name: msg.name || 'Игрок', ready: false };
        room.players.push(player);
        playerRoom = room;
        playerIdx = room.players.length - 1;
        ws.send(JSON.stringify({ type: 'joined', roomId: room.id, yourIndex: playerIdx }));
        broadcastRoom(room);
        break;
      }

      case 'ready': {
        // { type:'ready', isReady }
        if (!playerRoom) return;
        const p = playerRoom.players.find(pl => pl.ws === ws);
        if (p) p.ready = msg.isReady;
        broadcastRoom(playerRoom);
        // Запуск если все готовы (минимум 2)
        if (playerRoom.players.length >= 2 && playerRoom.players.every(pl => pl.ready)) {
          playerRoom.phase = 'playing';
          playerRoom.state = initGame(playerRoom.players);
          sendState(playerRoom);
        }
        break;
      }

      case 'reveal_done': {
        // Все подтвердили что увидели карту → начать игру
        if (!playerRoom || !playerRoom.state) return;
        if (playerRoom.state.phase === 'reveal') {
          // Ждём пока все подтвердят (счётчик)
          if (!playerRoom._revealConfirm) playerRoom._revealConfirm = new Set();
          playerRoom._revealConfirm.add(ws);
          if (playerRoom._revealConfirm.size >= playerRoom.players.length) {
            playerRoom.state.phase = 'playing';
            playerRoom._revealConfirm = null;
            sendState(playerRoom);
          }
        }
        break;
      }

      case 'play': {
        // { type:'play', cardIndex }
        if (!playerRoom || !playerRoom.state) return;
        const result = applyPlay(playerRoom.state, playerIdx, msg.cardIndex);
        if (!result.ok) {
          ws.send(JSON.stringify({ type: 'error', reason: result.reason }));
          return;
        }
        broadcastEvent(playerRoom, result.event);
        sendState(playerRoom);
        break;
      }

      case 'pickup': {
        if (!playerRoom || !playerRoom.state) return;
        const result = applyPickup(playerRoom.state, playerIdx);
        if (!result.ok) {
          ws.send(JSON.stringify({ type: 'error', reason: result.reason }));
          return;
        }
        broadcastEvent(playerRoom, result.event);
        sendState(playerRoom);
        break;
      }

    }
  });

  ws.on('close', () => {
    removePlayerFromRoom(ws);
  });

  ws.on('error', () => {
    removePlayerFromRoom(ws);
  });
});

server.listen(PORT, () => {
  console.log(`67 Game Server listening on port ${PORT}`);
});
