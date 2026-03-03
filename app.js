require('dotenv').config();
const express = require("express");
const cors = require("cors");
const mysql = require('mysql2/promise');
const { pinyin } = require('pinyin-pro');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Configure MySQL connection pool
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: process.env.MYSQL_PORT || 3306,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 5000
});

// Helper functions
function getCommonCharsCount(s1, s2) {
  const chars1 = [...s1];
  const chars2 = [...s2];
  let count = 0;
  const set2 = new Map();
  chars2.forEach(c => set2.set(c, (set2.get(c) || 0) + 1));
  
  for (const c of chars1) {
    if (set2.get(c) > 0) {
      count++;
      set2.set(c, set2.get(c) - 1);
    }
  }
  return count;
}

function getCleanPinyin(text) {
  return pinyin(text, { toneType: 'none', type: 'array' }).join('');
}

function isSimilar(target, candidate) {
  if (getCommonCharsCount(target, candidate) >= 2) return true;
  if (getCleanPinyin(target) === getCleanPinyin(candidate)) return true;
  return false;
}

function getRandomUniqueItems(source, count) {
  const pool = [...source];
  const limit = Math.min(count, pool.length);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, limit);
}

// API Routes
app.get("/api/nicknames", async (req, res) => {
  try {
    const [rows] = await pool.execute("SELECT 花名 FROM nick_name WHERE 释放情况 = '可释放'");
    const nicknamePool = rows.map(row => row.花名);
    const nicknames = getRandomUniqueItems(nicknamePool, 9);
    res.json({ nicknames });
  } catch (error) {
    console.error("Error fetching nicknames:", error.message);
    res.status(500).json({ message: "Error fetching nicknames", error: error.message });
  }
});

app.get("/api/nickname", async (req, res) => {
  try {
    const [rows] = await pool.execute("SELECT 花名 FROM nick_name WHERE 释放情况 = '可释放'");
    const nicknamePool = rows.map(row => row.花名);
    if (nicknamePool.length === 0) {
      return res.status(404).json({ message: "No releasable nicknames found." });
    }
    const nicknames = getRandomUniqueItems(nicknamePool, 1);
    res.json({ nickname: nicknames[0] });
  } catch (error) {
    console.error("Error fetching nickname:", error.message);
    res.status(500).json({ message: "Error fetching nickname", error: error.message });
  }
});

app.post("/api/confirm-nickname", async (req, res) => {
  const { nickname, employeeId } = req.body;
  
  if (!nickname) {
    return res.status(400).json({ message: "Nickname is required" });
  }

  try {
    const [rows] = await pool.execute("SELECT 花名 FROM nick_name WHERE 释放情况 = '可释放'");
    const allReleasable = rows.map(row => row.花名);
    
    const similarNicknames = allReleasable.filter(name => isSimilar(nickname, name));
    
    if (!similarNicknames.includes(nickname)) {
      similarNicknames.push(nickname);
    }
    
    if (similarNicknames.length > 0) {
      const placeholders = similarNicknames.map(() => '?').join(',');
      const updateQuery = `UPDATE nick_name SET 释放情况 = '不可释放' WHERE 花名 IN (${placeholders})`;
      await pool.execute(updateQuery, similarNicknames);
      console.log(`Locked ${similarNicknames.length} nicknames: ${similarNicknames.join(', ')}`);
    }
    
    console.log(`Syncing employee ${employeeId} with nickname ${nickname} to Beisen...`);
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    res.json({ 
      success: true, 
      message: `Nickname assigned and ${similarNicknames.length} similar nicknames locked.`,
      lockedCount: similarNicknames.length 
    });
  } catch (error) {
    console.error("Error confirming nickname:", error.message);
    res.status(500).json({ message: "Failed to confirm nickname", error: error.message });
  }
});

app.post("/api/record-departure", async (req, res) => {
  const { nickname, departureDate, isFormal, department, joinDate } = req.body;
  
  if (!nickname || !departureDate) {
    return res.status(400).json({ message: "Nickname and departureDate are required" });
  }

  try {
    const depDate = new Date(departureDate);
    const jDate = new Date(joinDate);
    const tenureMs = depDate - jDate;
    const tenureDays = tenureMs / (1000 * 60 * 60 * 24);
    
    let releaseDate = null;
    let newStatus = '不可释放';

    if (department === '修合汤' || department === '将军汤') {
      releaseDate = null;
      newStatus = '永久锁定';
    } else if (isFormal) {
      releaseDate = null;
      newStatus = '永久锁定';
    } else {
      if (tenureDays <= 7) {
        releaseDate = new Date(depDate);
        releaseDate.setMonth(releaseDate.getMonth() + 1);
      } else if (tenureDays <= 30) {
        releaseDate = new Date(depDate);
        releaseDate.setMonth(releaseDate.getMonth() + 3);
      } else if (tenureDays <= 90) {
        releaseDate = new Date(depDate);
        releaseDate.setFullYear(releaseDate.getFullYear() + 2);
      } else {
        releaseDate = new Date(depDate);
        releaseDate.setFullYear(releaseDate.getFullYear() + 2);
      }
      newStatus = '离职冻结中';
    }

    const query = `
      UPDATE nick_name 
      SET 释放情况 = ?, 预计释放日期 = ? 
      WHERE 花名 = ?
    `;
    await pool.execute(query, [newStatus, releaseDate, nickname]);

    res.json({ 
      success: true, 
      nickname, 
      status: newStatus, 
      estimatedRelease: releaseDate ? releaseDate.toISOString().split('T')[0] : 'Never' 
    });
  } catch (error) {
    console.error("Error recording departure:", error.message);
    res.status(500).json({ message: "Failed to record departure", error: error.message });
  }
});

app.get("/api/check-releases", async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const [rows] = await pool.execute(
      "UPDATE nick_name SET 释放情况 = '可释放', 预计释放日期 = NULL WHERE 释放情况 = '离职冻结中' AND 预计释放日期 <= ?",
      [today]
    );
    res.json({ success: true, releasedCount: rows.affectedRows });
  } catch (error) {
    console.error("Error checking releases:", error.message);
    res.status(500).json({ message: "Failed to check releases" });
  }
});

// Serve static files from public directory
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

// Root route - serve index.html
app.get('/', (req, res) => {
  const indexPath = path.join(publicPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('index.html not found');
  }
});

// Catch-all route - serve index.html for any other route
app.get('*', (req, res) => {
  const indexPath = path.join(publicPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('index.html not found');
  }
});

// Local development
if (process.env.NODE_ENV !== 'production') {
  app.listen(port, () => {
    console.log(`Nickname API listening on port ${port}`);
  });
}

module.exports = app;
