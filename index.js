require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function azureTranslate(text, targetLang) {
  if (!text || targetLang === 'en') return text;
  const res = await axios.post(
    `${process.env.AZURE_TRANSLATOR_ENDPOINT}/translate?api-version=3.0&to=${targetLang}`,
    [{ text }],
    { headers: { 'Ocp-Apim-Subscription-Key': process.env.AZURE_TRANSLATOR_KEY, 'Ocp-Apim-Subscription-Region': process.env.AZURE_TRANSLATOR_REGION, 'Content-Type': 'application/json' } }
  );
  return res.data[0].translations[0].text;
}

async function curricuLLM(prompt) {
  const response = await axios.post(
    'https://api.curricullm.com/v1/chat/completions',
    { model: 'CurricuLLM-AU', messages: [{ role: 'user', content: prompt }] },
    { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.CURRICULLM_API_KEY}` } }
  );
  const content = response.data.choices[0].message.content;
  return content.replace(/```json|```/g, '').trim();
}

function buildPersonalisedTips(childName, interests, struggles, subject, rawContent) {
  const rawInterests = interests || '';
  const childStruggles = struggles || 'writing';
  const interestList = rawInterests.split(/[,]+/).map(s => s.trim()).filter(s => s.length > 2);
  const interest1 = interestList[0] || rawInterests;
  const interest2 = interestList[1] || interest1;
  const subjectLower = subject.toLowerCase();

  if (subjectLower === 'english' && rawContent.toLowerCase().includes('persuasiv')) {
    return [
      `Ask ${childName} to write a persuasive argument for why ${interest1} is better than ${interest2} — this uses the exact PEEL structure practiced in class this week.`,
      `Since ${childName} finds ${childStruggles} tricky, pick one sentence together and improve it — focus on adding one strong reason with evidence.`,
      `Tonight ask ${childName}: "If you had to convince me to try ${interest1}, what would be your three best arguments?"`
    ];
  } else if (subjectLower === 'english') {
    return [
      `Ask ${childName} to write a short story where the main character loves ${interest1} — then apply this week's narrative techniques to make the opening vivid.`,
      `Since ${childName} struggles with ${childStruggles}, read their story opening aloud together and improve just one descriptive sentence.`,
      `Tonight ask ${childName}: "If ${interest1} was a book character, what would make them interesting to read about?"`
    ];
  } else if (subjectLower === 'science') {
    return [
      `Ask ${childName} to explain this week's science topic as if describing it to someone who plays ${interest1} — how would they understand it?`,
      `Since ${childName} finds ${childStruggles} challenging, ask them to write just two sentences summarising what they learned this week.`,
      `Tonight ask ${childName}: "How could the science we learned this week help improve ${interest1}?"`
    ];
  } else if (subjectLower === 'mathematics') {
    return [
      `Challenge ${childName} to find the maths in ${interest1} — scores, stats, levels, distances. Use this week's concepts to analyse it.`,
      `Since ${childName} struggles with ${childStruggles}, work through just one practice problem together tonight — no pressure, just one.`,
      `Tonight ask ${childName}: "If you designed a scoring system for ${interest1}, what maths would you need?"`
    ];
  } else {
    return [
      `Ask ${childName} to connect this week's ${subject} lesson to ${interest1} — how does what they learned show up there?`,
      `Since ${childName} finds ${childStruggles} difficult, spend 10 minutes reviewing one key idea from this week together.`,
      `Tonight ask ${childName}: "What was the most interesting thing from ${subject} this week — and how does it connect to ${interest1}?"`
    ];
  }
}

