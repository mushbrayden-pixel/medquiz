const PROJECT_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  "sb_publishable_S708xjhRgOGrkuW8Dt-RVg_QyuJWNa2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://med-quiz-44d140.netlify.app",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

function reply(statusCode, body) {
  return {
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(body)
  };
}

async function supabaseRequest(path, options = {}) {
  const base = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;

  const response = await fetch(`${base}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: secret,
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
      Prefer: options.prefer || "return=representation",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(`Supabase request failed: ${response.status}`);
  }

  return data;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return reply(405, { error: "Use POST to submit Pathology marking." });
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

  if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    return reply(500, {
      error: "Server environment variables are missing. Check Netlify settings."
    });
  }

  try {
    const authorization =
      event.headers.authorization ||
      event.headers.Authorization ||
      "";

    const accessToken = authorization.replace(/^Bearer\s+/i, "").trim();

    if (!accessToken) {
      return reply(401, { error: "Please sign in again." });
    }

    // Verify the student's Supabase session.
    const authResponse = await fetch(
      `${SUPABASE_URL}/auth/v1/user`,
      {
        headers: {
          apikey: PROJECT_PUBLISHABLE_KEY,
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    if (!authResponse.ok) {
      return reply(401, {
        error: "Your session could not be verified. Please sign in again."
      });
    }

    const user = await authResponse.json();

    let body;

    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return reply(400, { error: "Invalid request body." });
    }

    const attemptId = body.attempt_id;

    if (!attemptId || typeof attemptId !== "string") {
      return reply(400, { error: "Missing attempt ID." });
    }

    const attempts = await supabaseRequest(
      `attempts?id=eq.${encodeURIComponent(attemptId)}&select=id,user_id,quiz_id,status`
    );

    if (!Array.isArray(attempts) || attempts.length !== 1) {
      return reply(404, { error: "Attempt not found." });
    }

    const attempt = attempts[0];

    if (attempt.user_id !== user.id) {
      return reply(403, {
        error: "You can only mark your own attempt."
      });
    }

    if (String(attempt.status).toLowerCase() !== "submitted") {
      return reply(409, {
        error: "This attempt has not been submitted."
      });
    }

    const quizzes = await supabaseRequest(
      `quizzes?id=eq.${encodeURIComponent(attempt.quiz_id)}&select=id,subject`
    );

    if (
      !Array.isArray(quizzes) ||
      quizzes.length !== 1 ||
      !String(quizzes[0].subject || "")
        .toLowerCase()
        .includes("pathology")
    ) {
      return reply(400, {
        error: "This function only marks Pathology quizzes."
      });
    }

    const answers = await supabaseRequest(
      `student_answers?attempt_id=eq.${encodeURIComponent(attemptId)}&select=id,question_id,answer_text,questions(question_text,marks,marking_scheme)`
    );

    if (!Array.isArray(answers) || answers.length === 0) {
      return reply(400, {
        error: "No submitted answers were found."
      });
    }

    const markingInput = answers.map((answer, index) => ({
      index,
      answer_id: answer.id,
      question: answer.questions?.question_text || "",
      maximum_marks: Number(answer.questions?.marks || 0),
      marking_scheme: answer.questions?.marking_scheme || "",
      student_answer: answer.answer_text || ""
    }));

    const prompt = `
You are an experienced medical school Pathology examiner.

Mark each student's short-answer question against the supplied
question, maximum marks and marking scheme.

Award fair partial credit for correct relevant medical points.
Do not award marks for incorrect claims.
Never exceed the maximum marks or award negative marks.
Give concise, specific educational feedback.

Return JSON only in this format:
{
  "results": [
    {
      "index": 0,
      "awarded_marks": 2,
      "feedback": "Explanation of the mark awarded."
    }
  ]
}

Return exactly one result for every supplied answer.
`;

    const aiResponse = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          temperature: 0.1,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: prompt },
            {
              role: "user",
              content: JSON.stringify({ answers: markingInput })
            }
          ]
        })
      }
    );

    const aiText = await aiResponse.text();
    let aiData;

    try {
      aiData = JSON.parse(aiText);
    } catch {
      aiData = {};
    }

    if (!aiResponse.ok) {
      console.error("OpenAI request failed:", aiResponse.status);
      return reply(502, {
        error: "AI marking failed. Please try again."
      });
    }

    let graded;

    try {
      graded = JSON.parse(
        aiData.choices?.[0]?.message?.content || "{}"
      );
    } catch {
      return reply(502, {
        error: "Could not read the AI marking result."
      });
    }

    if (
      !Array.isArray(graded.results) ||
      graded.results.length !== answers.length
    ) {
      return reply(502, {
        error: "The AI returned incomplete marking results."
      });
    }

    let score = 0;
    let totalMarks = 0;
    const details = [];

    for (let index = 0; index < answers.length; index++) {
      const answer = answers[index];

      const result = graded.results.find(
        item => Number(item.index) === index
      );

      const maximum = Math.max(
        0,
        Number(answer.questions?.marks || 0)
      );

      if (
        !result ||
        !Number.isFinite(Number(result.awarded_marks))
      ) {
        return reply(502, {
          error: "A marking result was invalid. Please retry."
        });
      }

      const awarded = Math.min(
        maximum,
        Math.max(0, Number(result.awarded_marks))
      );

      const feedback = String(
        result.feedback || "Review the model answer."
      );

      score += awarded;
      totalMarks += maximum;

      await supabaseRequest(
        `student_answers?id=eq.${encodeURIComponent(answer.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            awarded_marks: awarded,
            feedback
          }),
          prefer: "return=minimal"
        }
      );

      details.push({
        question_id: answer.question_id,
        question: answer.questions?.question_text || "",
        awarded_marks: awarded,
        maximum_marks: maximum,
        feedback
      });
    }

    await supabaseRequest(
      `attempts?id=eq.${encodeURIComponent(attemptId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          score,
          total_marks: totalMarks
        }),
        prefer: "return=minimal"
      }
    );

    return reply(200, {
      success: true,
      attempt_id: attemptId,
      score,
      total_marks: totalMarks,
      details
    });

  } catch (error) {
    console.error("Pathology marking error:", error.message);

    return reply(500, {
      error: "Pathology marking failed. Check the Netlify function logs."
    });
  }
};
