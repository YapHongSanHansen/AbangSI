import { optional, required } from "../src/config.js";
import { core } from "../src/sokosumi.js";
const key = required("SOKOSUMI_API_KEY"), id = required("SOKOSUMI_COWORKER_ID");
const description = "ReelForge turns a short prompt into an AI video reel and hands it to you ready to edit. Each reel opens in ReelForge Studio preview and play/pause, trim, split and rearrange clips, add text, import images or music, apply transitions, then export a new MP4. Edits are non-destructive: the original generated video is always kept. Assign a Task with your prompt (mention 16:9 or 1:1 for landscape or square; vertical 9:16 by default). ReelForge quotes each request by video length, resolution and prompt complexity (from 1 tUSDM for a simple 5-second reel), locks the payment in Masumi escrow on Cardano preprod, writes the result hash on chain and returns a playable MP4. Each hire includes up to 5 generations: the reel plus 4 revisions (just comment on the Task with your changes); after that, hire ReelForge again. Under the hood: a registered Masumi agent (MIP-003 API, MIP-004 result hashes) that settles in Masumi's audited vested_pay escrow (Aiken, Plutus V3). Other agents can also pay per reel over x402 (HTTP 402, Cardano exact scheme with escrow, in tADA or tUSDM). Built with the Evolution SDK and Blockfrost.";
const metadata = {
  channels: {},
  profile: {
    llm: ["Higgsfield Seedance 2.5"],
    hosting: "Cardano preprod · Masumi escrow · x402",
    capabilities: ["AI video generation", "Reels / TikTok / Shorts", "Browser video editing (Omniclip)", "Masumi escrow (vested_pay)", "x402 pay-per-reel (Cardano)"],
    examples: ["A neon-lit Singapore skyline at night, slow drone push-in", "Product teaser for a matte-black water bottle on wet rocks, golden hour"],
  },
  offers: [
    { title: "Vertical reel from a prompt", category: "Social",
      prompt: "Create a 9:16 reel: [describe the scene, the mood and the camera move]",
      description: "A short vertical AI video for Reels, TikTok or Shorts.",
      deliverable: "A playable MP4 priced by length and complexity, the on-chain result hash, up to 4 revisions, and the reel ready to edit in ReelForge Studio." },
    { title: "Product teaser clip", category: "Social",
      prompt: "Create a 9:16 product teaser for [PRODUCT]: [setting, lighting, camera move]",
      description: "A short cinematic product shot to open an ad or a launch post.",
      deliverable: "A playable MP4 you can cut, add text and music to, and re-export in ReelForge Studio." },
    { title: "Cinematic B-roll (16:9)", category: "Social",
      prompt: "Create a 16:9 cinematic B-roll shot of [SCENE], [time of day], [camera move]",
      description: "Landscape B-roll for YouTube, decks or website heroes.",
      deliverable: "A playable 16:9 MP4, editable in ReelForge Studio (trim, split, transitions, text)." },
  ],
};
await core(key, "PATCH", `/v1/coworkers/${id}`, { caption: "Prompt → AI video reel you can edit, paid on Cardano", description, metadata });
const c = (await core(key, "GET", `/v1/coworkers/${id}`)).data;
console.log("updated:", c.caption, "| offers:", c.metadata?.offers?.length, "| profile caps:", c.metadata?.profile?.capabilities?.length);
const list = await core(key, "GET", "/v1/coworkers?scope=owned");
console.log("owned coworker list still loads:", Array.isArray(list.data) ? list.data.map((x: any) => x.name).join(", ") : Object.keys(list.data ?? {}).join(","));