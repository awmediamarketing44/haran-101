require("dotenv").config();
const express = require("express");
const path = require("path");
const { ApifyClient } = require("apify-client");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const apify = new ApifyClient({ token: process.env.APIFY_TOKEN });
const anthropic = new Anthropic.default();

const REELS_LIMIT = 5;

app.post("/api/review", async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: "Username is required" });
  }

  try {
    // 1. Scrape reels via Apify
    const run = await apify.actor("apify/instagram-reel-scraper").call({
      username: [username],
      resultsLimit: REELS_LIMIT,
    });

    const { items } = await apify.dataset(run.defaultDatasetId).listItems();

    if (!items.length) {
      return res.status(404).json({ error: "No reels found for this user" });
    }

    // 2. Build reel summaries for Claude
    const reelSummaries = items.map((r, i) => ({
      index: i + 1,
      caption: r.caption || "",
      views: r.videoViewCount ?? r.videoPlayCount ?? null,
      likes: r.likesCount ?? null,
      comments: r.commentsCount ?? null,
      duration: r.videoDuration ?? null,
      hashtags: r.hashtags ?? [],
      mentions: r.mentions ?? [],
    }));

    const prompt = `You are an expert Instagram content strategist. Analyse these ${reelSummaries.length} recent reels from @${username} and return a JSON object (no markdown, no code fences, just raw JSON) with this exact structure:

{
  "summary": {
    "score": <number 1-10>,
    "verdict": "<one paragraph overall assessment>",
    "strengths": ["<strength 1>", "<strength 2>", ...],
    "weaknesses": ["<weakness 1>", "<weakness 2>", ...],
    "recommendations": ["<recommendation 1>", "<recommendation 2>", ...]
  },
  "reels": [
    {
      "index": <number>,
      "review": {
        "hook_score": <number 1-10>,
        "clarity_score": <number 1-10>,
        "pacing_score": <number 1-10>,
        "cta_score": <number 1-10>,
        "overall_score": <number 1-10>,
        "summary": "<2-3 sentence review of this specific reel>",
        "suggested_hook": "<a better opening hook for this reel>",
        "suggested_cta": "<a better call-to-action for this reel>",
        "improvements": ["<improvement 1>", "<improvement 2>", ...]
      }
    }
  ]
}

Here are the reels:

${JSON.stringify(reelSummaries, null, 2)}`;

    // 3. Get Claude's review
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content[0].text;
    const review = JSON.parse(text);

    // 4. Merge scraped data with reviews
    const reels = items.map((r, i) => {
      const reelReview = review.reels.find((rv) => rv.index === i + 1) || {
        review: {},
      };
      return {
        caption: r.caption || "",
        views: r.videoViewCount ?? r.videoPlayCount ?? null,
        likes: r.likesCount ?? null,
        comments: r.commentsCount ?? null,
        duration: r.videoDuration ?? null,
        review: reelReview.review,
      };
    });

    res.json({
      username,
      summary: review.summary,
      reels,
    });
  } catch (err) {
    console.error("Review error:", err);
    res.status(500).json({ error: err.message || "Something went wrong" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
