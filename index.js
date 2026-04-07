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
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function azureTranslate(text, targetLang) {
  if (!text || targetLang === 'en') return text;
  const res = await axios.post(
    `${process.env.AZURE_TRANSLATOR_ENDPOINT}/translate?api-version=3.0&to=${targetLang}`,
    [{ text }],
    {
      headers: {
        'Ocp-Apim-Subscription-Key': process.env.AZURE_TRANSLATOR_KEY,
        'Ocp-Apim-Subscription-Region': process.env.AZURE_TRANSLATOR_REGION,
        'Content-Type': 'application/json'
      }
    }
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

// ─── TRANSFORM ────────────────────────────────────────────────────────────────
app.post('/api/transform', async (req, res) => {
  const { rawContent, subject, yearLevel, tone } = req.body;
  const toneInstruction = tone ? `Use a ${tone} tone throughout.` : 'Use a friendly, warm tone.';

  const prompt = `You are helping a teacher communicate with parents in Australia.
The teacher teaches ${subject} to Year ${yearLevel} students.
${toneInstruction}

The teacher wrote this learning update:
"${rawContent}"

Respond in this EXACT JSON format (no markdown, no extra text):
{
  "parentSummary": "A warm, plain-English 2-3 sentence summary of what the child is learning. No jargon.",
  "whyItMatters": "One sentence explaining why this topic matters in everyday life.",
  "curriculumLabel": "Australian Curriculum: Year ${yearLevel} ${subject} — [specific strand, e.g. Literacy: Text structure and organisation]",
  "pedagogyNote": "One sentence for the teacher: which educational theory supports these tips (e.g. Vygotsky ZPD scaffolding, Epstein Type 4 Learning at Home, Dweck Growth Mindset)",
  "atHomeTips": [
    "Tip 1: Specific and practical",
    "Tip 2: Another practical tip",
    "Tip 3: A conversation starter for tonight"
  ],
  "teacherMessage": "A warm, friendly 3-sentence message from teacher to parent."
}`;

  try {
    const parsed = JSON.parse(await curricuLLM(prompt));
    res.json({ success: true, data: parsed });
  } catch (err) {
    console.error('CurricuLLM error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── SIMPLIFY MESSAGE ─────────────────────────────────────────────────────────
app.post('/api/simplify', async (req, res) => {
  const { content, level, language } = req.body;
  const levelMap = {
    simple: 'Use very simple short sentences. Maximum Year 3 reading level. Like explaining to someone new to English.',
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

// ─── PARENT AI CHAT ───────────────────────────────────────────────────────────
app.post('/api/parent-chat', async (req, res) => {
  const { question, childName, subject, language } = req.body;

  let englishQuestion = question;
  try {
    if (language && language !== 'en') {
      const tRes = await axios.post(
        `${process.env.AZURE_TRANSLATOR_ENDPOINT}/translate?api-version=3.0&to=en`,
        [{ text: question }],
        {
          headers: {
            'Ocp-Apim-Subscription-Key': process.env.AZURE_TRANSLATOR_KEY,
            'Ocp-Apim-Subscription-Region': process.env.AZURE_TRANSLATOR_REGION,
            'Content-Type': 'application/json'
          }
        }
      );
      englishQuestion = tRes.data[0].translations[0].text;
    }
  } catch (e) {}

  const prompt = `You are a warm, helpful assistant for an Australian parent${childName ? ` whose child is named ${childName}` : ''}.
They want help supporting their child's learning at home.
Their question: "${englishQuestion}"
${subject ? `Their child is currently studying ${subject} at school.` : ''}

Answer in 2-3 sentences. Be warm, practical and encouraging.
Give one specific thing they can do tonight.
Use Australian Curriculum context where helpful.
Do NOT use jargon. Return ONLY the answer text, no labels.`;

  try {
    const answer = await curricuLLM(prompt);
    const cleanAnswer = answer.replace(/^"|"$/g, '').trim();
    const translated = language && language !== 'en' ? await azureTranslate(cleanAnswer, language) : cleanAnswer;
    res.json({ success: true, answer: translated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET CHILDREN FOR PARENT ──────────────────────────────────────────────────
app.get('/api/children/:parentId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('children').select('*').eq('parent_id', req.params.parentId);
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── MARK TIP AS TRIED ────────────────────────────────────────────────────────
app.post('/api/mark-tried', async (req, res) => {
  const { recipientId, feedback } = req.body;
  try {
    const { error } = await supabase
      .from('message_recipients')
      .update({ tried_activity: true, feedback })
      .eq('id', recipientId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ANALYSE REPLY ────────────────────────────────────────────────────────────
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

// ─── TRANSLATE ────────────────────────────────────────────────────────────────
app.post('/api/translate', async (req, res) => {
  const { text, targetLanguage } = req.body;
  try {
    const translated = await azureTranslate(text, targetLanguage);
    res.json({ success: true, translated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── SEND MESSAGE ─────────────────────────────────────────────────────────────
app.post('/api/send-message', async (req, res) => {
  const { teacherId, teacherName, subject, rawContent, transformedData } = req.body;
  try {
    const { data: message, error } = await supabase
      .from('messages')
      .insert({
        teacher_id: teacherId, teacher_name: teacherName, subject,
        raw_content: rawContent,
        transformed_content: transformedData.teacherMessage,
        at_home_tips: JSON.stringify(transformedData.atHomeTips),
        subject_area: subject
      })
      .select().single();

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
          const msgPrompt = `Write a warm 3-sentence message from teacher ${teacherName} to parent ${parent.name}.
Their child ${childName} studied ${subject} this week. Mention ${childName} by name. Be encouraging.
Return ONLY the message text.`;
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
        } catch (e) { console.log('Translation failed for', parent.language); }
      }

      await supabase.from('message_recipients').insert({
        message_id: message.id, parent_id: parent.id,
        translated_content: translatedContent, translated_tips: translatedTips,
        language: parent.language
      });
    }

    res.json({ success: true, messageId: message.id });
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET MESSAGES FOR PARENT ──────────────────────────────────────────────────
app.get('/api/parent-messages/:parentId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('message_recipients').select('*, messages(*)')
      .eq('parent_id', req.params.parentId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET MESSAGES FOR TEACHER ─────────────────────────────────────────────────
app.get('/api/teacher-messages/:teacherId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('messages').select('*, replies(*)')
      .eq('teacher_id', req.params.teacherId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST REPLY ───────────────────────────────────────────────────────────────
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
      const analysisRes = await axios.post(`http://localhost:${process.env.PORT}/api/analyse-reply`, { replyText: translatedContent });
      if (analysisRes.data.success) {
        ({ sentiment, suggestedResponse, urgency, summary } = analysisRes.data.data);
      }
    } catch (e) {}

    const { data, error } = await supabase.from('replies')
      .insert({ message_id: messageId, parent_id: parentId, parent_name: parentName, content, translated_content: translatedContent, sentiment, suggested_response: suggestedResponse, urgency, summary })
      .select().single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── UPDATE PROFILE ───────────────────────────────────────────────────────────
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

// ─── ENGAGEMENT STATS ─────────────────────────────────────────────────────────
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

    res.json({
      success: true,
      data: {
        totalMessages: messages.length,
        totalReplies: replies?.length || 0,
        totalParents: recipients?.length || 0,
        sentiments, languages,
        highUrgency: replies?.filter(r => r.urgency === 'high').length || 0,
        triedActivity: recipients?.filter(r => r.tried_activity).length || 0
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/teacher-reply', async (req, res) => {
  const { parentId, teacherName, content, messageId } = req.body;
  try {
    let translatedContent = content;
    
    if (parentId) {
      const { data: parent } = await supabase
        .from('profiles').select('language').eq('id', parentId).single();
      
      if (parent?.language && parent.language !== 'en') {
        try {
          translatedContent = await azureTranslate(content, parent.language);
        } catch(e) {}
      }
    }
    const { data, error } = await supabase
      .from('replies')
      .insert({
        message_id: messageId,
        parent_id: parentId,
        parent_name: `🍎 ${teacherName} (Teacher)`,
        content,
        translated_content: translatedContent,
        sentiment: 'positive',
        urgency: 'low',
        summary: 'Direct teacher reply'
      })
      .select().single();

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
    if (language && language !== 'en') {
      explanation = await azureTranslate(explanation, language);
    }
    res.json({ success: true, explanation });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`BridgeUp server running on port ${process.env.PORT || 3000}`);
});