app.post('/api/transform', async (req, res) => {
  const { rawContent, subject, yearLevel, tone } = req.body;
  const toneInstruction = tone ? `Use a ${tone} tone throughout.` : 'Use a friendly, warm tone.';
  const prompt = `You are helping a teacher communicate with parents in Australia.
The teacher teaches ${subject} to Year ${yearLevel} students.
${toneInstruction}
The teacher wrote this learning update: "${rawContent}"
Respond in this EXACT JSON format (no markdown, no extra text):
{
  "parentSummary": "A warm, plain-English 2-3 sentence summary of what the child is learning. No jargon.",
  "whyItMatters": "One sentence explaining why this topic matters in everyday life.",
  "curriculumLabel": "Australian Curriculum: Year ${yearLevel} ${subject} — [specific strand]",
  "pedagogyNote": "One sentence for the teacher: which educational theory supports these tips",
  "atHomeTips": ["Tip 1: Specific and practical", "Tip 2: Another practical tip", "Tip 3: A conversation starter for tonight"],
  "teacherMessage": "A warm, friendly 3-sentence message from teacher to parent."
}`;
  try {
    const parsed = JSON.parse(await curricuLLM(prompt));
    res.json({ success: true, data: parsed });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/simplify', async (req, res) => {
  const { content, level, language } = req.body;
  const levelMap = {
    simple: 'Use very simple short sentences. Maximum Year 3 reading level.',
    standard: 'Use plain friendly English. Clear sentences. No jargon.',
    detailed: 'Provide a thorough explanation with context and helpful background information.'
  };
  const prompt = `Rewrite this school message for an Australian parent.
Style: ${levelMap[level] || levelMap.standard}
Original: "${content}"
Return ONLY the rewritten message. No labels, no JSON.`;
  try {
    const result = await curricuLLM(prompt);
    const simplified = result.replace(/^"|"$/g, '').trim();
    const translated = language && language !== 'en' ? await azureTranslate(simplified, language) : simplified;
    res.json({ success: true, content: translated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/parent-chat', async (req, res) => {
  const { question, childName, subject, language } = req.body;
  let englishQuestion = question;
  try {
    if (language && language !== 'en') {
      const tRes = await axios.post(
        `${process.env.AZURE_TRANSLATOR_ENDPOINT}/translate?api-version=3.0&to=en`,
        [{ text: question }],
        { headers: { 'Ocp-Apim-Subscription-Key': process.env.AZURE_TRANSLATOR_KEY, 'Ocp-Apim-Subscription-Region': process.env.AZURE_TRANSLATOR_REGION, 'Content-Type': 'application/json' } }
      );
      englishQuestion = tRes.data[0].translations[0].text;
    }
  } catch (e) {}
  const prompt = `You are a warm, helpful assistant for an Australian parent${childName ? ` whose child is named ${childName}` : ''}.
They want help supporting their child's learning at home.
Their question: "${englishQuestion}"
${subject ? `Their child is currently studying ${subject} at school.` : ''}
Answer in 2-3 sentences. Be warm, practical and encouraging. Give one specific thing they can do tonight.
Use Australian Curriculum context where helpful. Do NOT use jargon. Return ONLY the answer text, no labels.`;
  try {
    const answer = await curricuLLM(prompt);
    const cleanAnswer = answer.replace(/^"|"$/g, '').trim();
    const translated = language && language !== 'en' ? await azureTranslate(cleanAnswer, language) : cleanAnswer;
    res.json({ success: true, answer: translated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/children/:parentId', async (req, res) => {
  try {
    const { data, error } = await supabase.from('children').select('*').eq('parent_id', req.params.parentId);
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/mark-tried', async (req, res) => {
  const { recipientId, feedback } = req.body;
  try {
    const { error } = await supabase.from('message_recipients').update({ tried_activity: true, feedback }).eq('id', recipientId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/analyse-reply', async (req, res) => {
  const { replyText } = req.body;
  const prompt = `A parent sent this message to their child's teacher: "${replyText}"
Analyse and respond in EXACT JSON (no markdown):
{
  "sentiment": "positive" or "question" or "concern",
  "summary": "One sentence summary in plain English",
  "suggestedResponse": "A warm 2-sentence suggested reply for the teacher",
  "urgency": "low" or "medium" or "high"
}`;
  try {
    const parsed = JSON.parse(await curricuLLM(prompt));
    res.json({ success: true, data: parsed });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/translate', async (req, res) => {
  const { text, targetLanguage } = req.body;
  try {
    const translated = await azureTranslate(text, targetLanguage);
    res.json({ success: true, translated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/send-message', async (req, res) => {
  const { teacherId, teacherName, subject, rawContent, transformedData } = req.body;
  try {
    const { data: message, error } = await supabase.from('messages').insert({
      teacher_id: teacherId, teacher_name: teacherName, subject,
      raw_content: rawContent, transformed_content: transformedData.teacherMessage,
      at_home_tips: JSON.stringify(transformedData.atHomeTips), subject_area: subject
    }).select().single();
    if (error) throw error;

    const { data: parents } = await supabase.from('profiles').select('*').eq('role', 'parent');
    for (const parent of parents) {
      const { data: children } = await supabase.from('children').select('*').eq('parent_id', parent.id);
      const primaryChild = children?.[0];
      const childInterests = primaryChild?.interests || parent.child_interests;
      const childStruggles = primaryChild?.struggles || parent.child_struggles;
      const childName = primaryChild?.name || parent.child_name;

      let personalizedTips = transformedData.atHomeTips;
      let personalizedMessage = transformedData.teacherMessage;

      if (childInterests || childStruggles) {
        personalizedTips = buildPersonalisedTips(childName, childInterests, childStruggles, subject, rawContent);
        try {
          const msgPrompt = `Write a warm 3-sentence message from teacher ${teacherName} to parent ${parent.name}. Their child ${childName} studied ${subject} this week. Mention ${childName} by name. Be encouraging. Return ONLY the message text.`;
          personalizedMessage = (await curricuLLM(msgPrompt)).replace(/^"|"$/g, '').trim();
        } catch (e) {
          personalizedMessage = `Hi ${parent.name}! This week ${childName} worked on ${subject}. The tips below are personalised just for them — thank you for your support!`;
        }
      }

      let translatedContent = personalizedMessage;
      let translatedTips = personalizedTips.join(' | ');
      if (parent.language !== 'en') {
        try {
          translatedContent = await azureTranslate(personalizedMessage, parent.language);
          translatedTips = await azureTranslate(personalizedTips.join(' | '), parent.language);
        } catch (e) {}
      }

      await supabase.from('message_recipients').insert({
        message_id: message.id, parent_id: parent.id,
        translated_content: translatedContent, translated_tips: translatedTips, language: parent.language
      });
    }
    res.json({ success: true, messageId: message.id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/parent-messages/:parentId', async (req, res) => {
  try {
    const { data, error } = await supabase.from('message_recipients').select('*, messages(*)')
      .eq('parent_id', req.params.parentId).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/teacher-messages/:teacherId', async (req, res) => {
  try {
    const { data, error } = await supabase.from('messages').select('*, replies(*)')
      .eq('teacher_id', req.params.teacherId).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/reply', async (req, res) => {
  const { messageId, parentId, parentName, content } = req.body;
  try {
    const translateRes = await axios.post(
      `${process.env.AZURE_TRANSLATOR_ENDPOINT}/translate?api-version=3.0&to=en`,
      [{ text: content }],
      { headers: { 'Ocp-Apim-Subscription-Key': process.env.AZURE_TRANSLATOR_KEY, 'Ocp-Apim-Subscription-Region': process.env.AZURE_TRANSLATOR_REGION, 'Content-Type': 'application/json' } }
    );
    const translatedContent = translateRes.data[0].translations[0].text;

    let sentiment = 'positive', suggestedResponse = '', urgency = 'low', summary = '';
    try {
      const analysisRes = await axios.post(`http://localhost:${process.env.PORT || 3000}/api/analyse-reply`, { replyText: translatedContent });
      if (analysisRes.data.success) ({ sentiment, suggestedResponse, urgency, summary } = analysisRes.data.data);
    } catch (e) {}

    const { data, error } = await supabase.from('replies').insert({
      message_id: messageId, parent_id: parentId, parent_name: parentName,
      content, translated_content: translatedContent, sentiment,
      suggested_response: suggestedResponse, urgency, summary
    }).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/update-profile', async (req, res) => {
  const { parentId, childInterests, childStruggles, childLearningStyle } = req.body;
  try {
    const { error } = await supabase.from('profiles')
      .update({ child_interests: childInterests, child_struggles: childStruggles, child_learning_style: childLearningStyle })
      .eq('id', parentId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/engagement/:teacherId', async (req, res) => {
  try {
    const { data: messages } = await supabase.from('messages').select('id').eq('teacher_id', req.params.teacherId);
    if (!messages?.length) return res.json({ success: true, data: { totalMessages: 0, totalReplies: 0, totalParents: 0, sentiments: {}, languages: {}, highUrgency: 0, triedActivity: 0 } });
    const messageIds = messages.map(m => m.id);
    const { data: replies } = await supabase.from('replies').select('sentiment, urgency').in('message_id', messageIds);
    const { data: recipients } = await supabase.from('message_recipients').select('is_read, language, tried_activity').in('message_id', messageIds);
    const sentiments = { positive: 0, question: 0, concern: 0 };
    replies?.forEach(r => { if (r.sentiment) sentiments[r.sentiment] = (sentiments[r.sentiment] || 0) + 1; });
    const languages = {};
    recipients?.forEach(r => { languages[r.language] = (languages[r.language] || 0) + 1; });
    res.json({ success: true, data: { totalMessages: messages.length, totalReplies: replies?.length || 0, totalParents: recipients?.length || 0, sentiments, languages, highUrgency: replies?.filter(r => r.urgency === 'high').length || 0, triedActivity: recipients?.filter(r => r.tried_activity).length || 0 } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/teacher-reply', async (req, res) => {
  const { parentId, teacherName, content, messageId } = req.body;
  try {
    let translatedContent = content;
    if (parentId) {
      const { data: parent } = await supabase.from('profiles').select('language').eq('id', parentId).single();
      if (parent?.language && parent.language !== 'en') {
        try { translatedContent = await azureTranslate(content, parent.language); } catch(e) {}
      }
    }
    const { data, error } = await supabase.from('replies').insert({
      message_id: messageId, parent_id: parentId,
      parent_name: `🍎 ${teacherName} (Teacher)`,
      content, translated_content: translatedContent,
      sentiment: 'positive', urgency: 'low', summary: 'Direct teacher reply'
    }).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/explain-term', async (req, res) => {
  const { term, language } = req.body;
  const prompt = `Define this Australian school/curriculum term for a parent with no teaching background, in exactly 15 words or less, in plain simple English: "${term}"
Return ONLY the definition. No labels, no JSON, no punctuation at start.`;
  try {
    let explanation = await curricuLLM(prompt);
    explanation = explanation.replace(/^"|"$/g, '').trim();
    if (language && language !== 'en') explanation = await azureTranslate(explanation, language);
    res.json({ success: true, explanation });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/unengaged/:teacherId', async (req, res) => {
  try {
    const { data: messages } = await supabase.from('messages').select('id').eq('teacher_id', req.params.teacherId);
    if (!messages?.length) return res.json({ success: true, data: [] });
    const messageIds = messages.map(m => m.id);
    const { data: recipients } = await supabase.from('message_recipients').select('parent_id, profiles(name, child_name, language)').in('message_id', messageIds);
    const { data: replies } = await supabase.from('replies').select('parent_id').in('message_id', messageIds);
    const repliedParentIds = new Set(replies?.map(r => r.parent_id) || []);
    const seen = new Set();
    const unengaged = [];
    recipients?.forEach(r => {
      if (!repliedParentIds.has(r.parent_id) && !seen.has(r.parent_id)) {
        seen.add(r.parent_id);
        unengaged.push({ parentId: r.parent_id, name: r.profiles?.name, childName: r.profiles?.child_name, language: r.profiles?.language });
      }
    });
    res.json({ success: true, data: unengaged });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/personalise-message', async (req, res) => {
  const { messageContent, childName, childInterests, childStruggles, language } = req.body;
  const prompt = `A teacher sent this update: "${messageContent}"
This message is for the parent of ${childName}.
${childName} loves: ${childInterests || 'not specified'}
${childName} struggles with: ${childStruggles || 'not specified'}
Write ONE warm sentence (max 20 words) starting with "${childName}" explaining exactly why THIS lesson matters for them specifically, connecting to their interests.
Return ONLY the sentence, nothing else.`;
  try {
    let result = await curricuLLM(prompt);
    result = result.replace(/^"|"$/g, '').trim();
    if (language && language !== 'en') result = await azureTranslate(result, language);
    res.json({ success: true, message: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/mark-read', async (req, res) => {
  const { parentId, subject } = req.body;
  try {
    const { data: messages } = await supabase.from('message_recipients').select('id, messages(subject)').eq('parent_id', parentId).eq('is_read', false);
    const toUpdate = messages?.filter(m => m.messages?.subject === subject).map(m => m.id);
    if (toUpdate?.length) await supabase.from('message_recipients').update({ is_read: true }).in('id', toUpdate);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── NEW: ALL PARENTS ─────────────────────────────────────────────────────────
app.get('/api/all-parents', async (req, res) => {
  try {
    const { data } = await supabase.from('profiles').select('id, name, child_name, language').eq('role', 'parent');
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── NEW: DIRECT MESSAGE ──────────────────────────────────────────────────────
app.post('/api/direct-message', async (req, res) => {
  const { teacherId, teacherName, parentId, subject, content } = req.body;
  try {
    const { data: parent } = await supabase.from('profiles').select('*').eq('id', parentId).single();
    let translatedContent = content;
    if (parent?.language && parent.language !== 'en') {
      try { translatedContent = await azureTranslate(content, parent.language); } catch(e) {}
    }
    const { data: message, error } = await supabase.from('messages').insert({
      teacher_id: teacherId, teacher_name: teacherName,
      subject: subject || 'Message from Teacher',
      raw_content: content, transformed_content: content,
      at_home_tips: JSON.stringify([]), subject_area: subject || 'General'
    }).select().single();
    if (error) throw error;
    await supabase.from('message_recipients').insert({
      message_id: message.id, parent_id: parentId,
      translated_content: translatedContent, translated_tips: '', language: parent?.language || 'en'
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── NEW: PTM REQUEST ─────────────────────────────────────────────────────────
app.post('/api/request-ptm', async (req, res) => {
  const { parentId, parentName, childName, preferredTime, reason } = req.body;
  try {
    const { error } = await supabase.from('ptm_requests').insert({
      parent_id: parentId, parent_name: parentName,
      child_name: childName, preferred_time: preferredTime, reason
    });
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/ptm-requests/:teacherId', async (req, res) => {
  try {
    const { data } = await supabase.from('ptm_requests').select('*').eq('status', 'pending').order('created_at', { ascending: false });
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── NEW: FAQ ─────────────────────────────────────────────────────────────────
app.post('/api/faq', async (req, res) => {
  const { question, language } = req.body;
  const prompt = `An Australian parent asked this question about their child's school: "${question}"
Answer in 2-3 sentences. Be warm, simple, and practical. Reference Australian Curriculum context where relevant.
Do not use jargon. Return ONLY the answer text.`;
  try {
    let answer = await curricuLLM(prompt);
    answer = answer.replace(/^"|"$/g, '').trim();
    if (language && language !== 'en') answer = await azureTranslate(answer, language);
    res.json({ success: true, answer });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`BridgeUp server running on port ${process.env.PORT || 3000}`);
});