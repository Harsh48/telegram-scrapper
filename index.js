const api = require('./api');
const prompt = require('prompt');
const { t1 } = require('@mtproto/core');
const express = require('express')
const app = express()
const cors = require('cors')
const { v4: uuidv4 } = require('uuid');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');



// In-memory store for unique user IDs
let uniqueUsers = new Set();

// Add cache configuration
const CACHE_FILE = path.join(__dirname, 'telegram_cache.json');
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds
let messageCache = {
  timestamp: 0,
  messages: []
};

// Load cache from file if it exists
try {
  if (fs.existsSync(CACHE_FILE)) {
    messageCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  }
} catch (error) {
  console.log('Error loading cache:', error);
}

app.use(cors({
  origin: ['http://localhost:5173','https://www.bitcoinprice.live'], // Frontend origin
  credentials: true, // Allow cookies and other credentials
}));

app.use(cookieParser());

app.use((req, res, next) => {
  let userId = req.cookies.userId;
  console.log({userId})

  if (!userId) {
    userId = uuidv4();
    res.cookie('userId', userId,  { httpOnly: true, secure: true, sameSite: 'None'  });
  }

  // Add the user ID to the set if it's not already present
  uniqueUsers.add(userId);
  next();
});


// Endpoint to get the count of unique users
app.get('/uniqueUserCount', (req, res) => {
  res.json({ count: uniqueUsers.size });
});

// Fetch user details
async function getUser() {
  try {
    const user = await api.call("users.getFullUser", {
      id: { _: "inputUserSelf" },
    });
    return user;
  } catch (error) {
    return null;
  }
}

// Sign in using phone code
function signIn({ code, phone, phone_code_hash }) {
  return api
    .call("auth.signIn", {
      phone_code: code,
      phone_number: phone,
      phone_code_hash: phone_code_hash,
    })
    .then((v) => {
      console.log("LOGIN SUCCESS: ", v);
      return v;
    })
    .catch((e) => {
      console.log("LOGIN FAIL: ", e);
      throw e;
    });
}

// Send verification code to phone number
function sendCode(phone) {
  return api.call("auth.sendCode", {
    phone_number: phone,
    settings: { _: "codeSettings" },
  });
}

// Helper function to handle flood wait errors
async function callApiWithRetry(method, params) {
  while (true) {
    try {
      return await api.call(method, params);
    } catch (error) {
      if (error.error_message && error.error_message.startsWith('FLOOD_WAIT_')) {
        const waitTime = parseInt(error.error_message.split('_')[2], 10);
        console.log(`Flood wait for ${waitTime} seconds`);
        await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
      } else {
        throw error;
      }
    }
  }
}

// Helper function to add a delay
async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Add this function to handle initial authentication
async function initializeAuthentication() {
  console.log('Checking authentication status...');
  const user = await getUser();
  
  if (!user) {
    console.log('Authentication required. Please sign in:');
    prompt.start();
    
    try {
      const { phone } = await prompt.get("phone");
      const { phone_code_hash } = await sendCode(phone);
      console.log('Verification code sent. Please check your phone.');
      const { code } = await prompt.get("code");
      
      await signIn({ code, phone, phone_code_hash });
      console.log('Authentication successful!');
    } catch (error) {
      console.error('Authentication failed:', error);
      process.exit(1);
    }
  } else {
    console.log('Already authenticated!');
  }
}

// Modify the server start to handle authentication first
async function startServer() {
  await initializeAuthentication();
  
  app.listen(3010, () => {
    console.log('Server running on port 3010');
  });
}

// Start the server
startServer();

// Add a flag to track ongoing updates
let isUpdatingCache = false;

// Add timestamp for last update attempt
let lastUpdateAttempt = 0;
const MIN_UPDATE_INTERVAL = 10 * 60 * 1000; // 10 minutes between update attempts

// Modify the /telegram endpoint to remove the authentication logic
app.get('/telegram', async (req, res) => {
  const now = Date.now();
  
  // If cache exists, serve it
  if (messageCache.messages.length > 0) {
    // Trigger background update only if:
    // 1. Cache is stale
    // 2. No update is currently running
    // 3. Enough time has passed since last attempt
    if ((now - messageCache.timestamp) > CACHE_DURATION && 
        !isUpdatingCache && 
        (now - lastUpdateAttempt) > MIN_UPDATE_INTERVAL) {
      updateCacheInBackground();
    }
    return res.json(messageCache.messages);
  }

  // If no cache exists, fetch directly
  try {
    // Rest of your existing telegram endpoint code, but remove the authentication part
    const resolvedPeer = await callApiWithRetry('contacts.resolveUsername', {
      username: 'magiccraftgamechat',
    });

    const channel = resolvedPeer.chats.find(
      (chat) => chat.id === resolvedPeer.peer.channel_id
    );

    const inputPeer = {
      _: 'inputPeerChannel',
      channel_id: channel.id,
      access_hash: channel.access_hash,
    };

    const LIMIT_COUNT = req.query.limit?req.query.limit: 0
    const allMessages = [];
    const firstHistoryResult = await callApiWithRetry('messages.getHistory', {
      peer: inputPeer,
      limit: LIMIT_COUNT,
    });

    const historyCount = firstHistoryResult.count;

    // Fetch message history in chunks with delay
    for (let offset = 0; offset < 300; offset += 100) {
      try {
        const history = await callApiWithRetry('messages.getHistory', {
          peer: inputPeer,
          add_offset: offset,
          limit: 300,
        });

        for(let i of history.messages){
          if(i.message!=''){
            for(let j of history.users){
              if(i.from_id && i.message!=''){
                if(i.from_id.user_id==j.id){
                  allMessages.push({
                    message: i.message,
                    username: j?.username, 
                    firstName: j.first_name, 
                    lastName: j.last_name,
                    timestamp: new Date(i.date*1000).toISOString()
                  });
                }
              }
            }
          }
        }
        await delay(1000);
      } catch (error) {
        console.log('Error fetching message history:', error);
        break;
      }
    }

    // Update cache with new messages
    messageCache = {
      timestamp: now,
      messages: allMessages
    };
    
    // Save cache to file
    fs.writeFileSync(CACHE_FILE, JSON.stringify(messageCache));
    
    res.json(allMessages);
  } catch (error) {
    console.error('Error in /telegram endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function updateCacheInBackground() {
  if (isUpdatingCache) return;
  
  isUpdatingCache = true;
  lastUpdateAttempt = Date.now();
  
  try {
    console.log('Starting background cache update...');
    
    // Add more aggressive delays between API calls
    const history = await callApiWithRetry('messages.getHistory', {
      // ... existing params ...
    });
    
    // Add longer delay between chunks
    await delay(2000); // 2 seconds between chunks
    
    // ... rest of update logic ...
    
    messageCache = {
      timestamp: Date.now(),
      messages: allMessages
    };
    
    fs.writeFileSync(CACHE_FILE, JSON.stringify(messageCache));
    console.log('Cache updated successfully');
  } catch (error) {
    console.error('Error updating cache:', error);
  } finally {
    isUpdatingCache = false;
  }
}