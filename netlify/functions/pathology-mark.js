const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL = "gemini-2.5-flash";

function reply(statusCode, data) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },
    body: JSON.stringify(data)
  };
}

async function supabaseRequest(path, options = {}) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    console.error(
      "Supabase request failed:",
      response.status,
      typeof data === "string"
        ? data
        : JSON.stringify(data)
    );

    throw new Error("Database request failed.");
  }

  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return reply(200, { ok: true });
  }

  if (event.httpMethod !== "POST") {
    return reply(405, {
      error: "Method not allowed."
    });
  }

  if (
    !SUPABASE_URL ||
    !SUPABASE_SECRET_KEY ||
    !GEMINI_API_KEY
  ) {
    console.error("Required server environment variable missing.");

    return reply(500, {
      error: "Server configuration is incomplete."
    });
  }

  try {
    const authorization =
      event.headers.authorization ||
      event.headers.Authorization ||
      "";

    const accessToken = authorization.replace(
      /^Bearer\s+/i,
      ""
    );

    if (!accessToken) {
      return reply(401, {
        error: "Please sign in again."
      });
    }

    // Verify the student's Supabase login.
    const publishableKey =
      SUPABASE_PUBLISHABLE_KEY ||
      SUPABASE_SECRET_KEY;

    const authResponse = await fetch(
      `${SUPABASE_URL}/auth/v1/user`,
      {
        headers: {
          apikey: publishableKey,
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    if (!authResponse.ok) {
      return reply(401, {
        error: "Your session is invalid. Please sign in again."
      });
    }

    const user = await authResponse.json();

    if (!user || !user.id) {
      return reply(401, {
        error: "Unable to verify your account."
      });
    }

    let body;

    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return reply(400, {
        error: "Invalid request body."
      });
    }

    const attemptId =
      body.attempt_id ||
      body.attemptId ||
      body.attempt?.id;

    if (!attemptId) {
      return reply(400, {
        error: "Missing quiz attempt ID."
      });
    }

    // Load the attempt and verify ownership.
    const attempts = await supabaseRequest(
      `attempts?id=eq.${encodeURIComponent(attemptId)}` +
      `&user_id=eq.${encodeURIComponent(user.id)}` +
      `&select=id,user_id,quiz_id,status,submitted_at`
    );

    const attempt = attempts?.[0];

    if (!attempt) {
      return reply(404, {
        error: "Quiz attempt not found."
      });
    }

    if (attempt.status !== "submitted") {
      return reply(400, {
        error: "Submit the quiz before marking."
      });
    }

    // Check the quiz subject.
    const quizzes = await supabaseRequest(
      `quizzes?id=eq.${encodeURIComponent(attempt.quiz_id)}` +
      `&select=id,subject`
    );

    const quiz = quizzes?.[0];

    if (
      !quiz ||
      !String(quiz.subject || "")
        .toLowerCase()
        .includes("pathology")
    ) {
      return reply(400, {
        error: "This marking function is for Pathology quizzes."
      });
    }

    // Fetch answers and their related questions.
    // The questions table does not need a marking_scheme column.
    const answers = await supabaseRequest(
      `student_answers?attempt_id=eq.${encodeURIComponent(attempt.id)}` +
      `&select=id,question_id,answer_text,questions(question_text,marks,correct_answer,explanation)`
    );

    if (!Array.isArray(answers) || answers.length === 0) {
      return reply(400, {
        error: "No saved answers were found for this attempt."
      });
    }

    // Only grade free-text answers.
    const markingInput = answers
      .map((answer, originalIndex) => ({
        answer,
        originalIndex
      }))
      .filter(({ answer }) => {
        return (
          typeof answer.answer_text === "string" &&
          answer.answer_text.trim().length > 0
        );
      });

    if (markingInput.length === 0) {
      return reply(400, {
        error: "No written answers were found to mark."
      });
    }

    const prompt = `
You are an experienced medical school Pathology examiner.

Mark the supplied student short-answer questions fairly.

Use the question, the maximum marks, any supplied reference
answer, and any supplied explanation.

Award partial credit for correct and relevant medical points.
Do not award marks for incorrect or unsupported claims.
Do not invent facts or assume the student wrote points that
are absent from their answer.
Do not exceed the maximum marks.
Use concise, specific educational feedback.

Return JSON only in this format:
{
  "results": [
    {
      "index": 0,
      "awarded_marks": 2,
      "feedback": "Specific explanation of the mark awarded."
    }
  ]
}

Return exactly one result for every supplied answer.
The index must match the index in the supplied input.
`;

    const inputForAI = markingInput.map(
      ({ answer }, index) => ({
        index,
        question: answer.questions?.question_text || "",
        maximum_marks: Number(answer.questions?.marks || 0),
        reference_answer: answer.questions?.correct_answer || null,
        reference_explanation: answer.questions?.explanation || null,
        student_answer: answer.answer_text
      })
    );

    // Request marking from Gemini.
    const aiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: prompt }]
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: JSON.stringify({
                    answers: inputForAI
                  })
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json"
          }
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
      console.error(
        "Gemini request failed:",
        aiResponse.status,
        JSON.stringify(aiData)
      );

      return reply(502, {
        error: "AI marking failed. Please contact the administrator."
      });
    }

    const generatedText =
      aiData.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join("") || "";

    let graded;

    try {
      graded = JSON.parse(generatedText);
    } catch {
      return reply(502, {
        error: "Could not read the AI marking result."
      });
    }

    if (
      !Array.isArray(graded.results) ||
      graded.results.length !== markingInput.length
    ) {
      return reply(502, {
        error: "The AI returned incomplete marking results."
      });
    }

    // Validate every result before saving any marks.
    const validatedResults = [];

    for (let index = 0; index < markingInput.length; index++) {
      const result = graded.results.find(
        item => Number(item.index) === index
      );

      const answer = markingInput[index].answer;

      const maximum = Math.max(
        0,
        Number(answer.questions?.marks || 0)
      );

      if (
        !result ||
        !Number.isFinite(Number(result.awarded_marks))
      ) {
        return reply(502, {
          error: "A marking result was invalid."
        });
      }

      const awarded = Math.min(
        maximum,
        Math.max(0, Number(result.awarded_marks))
      );

      validatedResults.push({
        answer,
        awarded,
        maximum,
        feedback: String(
          result.feedback || "Review the reference answer."
        )
      });
    }

    // Save marks and feedback to Supabase.
    let score = 0;
    let totalMarks = 0;
    const details = [];

    for (const result of validatedResults) {
      const { answer, awarded, maximum, feedback } = result;

      await supabaseRequest(
        `student_answers?id=eq.${encodeURIComponent(answer.id)}`,
        {
          method: "PATCH",
          headers: {
            Prefer: "return=minimal"
          },
          body: JSON.stringify({
            awarded_marks: awarded,
            feedback
          })
        }
      );

      score += awarded;
      totalMarks += maximum;

      details.push({
        question_id: answer.question_id,
        question: answer.questions?.question_text || "",
        awarded_marks: awarded,
        maximum_marks: maximum,
        feedback
      });
    }

    // Store the total score on the attempt.
    await supabaseRequest(
      `attempts?id=eq.${encodeURIComponent(attempt.id)}`,
      {
        method: "PATCH",
        headers: {
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          score,
          total_marks: totalMarks
        })
      }
    );

    return reply(200, {
      success: true,
      score,
      total_marks: totalMarks,
      results: details
    });
  } catch (error) {
    console.error("Pathology marking error:", error.message);

    return reply(500, {
      error: "Marking failed. Please check the function logs."
    });
  }
};
