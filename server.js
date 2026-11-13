const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Serve index.html for all room routes so client-side router handles it
app.get('/room/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PREMADE_SPECTRUMS = [
  ["Cold", "Hot"],
  ["Overrated", "Underrated"],
  ["Terrible Movie", "Masterpiece"],
  ["Useless Superpower", "God-Tier Superpower"],
  ["Guilty Pleasure", "Openly Loved"],
  ["Bad First Date", "Great First Date"],
  ["Smells Terrible", "Smells Amazing"],
  ["Needs Luck", "Needs Skill"],
  ["Snack", "Full Meal"],
  ["Mainstream", "Niche"],
  ["Harmless", "Deadly"],
  ["Ancient", "Futuristic"]
];

const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return rooms[code] ? generateRoomCode() : code;
}

function getNextSpectrum(room) {
  if (room.promptMode === 'custom' && room.customSpectrums.length > 0) {
    // Pick randomly from custom list
    const idx = Math.floor(Math.random() * room.customSpectrums.length);
    return room.customSpectrums[idx];
  } else {
    // Premade list
    if (room.usedPremadeIndices.length >= PREMADE_SPECTRUMS.length) {
      room.usedPremadeIndices = [];
    }
    let idx;
    do {
      idx = Math.floor(Math.random() * PREMADE_SPECTRUMS.length);
    } while (room.usedPremadeIndices.includes(idx));
    room.usedPremadeIndices.push(idx);
    return PREMADE_SPECTRUMS[idx];
  }
}

function startNewRound(room) {
  room.round += 1;
  room.psychicIndex = room.round % 2 === 1 ? 0 : 1;
  room.target = Math.floor(Math.random() * 81) + 10;
  room.spectrum = getNextSpectrum(room);
  room.clue = '';
  room.guess = 50;
  room.phase = 'CLUE';
  room.lastPoints = 0;
}

function emitRoomState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.players.forEach((player, index) => {
    const isPsychic = index === room.psychicIndex;
    const visibleTarget = (isPsychic || room.phase === 'REVEAL') ? room.target : null;

    io.to(player.id).emit('gameState', {
      roomCode,
      players: room.players.map(p => ({ name: p.name, score: p.score })),
      youIndex: index,
      isPsychic,
      round: room.round,
      phase: room.phase,
      spectrum: room.spectrum,
      target: visibleTarget,
      clue: room.clue,
      guess: room.guess,
      lastPoints: room.lastPoints,
      winningScore: room.winningScore,
      winner: room.winner
    });
  });
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ playerName, winningScore, promptMode, customSpectrums }) => {
    const code = generateRoomCode();
    rooms[code] = {
      players: [{ id: socket.id, name: playerName || 'Player 1', score: 0 }],
      round: 0,
      winningScore: Number(winningScore) || 10,
      promptMode: promptMode || 'premade',
      customSpectrums: customSpectrums || [],
      usedPremadeIndices: [],
      psychicIndex: 0,
      target: 50,
      spectrum: ["Cold", "Hot"],
      clue: '',
      guess: 50,
      phase: 'WAITING',
      lastPoints: 0,
      winner: null
    };
    socket.join(code);
    socket.roomCode = code;
    socket.emit('roomCreated', code);
    emitRoomState(code);
  });

  socket.on('joinRoom', ({ code, playerName }) => {
    const roomCode = (code || '').toUpperCase().trim();
    const room = rooms[roomCode];

    if (!room) return socket.emit('errorMsg', 'Room not found.');
    if (room.players.length >= 2) return socket.emit('errorMsg', 'Room is already full.');

    room.players.push({ id: socket.id, name: playerName || 'Player 2', score: 0 });
    socket.join(roomCode);
    socket.roomCode = roomCode;

    startNewRound(room);
    emitRoomState(roomCode);
  });

  socket.on('submitClue', (clue) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'CLUE') return;
    if (room.players[room.psychicIndex]?.id !== socket.id) return;

    room.clue = clue.trim();
    room.phase = 'GUESS';
    emitRoomState(socket.roomCode);
  });

  socket.on('updateDial', (value) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'GUESS') return;
    room.guess = Number(value);
    socket.to(socket.roomCode).emit('dialMoved', room.guess);
  });

  socket.on('lockGuess', (finalGuess) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'GUESS') return;
    if (room.players[room.psychicIndex]?.id === socket.id) return;

    room.guess = Number(finalGuess);
    const diff = Math.abs(room.target - room.guess);

    let points = 0;
    if (diff <= 4) points = 4;
    else if (diff <= 10) points = 3;
    else if (diff <= 16) points = 2;

    room.lastPoints = points;
    const guesserIndex = room.psychicIndex === 0 ? 1 : 0;
    room.players[guesserIndex].score += points;
    if (points === 4) room.players[room.psychicIndex].score += 1;

    // Check win condition
    if (room.players[guesserIndex].score >= room.winningScore) {
      room.winner = room.players[guesserIndex].name;
    } else if (room.players[room.psychicIndex].score >= room.winningScore) {
      room.winner = room.players[room.psychicIndex].name;
    }

    room.phase = 'REVEAL';
    emitRoomState(socket.roomCode);
  });

  socket.on('nextRound', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'REVEAL') return;
    if (room.winner) {
      // Reset game if wanted, or stay
      return;
    }
    startNewRound(room);
    emitRoomState(socket.roomCode);
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (code && rooms[code]) {
      io.to(code).emit('errorMsg', 'The other player disconnected.');
      delete rooms[code];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Wavy server running on port ${PORT}`);
});