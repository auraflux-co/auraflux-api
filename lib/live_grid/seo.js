/**
 * Live Grid — GPT SEO copy for the YouTube live broadcast (CPD-952)
 *
 * Generates a click-optimized live title + keyword-rich description from the
 * current quadrant lineup. Fail-open: any error returns null and the caller
 * falls back to the template title (gridTitle).
 */

const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const AUDIO_INSTRUCTIONS =
  '🔊 YOU control the audio — type !listen 1, 2, 3 or 4 in chat to hear that screen. ' +
  'The gold border shows who is on air.';

/**
 * @param {Array<{login: string, viewers: number}>} lineup — current live quadrant occupants
 * @returns {Promise<{title: string, description: string}|null>}
 */
async function generateGridSeo(lineup) {
  if (!process.env.OPENAI_API_KEY || !lineup?.length) return null;
  try {
    const names = lineup.map(s => `${s.login} (${s.viewers ?? '?'} viewers)`).join(', ');
    const systemPrompt = `You write YouTube SEO for ClipzWorld News (@clipzworldnews), a streamer news channel.
We are LIVE right now with a 2x2 multiview grid showing these Twitch streamers simultaneously: ${names}.
Viewers can switch which streamer they hear by typing !listen 1-4 in chat (interactive feature — worth hyping).

Generate JSON: {"title": "...", "description": "..."}

TITLE rules:
- MAX 95 characters, starts with "🔴 LIVE:"
- Names the biggest streamers in the lineup (use their actual handles)
- Click-driven but honest — no fake claims
- Searchable: include "live" and a term fans search (e.g. "stream", "multiview", "watch party")

DESCRIPTION rules:
- 2-4 sentences hooking what this is: all these streamers live on one screen, audio controlled by chat
- MUST include this line verbatim: "${AUDIO_INSTRUCTIONS}"
- Credit each streamer with their twitch.tv link (https://twitch.tv/<login>)
- End with 5-8 hashtags: #live #twitch plus streamer-name and niche tags
- Under 1500 characters total

Output ONLY valid JSON.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 700,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Generate the live stream SEO JSON now.' }
      ]
    });
    const text = (response.choices[0]?.message?.content || '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const seo = JSON.parse(jsonMatch[0]);
    if (!seo.title || !seo.description) return null;
    return { title: String(seo.title).slice(0, 100), description: String(seo.description).slice(0, 5000) };
  } catch (e) {
    return null; // fail-open — template title takes over
  }
}

module.exports = { generateGridSeo, AUDIO_INSTRUCTIONS };
