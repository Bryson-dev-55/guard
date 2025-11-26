const express = require('express');
const axios = require('axios');
const path = require('path');
const bodyParser = require('body-parser');
const app = express();

app.use(express.json());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const total = new Map();
const guardSessions = new Map();

// Serve the main HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Get all guard sessions
app.get('/total', (req, res) => {
  const data = Array.from(total.values()).map((link, index) => ({
    session: index + 1,
    url: link.url,
    count: link.count,
    id: link.id,
    target: link.target,
  }));
  res.json(JSON.parse(JSON.stringify(data || [], null, 2)));
});

// Get guard sessions for profile guard
app.get('/api/sessions', (req, res) => {
  const sessions = Array.from(guardSessions.values());
  res.json(sessions);
});

// Submit appstate for profile guard
app.post('/api/guard/login', async (req, res) => {
  const { appstate } = req.body;

  if (!appstate) {
    return res.status(400).json({
      status: 400,
      error: 'Missing appstate'
    });
  }

  try {
    const cookies = await convertCookie(appstate);
    if (!cookies) {
      return res.status(400).json({
        status: 400,
        error: 'Invalid appstate format'
      });
    }

    // Get user info
    const accessToken = await getAccessToken(cookies);
    if (!accessToken) {
      return res.status(400).json({
        status: 400,
        error: 'Unable to get access token. Please check your appstate.'
      });
    }

    // Extract user ID from appstate
    const appstateArr = JSON.parse(appstate);
    const cUserCookie = appstateArr.find(c => c.key === 'c_user');
    const userId = cUserCookie ? cUserCookie.value : 'unknown';

    // Store session
    const sessionId = Date.now().toString();
    guardSessions.set(sessionId, {
      id: sessionId,
      userId,
      cookies,
      accessToken,
      enabled: false,
      createdAt: new Date().toISOString()
    });

    res.status(200).json({
      status: 200,
      sessionId,
      userId,
      message: 'Login successful'
    });
  } catch (err) {
    return res.status(500).json({
      status: 500,
      error: err.message || 'An error occurred'
    });
  }
});

// Toggle profile guard
app.post('/api/guard/toggle', async (req, res) => {
  const { sessionId, enabled } = req.body;

  if (!sessionId) {
    return res.status(400).json({
      status: 400,
      error: 'Missing sessionId'
    });
  }

  const session = guardSessions.get(sessionId);
  if (!session) {
    return res.status(404).json({
      status: 404,
      error: 'Session not found'
    });
  }

  session.enabled = enabled;
  guardSessions.set(sessionId, session);

  res.status(200).json({
    status: 200,
    enabled: session.enabled,
    message: `Profile guard ${enabled ? 'enabled' : 'disabled'}`
  });
});

// Logout
app.post('/api/guard/logout', async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({
      status: 400,
      error: 'Missing sessionId'
    });
  }

  guardSessions.delete(sessionId);

  res.status(200).json({
    status: 200,
    message: 'Logout successful'
  });
});

// Original share post endpoint
app.post('/api/submit', async (req, res) => {
  const {
    cookie,
    url,
    amount,
    interval,
  } = req.body;

  if (!cookie || !url || !amount || !interval) {
    return res.status(400).json({
      error: 'Missing state, url, amount, or interval'
    });
  }

  try {
    const cookies = await convertCookie(cookie);
    if (!cookies) {
      return res.status(400).json({
        status: 500,
        error: 'Invalid cookies'
      });
    }

    await share(cookies, url, amount, interval);
    
    res.status(200).json({
      status: 200
    });
  } catch (err) {
    return res.status(500).json({
      status: 500,
      error: err.message || err
    });
  }
});

// Share function
async function share(cookies, url, amount, interval) {
  const id = await getPostID(url);
  const accessToken = await getAccessToken(cookies);
  
  if (!id) {
    throw new Error("Unable to get link id: invalid URL, it's either a private post or visible to friends only");
  }

  const postId = total.has(id) ? id + '_' + Date.now() : id;
  total.set(postId, {
    url,
    id,
    count: 0,
    target: amount,
  });

  const headers = {
    'accept': '*/*',
    'accept-encoding': 'gzip, deflate',
    'connection': 'keep-alive',
    'content-length': '0',
    'cookie': cookies,
    'host': 'graph.facebook.com'
  };

  let sharedCount = 0;
  let timer;

  async function sharePost() {
    try {
      const response = await axios.post(
        `https://graph.facebook.com/me/feed?link=https://m.facebook.com/${id}&published=0&access_token=${accessToken}`,
        {},
        { headers }
      );

      if (response.status === 200) {
        total.set(postId, {
          ...total.get(postId),
          count: total.get(postId).count + 1,
        });
        sharedCount++;
      }

      if (sharedCount === amount) {
        clearInterval(timer);
        // Keep in total for 5 minutes after completion
        setTimeout(() => {
          total.delete(postId);
        }, 300000);
      }
    } catch (error) {
      console.error('Share error:', error.message);
      clearInterval(timer);
      total.delete(postId);
    }
  }

  timer = setInterval(sharePost, interval * 1000);

  // Cleanup after max time
  setTimeout(() => {
    clearInterval(timer);
    setTimeout(() => {
      total.delete(postId);
    }, 300000);
  }, amount * interval * 1000);
}

// Get post ID from URL
async function getPostID(url) {
  try {
    const response = await axios.post(
      'https://id.traodoisub.com/api.php',
      `link=${encodeURIComponent(url)}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
    return response.data.id;
  } catch (error) {
    console.error('Get post ID error:', error.message);
    return null;
  }
}

// Get access token from cookies
async function getAccessToken(cookie) {
  try {
    const headers = {
      'authority': 'business.facebook.com',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
      'accept-language': 'vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5',
      'cache-control': 'max-age=0',
      'cookie': cookie,
      'referer': 'https://www.facebook.com/',
      'sec-ch-ua': '".Not/A)Brand";v="99", "Google Chrome";v="103", "Chromium";v="103"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Linux"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
    };

    const response = await axios.get('https://business.facebook.com/content_management', {
      headers
    });

    const token = response.data.match(/"accessToken":\s*"([^"]+)"/);
    if (token && token[1]) {
      return token[1];
    }
    return null;
  } catch (error) {
    console.error('Get access token error:', error.message);
    return null;
  }
}

// Convert appstate to cookie string
async function convertCookie(cookie) {
  return new Promise((resolve, reject) => {
    try {
      const cookies = JSON.parse(cookie);
      
      if (!Array.isArray(cookies)) {
        reject("Invalid appstate format: must be an array");
        return;
      }

      const sbCookie = cookies.find(c => c.key === "sb");
      if (!sbCookie) {
        reject("Detect invalid appstate: missing 'sb' cookie");
        return;
      }

      const sbValue = sbCookie.value;
      const data = `sb=${sbValue}; ${cookies.slice(1).map(c => `${c.key}=${c.value}`).join('; ')}`;
      resolve(data);
    } catch (error) {
      reject("Error processing appstate: " + error.message);
    }
  });
}

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`FB Profile Guard server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to access the application`);
});
