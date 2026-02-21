const express = require("express");
const app = express();
const http = require("http").createServer(app);
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const wss = new WebSocket.Server({ server: http });

let clients = [];

// Create audio and uploads directories if they don't exist
const audioDir = path.join(__dirname, "public", "audio");
const uploadsDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
}
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Sanitize filename
function sanitizeFilename(zoneName, audioKey) {
  const sanitized = zoneName.replace(/\s+/g, '_').toLowerCase();
  return `${sanitized}_${audioKey}.mp3`;
}

// Reverse: convert filename back to zone name and audio key
function parseFilename(filename) {
  // e.g., "speaker_1_audio1.mp3" → {zone: "Speaker 1", audioKey: "audio1"}
  const name = filename.replace('.mp3', '');
  const parts = name.split('_');
  
  if(parts.length >= 3) {
    const audioKey = parts.pop(); // "audio1" or "audio2"
    const zoneName = parts.join(' '); // "speaker 1" → capitalize
    const zone = zoneName.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return { zone, audioKey };
  }
  return null;
}

// Load audio files from disk on startup
function loadAudioFilesFromDisk() {
  const audioFiles = {};
  
  if(fs.existsSync(audioDir)) {
    const files = fs.readdirSync(audioDir);
    
    files.forEach(file => {
      if(file.endsWith('.mp3')) {
        const parsed = parseFilename(file);
        if(parsed) {
          const { zone, audioKey } = parsed;
          
          if(!audioFiles[zone]) {
            audioFiles[zone] = {};
          }
          
          audioFiles[zone][audioKey] = {
            url: `/audio/${file}`,
            filename: file
          };
          
          console.log(`Loaded: ${file}`);
        }
      }
    });
  }
  
  return audioFiles;
}

// Load background image URL from disk if it exists
function loadBackgroundImage() {
  const bgPath = path.join(uploadsDir, "background.jpg");
  if(fs.existsSync(bgPath)) {
    return `/uploads/background.jpg?t=${Date.now()}`;
  }
  return null;
}

// Global system state
let state = {
  audio: loadAudioFilesFromDisk(),      // Load persisted audio files
  playing: {},    // playing[zone] = audioKey
  background: loadBackgroundImage()  // Load persisted background
};

wss.on("connection", (ws) => {
  clients.push(ws);

  // Send current state to new client
  ws.send(JSON.stringify({type:"sync", state}));

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    // Handle audio file upload
    if(data.type === "audio"){
      if(!state.audio[data.zone]) state.audio[data.zone]={};
      
      // Extract base64 data and save to file
      const base64Data = data.data.split(',')[1];
      const filename = sanitizeFilename(data.zone, data.audioKey);
      const filepath = path.join(audioDir, filename);
      
      fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'));
      
      // Store reference
      state.audio[data.zone][data.audioKey] = {
        url: `/audio/${filename}`,
        filename: filename
      };
      
      console.log(`Audio saved: ${filename}`);
    }

    if(data.type === "play"){
      state.playing[data.zone] = data.audioKey;
    }

    if(data.type === "stop"){
      delete state.playing[data.zone];
    }

    if(data.type === "bg"){
      // Extract base64 data and save to file
      const base64Data = data.img.split(',')[1];
      const filepath = path.join(uploadsDir, "background.jpg");
      
      fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'));
      
      // Update state with file URL instead of base64
      state.background = `/uploads/background.jpg?t=${Date.now()}`;
      console.log("Background image saved");
    }

    // Broadcast to all clients
    clients.forEach(c => {
      if(c.readyState === WebSocket.OPEN){
        c.send(JSON.stringify(data));
      }
    });
  });

  ws.on("close", () => {
    clients = clients.filter(c => c !== ws);
  });
});

app.use(express.static("public"));

// Enable range requests for audio streaming
app.get('/audio/:filename', (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(audioDir, filename);
  
  // Security: ensure file is in audio directory
  if(!filepath.startsWith(audioDir)) {
    return res.status(403).send('Forbidden');
  }
  
  if(!fs.existsSync(filepath)) {
    return res.status(404).send('Not found');
  }
  
  const stat = fs.statSync(filepath);
  const fileSize = stat.size;
  
  // Handle range requests
  const range = req.headers.range;
  if(range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    
    if(start >= fileSize) {
      res.status(416).send('Requested Range Not Satisfiable');
      return;
    }
    
    res.status(206);
    res.header('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.header('Accept-Ranges', 'bytes');
    res.header('Content-Length', (end - start + 1));
    res.header('Content-Type', 'audio/mpeg');
    
    fs.createReadStream(filepath, { start, end }).pipe(res);
  } else {
    res.header('Accept-Ranges', 'bytes');
    res.header('Content-Type', 'audio/mpeg');
    res.header('Content-Length', fileSize);
    fs.createReadStream(filepath).pipe(res);
  }
});

app.get('/uploads/:filename', (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(uploadsDir, filename);
  
  // Security: ensure file is in uploads directory
  if(!filepath.startsWith(uploadsDir)) {
    return res.status(403).send('Forbidden');
  }
  
  if(!fs.existsSync(filepath)) {
    return res.status(404).send('Not found');
  }
  
  res.header('Content-Type', 'image/jpeg');
  res.sendFile(filepath);
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log("Server running on port " + PORT));