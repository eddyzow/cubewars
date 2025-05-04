const express = require("express");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from /public
app.use(express.static(path.join(__dirname, "public")));

// Fallback to index.html for root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// TODO: Add socket.io or backend APIs here if needed

app.listen(PORT, () => {
  console.log(`Cube Wars server running on port ${PORT}`);
});
