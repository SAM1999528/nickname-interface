require('dotenv').config(); // Load environment variables from .env file
const express = require("express");
const cors = require("cors");
const mysql = require('mysql2/promise'); // Import mysql2/promise for async/await
const { pinyin } = require('pinyin-pro'); // Import pinyin-pro for homophone check

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve static files from 'public' folder

// 根路径路由 - 返回 index.html
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

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
  connectTimeout: 5000 // 5 seconds timeout
});

// Helper: Get common characters count between two strings
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

// Helper: Get pinyin string (without tones)
function getCleanPinyin(text) {
  return pinyin(text, { toneType: 'none', type: 'array' }).join('');
}

// Helper: Check similarity based on your rules (2-char overlap or homophones)
function isSimilar(target, candidate) {
  // 1. Check if they share at least 2 characters (两字重复)
  if (getCommonCharsCount(target, candidate) >= 2) return true;
  
  // 2. Check if they are homophones (谐音相同)
  if (getCleanPinyin(target) === getCleanPinyin(candidate)) return true;
  
  return false;
}

// Utility function to get random unique items from a source array
function getRandomUniqueItems(source, count) {
  const pool = [...source];
  const limit = Math.min(count, pool.length);
  // Fisher-Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, limit);
}

// New endpoint to get 9 random unique nicknames
app.get("/api/nicknames", async (req, res) => {
  try {
    const [rows] = await pool.execute("SELECT 花名 FROM nick_name WHERE 释放情况 = '可释放'");
    const nicknamePool = rows.map(row => row.花名);
    const nicknames = getRandomUniqueItems(nicknamePool, 9);
    res.json({ nicknames });
  } catch (error) {
    console.error("Error fetching nicknames from database:", error.message);
    res.status(500).json({ message: "Error fetching nicknames", error: error.message });
  }
});

// Existing endpoint, now also using the new utility function
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
    console.error("Error fetching single nickname from database:", error.message);
    res.status(500).json({ message: "Error fetching nickname", error: error.message });
  }
});

// Confirm and sync endpoint based on flowchart
app.post("/api/confirm-nickname", async (req, res) => {
  const { nickname, employeeId } = req.body;
  
  if (!nickname) {
    return res.status(400).json({ message: "Nickname is required" });
  }

  try {
    // 1. Fetch all currently '可释放' nicknames to check for similarity
    const [rows] = await pool.execute("SELECT 花名 FROM nick_name WHERE 释放情况 = '可释放'");
    const allReleasable = rows.map(row => row.花名);
    
    // 2. Identify similar nicknames that should be locked
    const similarNicknames = allReleasable.filter(name => isSimilar(nickname, name));
    
    // Always include the picked nickname itself just in case
    if (!similarNicknames.includes(nickname)) {
      similarNicknames.push(nickname);
    }
    
    // 3. Batch update their status to '不可释放'
    if (similarNicknames.length > 0) {
      const placeholders = similarNicknames.map(() => '?').join(',');
      const updateQuery = `UPDATE nick_name SET 释放情况 = '不可释放' WHERE 花名 IN (${placeholders})`;
      await pool.execute(updateQuery, similarNicknames);
      console.log(`Locked ${similarNicknames.length} nicknames: ${similarNicknames.join(', ')}`);
    }
    
    // 4. Simulate sync to Beisen
    console.log(`Syncing employee ${employeeId} with nickname ${nickname} to Beisen...`);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate delay
    
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

// NEW: Record employee departure and calculate release schedule
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
    
    let releaseDate = null; // null means never release
    let newStatus = '不可释放';

    // Rule (3): Special Departments (修合汤, 将军汤) - Never release
    if (department === '修合汤' || department === '将军汤') {
      releaseDate = null;
      newStatus = '永久锁定';
    } 
    // Rule (1): Formal employees - Never release
    else if (isFormal) {
      releaseDate = null;
      newStatus = '永久锁定';
    } 
    // Rule (2): Non-formal employees
    else {
      if (tenureDays <= 7) {
        // Use < 1 week: Release after 1 month
        releaseDate = new Date(depDate);
        releaseDate.setMonth(releaseDate.getMonth() + 1);
      } else if (tenureDays <= 30) {
        // Use < 1 month: Release after 3 months
        releaseDate = new Date(depDate);
        releaseDate.setMonth(releaseDate.getMonth() + 3);
      } else if (tenureDays <= 90) {
        // Use 1-3 months: Release after 2 years
        releaseDate = new Date(depDate);
        releaseDate.setFullYear(releaseDate.getFullYear() + 2);
      } else {
        // More than 3 months but not formal? 
        // Based on your rules, 1 year+ tenure is similar to formal for similarity check.
        // Assuming > 3 months non-formal follows the 2-year rule or is manual.
        releaseDate = new Date(depDate);
        releaseDate.setFullYear(releaseDate.getFullYear() + 2);
      }
      newStatus = '离职冻结中';
    }

    // Update database with release info
    // Note: You need to add '预计释放日期' column to your table
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

// NEW: Manual trigger to check and release expired nicknames
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

// 本地开发时启动服务器
if (process.env.NODE_ENV !== 'production') {
  app.listen(port, () => {
    console.log(`Nickname API listening on port ${port}`);
  });
}

// Vercel Serverless 导出
module.exports = app;
