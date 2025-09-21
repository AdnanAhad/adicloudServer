const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const cors = require("cors");
const cookieSession = require("cookie-session");

async function ensurePdfRepo(token) {
  // 1. Get authenticated user info
  const userRes = await axios.get("https://api.github.com/user", {
    headers: { Authorization: `token ${token}` },
  });
  const username = userRes.data.login;

  // 2. Check if repo already exists
  try {
    await axios.get(`https://api.github.com/repos/${username}/pdf-storage`, {
      headers: { Authorization: `token ${token}` },
    });
    console.log("Repo already exists ✅");
    return { exists: true, username };
  } catch (err) {
    if (err.response && err.response.status === 404) {
      // 3. Create repo if not found
      await axios.post(
        "https://api.github.com/user/repos",
        {
          name: "pdf-storage",
          description: "My personal PDF storage",
          private: false,
        },
        {
          headers: { Authorization: `token ${token}` },
        }
      );
      console.log("Repo created ✅");
      return { created: true, username };
    }
    throw err;
  }
}

dotenv.config();

const app = express();

app.use(express.json());

// Middleware
app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    credentials: true,
  })
);

app.use(
  cookieSession({
    name: "session",
    keys: [process.env.SESSION_SECRET],
    maxAge: 24 * 60 * 60 * 1000, // 1 day
  })
);

app.get("/", (req, res) => {
  res.send("Server is running 🚀");
});

// Step 1: Redirect user to GitHub OAuth page
app.get("/auth/github", (req, res) => {
  const redirectUrl = `https://github.com/login/oauth/authorize?client_id=${process.env.GITHUB_CLIENT_ID}&scope=public_repo&redirect_uri=http://localhost:${process.env.PORT}/auth/github/callback`;
  res.redirect(redirectUrl);
});

// Step 2: GitHub redirects back here with ?code=...
app.get("/auth/github/callback", async (req, res) => {
  const code = req.query.code;

  try {
    // Exchange code for access token
    const tokenRes = await axios.post(
      "https://github.com/login/oauth/access_token",
      {
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      },
      { headers: { Accept: "application/json" } }
    );

    const accessToken = tokenRes.data.access_token;

    if (!accessToken) {
      return res.status(400).json({ error: "No access token" });
    }

    // Save in session
    req.session.token = accessToken;

    // Optionally get user info
    const userRes = await axios.get("https://api.github.com/user", {
      headers: { Authorization: `token ${accessToken}` },
    });

    req.session.user = userRes.data;

    // ensure pdf-storage repo exists
    await ensurePdfRepo(accessToken);

    // Redirect back to frontend
    res.redirect(`${process.env.FRONTEND_URL}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("OAuth failed");
  }
});

const multer = require("multer");
const fs = require("fs");

// Configure multer (store files tempporarily)
const upload = multer({ dest: "uploads/" });

app.post("/upload", upload.single("pdf"), async (req, res) => {
  if (!req.session.token)
    return res.status(401).json({ error: "Not logged in" });

  const file = req.file;

  if (!file) return res.status(400).json({ error: "No file uploaded" });

  // Only allow PDFs
  if (file.mimetype !== "application/pdf") {
    fs.unlinkSync(file.path);
    return res.status(400).json({ error: "Only PDF files allowed" });
  }

  // Enforce 100MB limit (GitHub limit)
  if (file.size > 100 * 1024 * 1024) {
    fs.unlinkSync(file.path);
    return res.status(400).json({ error: "File too large (max 100MB)" });
  }

  try {
    const token = req.session.token;
    const user = req.session.user;

    // Read and encode file
    const fileContent = fs.readFileSync(file.path);
    const encoded = fileContent.toString("base64");

    // Choose a path (e.g. keep original filename)
    const path = `uploads/${Date.now()}-${file.originalname}`;

    // Upload to GitHub
    await axios.put(
      `https://api.github.com/repos/${user.login}/pdf-storage/contents/${path}`,
      {
        message: `Upload ${file.originalname}`,
        content: encoded,
      },
      { headers: { Authorization: `token ${token}` } }
    );

    // Clean up temp file
    fs.unlinkSync(file.path);

    const fileUrl = `https://raw.githubusercontent.com/${user.login}/pdf-storage/main/${path}`;

    res.json({ success: true, url: fileUrl });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Upload failed" });
  }
});

app.get("/files", async (req, res) => {
  if (!req.session.token)
    return res.status(401).json({ error: "Not logged in" });

  try {
    const token = req.session.token;
    const user = req.session.user;

    // GitHub API URL to list repo contents
    const repo = "pdf-storage";
    const folderPath = "uploads"; // same folder where PDFs are uploaded
    const url = `https://api.github.com/repos/${user.login}/${repo}/contents/${folderPath}`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    });

    // Filter only files and return useful info
    const files = response.data
      .filter((item) => item.type === "file")
      .map((item) => ({
        name: item.name,
        path: item.path,
        url: item.download_url,
      }));

    res.json(files);
  } catch (err) {
    // If folder doesn't exist, return empty array instead of error
    if (err.response && err.response.status === 404) {
      return res.json([]);
    }
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch files" });
  }
});

app.put("/delete", async (req, res) => {
  if (!req.session.token)
    return res.status(401).json({ error: "Not logged in" });

  try {
    const token = req.session.token;
    const user = req.session.user;

    const repo = "pdf-storage";
    const folderPath = "uploads";
    const fileName = req.body.fileName;

    if (!fileName) {
      console.log("No file name provided");
      return res.status(400).json({ error: "File name is required" });
    }

    const filePath = `${folderPath}/${fileName}`;
    console.log("Deleting file:", filePath);

    // Get the file SHA
    const fileResponse = await axios.get(
      `https://api.github.com/repos/${user.login}/${repo}/contents/${filePath}`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );

    const fileSha = fileResponse.data.sha;

    // Delete the file
    const deleteResponse = await axios.delete(
      `https://api.github.com/repos/${user.login}/${repo}/contents/${filePath}`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github.v3+json",
        },
        data: {
          message: `Delete ${fileName}`,
          sha: fileSha,
        },
      }
    );

    res.json({
      success: true,
      file: fileName,
      commit: deleteResponse.data.commit,
    });
  } catch (error) {
    console.log("Error while deleting:", error.response?.data || error.message);
    if (error.response?.status === 404) {
      return res.status(404).json({ error: "File not found" });
    }
    res.status(500).json({ error: "Failed to delete file" });
  }
});

// Example route to test login
app.get("/me", async (req, res) => {
  if (!req.session.token)
    return res.status(401).json({ error: "Not logged in" });
  res.json(req.session.user);
});

app.post("/logout", async (req, res) => {
  try {
    console.log("Logging out");
    res.clearCookie("session");
    res.json({ message: "logged out successfully" });
  } catch (error) {
    res.status(401).json({
      message: "Unable to logout currently, please try after some time.",
    });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`Server running on http://localhost:${process.env.PORT}`);
});
