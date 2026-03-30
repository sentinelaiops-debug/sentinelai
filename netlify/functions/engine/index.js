const OpenAI = require("openai");



const openai = new OpenAI({

  apiKey: process.env.OPENAI_API_KEY,

});



// --- CONFIG ---

const CACHE_TTL = 600; // seconds

const RATE_LIMIT = 30;

const RATE_WINDOW = 60;



// --- PLAN LIMITS ---

const PLAN_LIMITS = {

  free: 2,

  pro: 100,

  enterprise: 1000,

};



// --- REDIS ---

const redisFetch = async (path) => {

  const res = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/${path}`, {

    headers: {

      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,

    },

  });

  return res.json();

};



// --- HELPERS ---

const sanitizeInput = (input) => {

  if (typeof input !== "string") return "";

  return input.replace(/["']/g, "").substring(0, 300);

};



const isValidUrl = (string) => {

  try {

    new URL(string);

    return true;

  } catch {

    return false;

  }

};



const addLegalShield = (data) => ({

  ...data,

  legal_disclaimer:

    "AI-generated. Informational only. Not legal or professional advice.",

});



// --- API KEY ---

const isValidApiKey = async (key) => {

  if (!key) return false;

  const res = await redisFetch(`GET apikey:${key}`);

  return res.result !== null;

};



const getPlan = async (key) => {

  const res = await redisFetch(`GET apikey:${key}`);

  return res.result || "free";

};



// --- USAGE ---

const checkUsageLimit = async (key) => {

  const plan = await getPlan(key);

  const limit = PLAN_LIMITS[plan] || PLAN_LIMITS.free;



  const res = await redisFetch(`GET usage:${key}`);

  const usage = parseInt(res.result || "0", 10);



  return {

    allowed: usage < limit,

    remaining: Math.max(limit - usage, 0),

    limit,

    plan,

  };

};



const trackUsage = async (key) => {

  await redisFetch(`INCR usage:${key}`);

};



// --- RATE LIMIT ---

const checkRateLimit = async (id) => {

  const key = `rate:${id}`;

  const res = await redisFetch(`INCR/${key}`);



  if (res.result === 1) {

    await redisFetch(`EXPIRE/${key}/${RATE_WINDOW}`);

  }



  return res.result <= RATE_LIMIT;

};



// --- CACHE ---

const getCache = async (key) => {

  const res = await redisFetch(`GET ${key}`);

  return res.result ? JSON.parse(res.result) : null;

};



const setCache = async (key, data) => {

  await redisFetch(`SET ${key} ${JSON.stringify(data)} EX ${CACHE_TTL}`);

};



// --- TIMEOUT ---

const withTimeout = (promise, ms = 12000) =>

  Promise.race([

    promise,

    new Promise((_, reject) =>

      setTimeout(() => reject(new Error("Timeout")), ms)

    ),

  ]);



// --- OPENAI ---

async function runPrompt(prompt, retries = 2) {

  try {

    const res = await withTimeout(

      openai.chat.completions.create({

        model: "gpt-4o-mini",

        temperature: 0.2,

        response_format: { type: "json_object" },

        messages: [{ role: "user", content: prompt }],

      })

    );



    return JSON.parse(res.choices[0].message.content);

  } catch (err) {

    if (retries > 0) return runPrompt(prompt, retries - 1);

    console.error("OpenAI error:", err);

    throw err;

  }

}



// --- TOOLS ---

const toolMap = {

  risk: (url) =>

    runPrompt(`Analyze Terms of Service of ${url}.

Return JSON:

{ "score": number, "risks": [{ "title": "string", "severity": "Low|Medium|High", "description": "string" }] }`),



  brand_scout: (url) =>

    runPrompt(`Analyze brand from ${url}.

Return JSON:

{ "brand_name": "string", "uniqueness_score": number, "trademark_risk": "Low|Medium|High" }`),



  tech_profiler: (url) =>

    runPrompt(`Analyze tech stack of ${url}.

Return JSON:

{ "frontend": ["string"], "backend": ["string"], "sales_angle": "string" }`),



  seo_xray: (url) =>

    runPrompt(`Analyze SEO of ${url}.

Return JSON:

{ "seo_score": number, "improvements": [{ "area": "string", "suggestion": "string" }] }`),

};



// --- HANDLER ---

exports.handler = async (event) => {

  if (event.httpMethod === "OPTIONS") {

    return { statusCode: 200, body: "" };

  }



  const apiKey = event.headers["x-api-key"];



  if (!(await isValidApiKey(apiKey))) {

    return {

      statusCode: 403,

      body: JSON.stringify({ error: "Invalid API key" }),

    };

  }



  const id =

    apiKey ||

    event.headers["x-forwarded-for"] ||

    "anon";



  // Rate limit

  if (!(await checkRateLimit(id))) {

    return {

      statusCode: 429,

      body: JSON.stringify({ error: "Rate limit exceeded" }),

    };

  }



  // Usage limit

  const limitCheck = await checkUsageLimit(apiKey);



  if (!limitCheck.allowed) {

    return {

      statusCode: 402,

      body: JSON.stringify({

        error: "Free limit reached",

        plan: limitCheck.plan,

        limit: limitCheck.limit,

        message: "Upgrade your plan to continue",

      }),

    };

  }



  // Parse body

  let body;

  try {

    body = JSON.parse(event.body);

  } catch {

    return { statusCode: 400, body: "Invalid JSON" };

  }



  const { url, tool = "risk" } = body;



  if (!toolMap[tool]) {

    return { statusCode: 400, body: "Invalid tool" };

  }



  const cleanUrl = sanitizeInput(url);



  if (!isValidUrl(cleanUrl)) {

    return { statusCode: 400, body: "Invalid URL" };

  }



  if (

    cleanUrl.includes("localhost") ||

    cleanUrl.includes("127.0.0.1")

  ) {

    return { statusCode: 400, body: "Invalid target" };

  }



  const cacheKey = `cache:${tool}:${cleanUrl}`;



  const cached = await getCache(cacheKey);

  if (cached) {

    return {

      statusCode: 200,

      headers: {

        "Content-Type": "application/json",

        "Cache-Control": "public, max-age=600",

      },

      body: JSON.stringify(cached),

    };

  }



  try {

    const result = await toolMap[tool](cleanUrl);

    const finalResult = addLegalShield(result);



    await setCache(cacheKey, finalResult);

    await trackUsage(apiKey);



    return {

      statusCode: 200,

      headers: {

        "Content-Type": "application/json",

        "Cache-Control": "public, max-age=600",

        "X-Plan": limitCheck.plan,

        "X-Usage-Limit": limitCheck.limit,

        "X-Usage-Remaining": limitCheck.remaining - 1,

      },

      body: JSON.stringify(finalResult),

    };

  } catch (err) {

    console.error(err);



    return {

      statusCode: 500,

      body: JSON.stringify({ error: "Analysis failed" }),

    };

  }

};



  
